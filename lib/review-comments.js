import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { remapReviewAnchor, makeReviewAnchor } from "./review-anchors.js";
import { reviewHash } from "./pdf-review.js";

export const commentStates = { pending: "待处理", resolved: "已处理", rejected: "不采纳", unlocated: "待定位" };
export const commentTypes = { task: "待办", question: "疑问", term: "术语", citation: "引用", polish: "润色" };
export const commentType = (type) => Object.hasOwn(commentTypes, type) ? type : "question";
export const commentText = (value, size = 10000) => String(value || "").trim().slice(0, size);

function belowRoot(root, target) {
  const relative = path.relative(root, target);
  return relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..");
}

async function logFile(projectRoot, create = false) {
  const root = await fs.realpath(projectRoot);
  const folder = path.join(root, ".paperbridge");
  if (create) await fs.mkdir(folder, { recursive: true });
  const real = await fs.realpath(folder).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!real) return null;
  if (!belowRoot(root, real)) throw new Error("批注目录必须位于当前项目内。");
  const file = path.join(real, "comments.jsonl");
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && !stat.isFile()) throw new Error("批注日志不是普通文件。");
  return file;
}

function replay(raw) {
  const threads = new Map();
  const imported = new Map();
  const aliases = new Map();
  let unreadable = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { unreadable += 1; continue; }
    if (!event || typeof event !== "object") continue;
    if (event.kind === "author") {
      aliases.set(event.from, event.to);
      continue;
    }
    if (event.kind === "create" && !threads.has(event.id)) {
      threads.set(event.id, { ...event, replies: [] });
      if (event.external) imported.set(event.external, event.id);
      continue;
    }
    const item = threads.get(event.id);
    if (!item) continue;
    if (event.kind === "status" && Object.hasOwn(commentStates, event.status)) item.status = event.status;
    if (event.kind === "locate") {
      item.anchor = event.anchor;
      item.confidence = "manual";
      if (item.status === "unlocated") item.status = "pending";
    }
    if (event.kind === "reply" && !item.replies.some((reply) => reply.replyId === event.replyId)) {
      item.replies.push(event);
      if (event.external) imported.set(event.external, event.id);
    }
  }
  return { threads, imported, aliases, unreadable };
}

export async function readCommentLog(projectRoot) {
  const file = await logFile(projectRoot);
  const raw = file ? await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  }) : "";
  return { ...replay(raw), hasPartialLine: Boolean(raw && !raw.endsWith("\n")) };
}

export async function appendCommentEvents(projectRoot, events, { hasPartialLine = false } = {}) {
  if (!events.length) return;
  const file = await logFile(projectRoot, true);
  const serialized = events.map((event) => JSON.stringify({ at: new Date().toISOString(), ...event })).join("\n");
  await fs.appendFile(file, (hasPartialLine ? "\n" : "") + serialized + "\n", "utf8");
}

export function legacyCommentEvents(state, log, corpus) {
  return Object.entries(state.sourceAnnotations || {}).flatMap(([file, annotations]) => {
    if (!Array.isArray(annotations)) return [];
    return annotations.flatMap((old) => {
      const external = "legacy:" + file + ":" + (old.id || reviewHash(JSON.stringify(old)));
      if (log.imported.has(external) || !old.text) return [];
      const source = corpus.files.get(file)?.text || "";
      const start = Math.max(0, Number(old.start) || 0);
      const end = Math.max(start, Number(old.end) || 0);
      const line = source.slice(0, start).split("\n").length;
      const quote = source.slice(start, end);
      const anchor = source && makeReviewAnchor(corpus, file, line, { start, end, quote });
      return [{
        kind: "create", id: randomUUID(), author: "我", source: "manual", type: "question",
        status: anchor ? "pending" : "unlocated", anchor: anchor || null, quote,
        confidence: anchor ? "manual" : "unlocated", text: commentText(old.text), round: "", external,
        at: old.createdAt || new Date().toISOString(), own: true
      }];
    });
  });
}

export function reviewThreads(log, corpus) {
  return [...log.threads.values()].map((item) => {
    const anchor = remapReviewAnchor(item.anchor, corpus);
    const active = item.status === "pending" || item.status === "unlocated";
    return {
      ...item, anchor, status: active && !anchor ? "unlocated" : item.status,
      confidence: anchor ? item.confidence : "unlocated",
      displayAuthor: (item.source === "pdf" && log.aliases.get(item.author)) || item.author || "未知作者",
      replies: item.replies.map((reply) => ({ ...reply, displayAuthor: (reply.source === "pdf" && log.aliases.get(reply.author)) || reply.author || "未知作者" }))
    };
  });
}

export function referenceWarningComments(state, corpus, log) {
  const results = [];
  const add = (text, file, line) => {
    const external = "warning:" + reviewHash(JSON.stringify([file, line, text]));
    if (log.imported.has(external) || results.some((item) => item.external === external)) return;
    results.push({ text, file, line, external, anchor: makeReviewAnchor(corpus, file, line) });
  };
  for (const [file, source] of corpus.files) {
    source.lines.forEach((line, index) => {
      if (/\\(?:ref|eqref|autoref|cref|cite\w*)\s*\{\s*\}/i.test(line.replace(/(^|[^\\])%.*$/, "$1"))) {
        add("引用命令中缺少引用名。", file, index + 1);
      }
    });
  }
  for (const warning of state.lastBuild?.warnings || []) {
    if (!/\b(?:Citation|Reference)\b.+\bundefined\b/i.test(warning)) continue;
    const label = /[\x60‘']([^'’]+)['’]/.exec(warning)?.[1];
    const line = Number(/\bline\s+(\d+)/i.exec(warning)?.[1] || 0);
    const matches = [];
    if (label) {
      for (const [file, source] of corpus.files) {
        source.lines.forEach((text, index) => {
          if (/\\(?:ref|eqref|autoref|cref|cite\w*)/.test(text) && text.includes(label)) matches.push({ file, line: index + 1 });
        });
      }
    }
    const exact = matches.filter((item) => item.line === line);
    const target = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
    add(warning, target?.file || "", target?.line || 0);
  }
  return results;
}

export function reviewReplyMarkdown(threads, rounds) {
  const quote = (value) => String(value || "").replace(/\r?\n/g, "\n> ");
  const output = ["# 审阅回复清单"];
  let index = 0;
  for (const item of threads) {
    const title = item.anchor?.section || item.anchor?.file || (item.pdf?.page ? "PDF 第 " + item.pdf.page + " 页" : "待定位");
    output.push("", "## " + (++index) + ". " + title, "",
      "- 作者　" + item.displayAuthor,
      "- 状态　" + commentStates[item.status],
      "- 轮次　" + (rounds.find((round) => round.id === item.round)?.label || (item.round ? "导入审阅" : "本地批注")),
      "- 修改位置　" + (item.anchor ? item.anchor.file + ":" + item.anchor.line : "待定位"), "",
      "> " + quote(item.text || (item.subtype === "Ink" ? "手写批注" : item.subtype || "批注")));
    if (item.quote) output.push("", "原文", "", "> " + quote(item.quote));
    for (const reply of item.replies) output.push("", reply.displayAuthor + " · " + String(reply.at).slice(0, 10), "", "> " + quote(reply.text));
  }
  return output.join("\n") + "\n";
}

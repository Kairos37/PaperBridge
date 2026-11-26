import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveProjectFile } from "./latex.js";
import { syncTeXInverse, syncTeXSnapshotInverse } from "./synctex.js";
import { REVIEW_ID, pdfTextSimilarity, readReviewPdf, reviewHash, stampReviewPdf } from "./pdf-review.js";
import { locateReviewAnnotation, makeReviewAnchor, readReviewSources, reviewCorpus } from "./review-anchors.js";
import {
  appendCommentEvents, commentStates, commentText, commentType, legacyCommentEvents, readCommentLog,
  referenceWarningComments, reviewReplyMarkdown, reviewThreads
} from "./review-comments.js";

const previewLifetime = 20 * 60 * 1000;
const digestPattern = /^[a-f0-9]{64}$/;
const fileVersion = (stat) => stat.mtime.toISOString() + ":" + stat.size;
const archivePath = (ctx, id) => path.join(ctx.storage, id);
const mainOutput = (ctx, suffix) => ctx.mainTex.replace(/\.tex$/i, suffix);

function reviewError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

async function optionalFile(file) {
  return fs.readFile(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function readRounds(ctx) {
  const entries = await fs.readdir(ctx.storage, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const rounds = await Promise.all(entries.filter((entry) => entry.isDirectory() && REVIEW_ID.test(entry.name)).map(async (entry) => {
    const value = await optionalFile(path.join(archivePath(ctx, entry.name), "metadata.json"));
    return value ? JSON.parse(value) : null;
  }));
  return rounds.filter(Boolean).sort((left, right) => left.exportedAt.localeCompare(right.exportedAt)).map((round, index) => ({
    ...round, label: "第 " + (index + 1) + " 轮 · " + round.date
  }));
}

async function projectPdfStat(ctx) {
  const file = await resolveProjectFile(ctx.projectRoot, mainOutput(ctx, ".pdf"));
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw reviewError("请先编译生成 PDF，再导出审阅版。");
  return { file, stat };
}

async function exportReview(ctx) {
  let output;
  try { output = await projectPdfStat(ctx); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw reviewError("请先编译生成 PDF，再导出审阅版。");
  }
  if (ctx.state.lastBuild?.success === false) throw reviewError("请先完成一次可用的编译，再导出审阅版。");
  const sources = await readReviewSources(ctx.projectRoot, ctx.mainTex);
  if (Object.values(sources).some((source) => source.mtime > output.stat.mtimeMs + 2)) {
    throw reviewError("源码已更新，请先点击“编译”，让审阅 PDF 与源码一致。");
  }
  const bytes = await fs.readFile(output.file);
  const inspected = await readReviewPdf(bytes, { annotations: false });
  const exportId = randomUUID();
  const stamped = await stampReviewPdf(bytes, exportId);
  let sync = null;
  let extension = "";
  for (const suffix of [".synctex.gz", ".synctex"]) {
    const mapFile = await resolveProjectFile(ctx.projectRoot, mainOutput(ctx, suffix)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!mapFile) continue;
    const stat = await fs.stat(mapFile);
    if (stat.size && Object.values(sources).every((source) => source.mtime <= stat.mtimeMs + 2)) {
      sync = await fs.readFile(mapFile);
      extension = suffix;
      break;
    }
  }
  const stable = await fs.stat(output.file);
  const unchanged = await readReviewSources(ctx.projectRoot, ctx.mainTex);
  if (fileVersion(stable) !== fileVersion(output.stat) || Object.keys(unchanged).length !== Object.keys(sources).length
    || Object.entries(sources).some(([file, source]) => unchanged[file]?.text !== source.text)) {
    throw reviewError("导出时稿件发生了变化，请编译后再试。");
  }
  const folder = archivePath(ctx, exportId);
  await fs.mkdir(folder, { recursive: true });
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const metadata = {
    id: exportId, date, exportedAt: now.toISOString(), pdfVersion: fileVersion(output.stat),
    pages: inspected.pages, hash: reviewHash(stamped), sync: extension
  };
  await Promise.all([
    fs.writeFile(path.join(folder, "sources.json"), JSON.stringify(sources)),
    fs.writeFile(path.join(folder, "review.pdf"), stamped),
    sync && fs.writeFile(path.join(folder, "review" + extension), sync)
  ]);
  await fs.writeFile(path.join(folder, "metadata.json"), JSON.stringify(metadata));
  return { id: exportId, stamped, filename: path.basename(ctx.mainTex, ".tex") + "-review-" + date + "-" + exportId.slice(0, 6) + ".pdf" };
}

function matchRound(pdf, rounds) {
  const tagged = rounds.find((round) => round.id === pdf.exportId);
  if (tagged) return { round: tagged, match: "id" };
  const candidates = rounds.slice(-12).reverse().map((round) => ({ round, score: pdfTextSimilarity(pdf.pages, round.pages) }))
    .filter((item) => item.score >= 0.88).sort((a, b) => b.score - a.score);
  const [best, next] = candidates;
  if (best && (!next || best.score - next.score >= 0.04 || JSON.stringify(best.round.pages) === JSON.stringify(next.round.pages))) {
    return { round: best.round, match: "text" };
  }
  return { round: null, match: "unmatched" };
}

function annotationIdentity(round, item) {
  const key = item.name
    ? [item.page, item.name]
    : [item.page, item.regions.map((box) => box.map((number) => Math.round(number * 10))), item.contents, item.modified];
  return "pdf:" + reviewHash(JSON.stringify([round, key]));
}

function annotationTime(value) {
  if (!value) return undefined;
  const parsed = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(value);
  const iso = parsed ? parsed[1] + "-" + (parsed[2] || "01") + "-" + (parsed[3] || "01") + "T"
    + (parsed[4] || "00") + ":" + (parsed[5] || "00") + ":" + (parsed[6] || "00")
    + (parsed[7] ? parsed[7].replaceAll("'", "").replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z") : value;
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

async function prepareImport(ctx, bytes, log) {
  const pdf = await readReviewPdf(bytes);
  const rounds = await readRounds(ctx);
  const { round, match } = matchRound(pdf, rounds);
  const attachment = reviewHash(bytes);
  const importedRound = round?.id || pdf.exportId || "unknown:" + reviewHash(pdf.pages.some(Boolean) ? JSON.stringify(pdf.pages) : attachment);
  const current = reviewCorpus(await readReviewSources(ctx.projectRoot, ctx.mainTex, await ctx.editableTexFiles()));
  const archived = round ? await optionalFile(path.join(archivePath(ctx, round.id), "sources.json")) : null;
  const sources = archived ? JSON.parse(archived) : null;
  const snapshot = sources ? reviewCorpus(sources) : null;
  const refs = new Map(pdf.annotations.map((item) => [item.ref, annotationIdentity(importedRound, item)]));
  const items = [];
  for (let i = 0; i < pdf.annotations.length; i += 4) {
    items.push(...await Promise.all(pdf.annotations.slice(i, i + 4).map(async (item) => {
      const external = refs.get(item.ref);
      const replyTo = refs.get(item.parent) || "";
      const duplicate = log.imported.has(external);
      const sync = !duplicate && !replyTo && sources && round.sync && item.point
        ? await syncTeXSnapshotInverse(ctx.projectRoot, path.join(archivePath(ctx, round.id), "review.pdf"), item.point, Object.keys(sources)).catch(() => null)
        : null;
      const located = duplicate || replyTo ? {} : locateReviewAnnotation(item, current, snapshot, sync);
      return {
        id: randomUUID(), external, replyTo, duplicate, ...located,
        author: item.author || "未知作者", text: item.contents, quote: item.quote, subtype: item.subtype,
        at: annotationTime(item.modified),
        pdf: { page: item.page, regions: item.regions, version: round?.pdfVersion || "", attachment }
      };
    })));
  }
  const authors = [...new Set(items.map((item) => item.author))];
  const newItems = items.filter((item) => !item.duplicate);
  return {
    items, bytes, attachment, roundId: importedRound, label: round?.label || "外部审阅 PDF", match,
    authors: authors.map((name) => ({ name, alias: log.aliases.get(name) || "" })),
    added: newItems.length, duplicates: items.length - newItems.length,
    unlocated: newItems.filter((item) => !item.replyTo && !item.anchor).length,
    possibleFlattened: !items.length && (!round || round.hash !== attachment)
  };
}

function importEvents(draft, log, aliasOverrides) {
  const events = [];
  for (const author of draft.authors) {
    const value = commentText(aliasOverrides?.[author.name], 100);
    if (value && value !== log.aliases.get(author.name)) events.push({ kind: "author", from: author.name, to: value });
  }
  const identities = new Map(log.imported);
  const remaining = draft.items.filter((item) => !identities.has(item.external));
  function appendItem(item, parentId) {
    if (identities.has(item.external)) return;
    const at = item.at ? { at: item.at } : {};
    if (parentId) {
      events.push({
        kind: "reply", id: parentId, replyId: item.id, author: item.author, text: item.text || item.quote || item.subtype,
        external: item.external, source: "pdf", pdf: item.pdf, ...at
      });
      identities.set(item.external, parentId);
      return;
    }
    events.push({
      kind: "create", id: item.id, source: "pdf", author: item.author, type: "question", text: item.text,
      subtype: item.subtype, round: draft.roundId, external: item.external, quote: item.quote,
      anchor: item.anchor || null, historical: item.historical || null, pdf: item.pdf,
      confidence: item.confidence || "unlocated", status: item.anchor ? "pending" : "unlocated", ...at
    });
    identities.set(item.external, item.id);
  }
  while (remaining.length) {
    const readyIndex = remaining.findIndex((item) => !item.replyTo || identities.has(item.replyTo));
    const item = remaining.splice(Math.max(0, readyIndex), 1)[0];
    appendItem(item, identities.get(item.replyTo));
  }
  return events;
}

async function writeEvents(ctx, log, events) {
  if (!events.length) return;
  await ctx.excludeLocalReviews?.();
  await appendCommentEvents(ctx.projectRoot, events, log);
}

async function listReviews(ctx, corpus, log) {
  const rounds = await readRounds(ctx);
  return {
    threads: reviewThreads(log, corpus),
    rounds: rounds.map(({ id, date, label }) => ({ id, date, label })),
    warnings: referenceWarningComments(ctx.state, corpus, log).map(({ text, file, line, external }) => ({ text, file, line, external })),
    unreadable: log.unreadable
  };
}

function pdfPosition(input) {
  const page = Number(input?.page);
  if (!Number.isInteger(page) || page <= 0) return null;
  const regions = Array.isArray(input.regions) ? input.regions.slice(0, 100).filter((box) =>
    Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3]
  ) : [];
  return { page, regions, point: input.point };
}

async function manualComment(ctx, payload, corpus) {
  const text = commentText(payload.text);
  if (!text) throw reviewError("请输入批注内容。", 400);
  const spec = payload.anchor || {};
  const quote = commentText(spec.quote, 1000);
  const position = pdfPosition(spec.pdf);
  let anchor = makeReviewAnchor(corpus, String(spec.file || ""), Number(spec.line), { ...spec, quote });
  let confidence = anchor ? "manual" : "unlocated";
  let pdf = null;
  if (position) {
    const synced = position.point ? await syncTeXInverse(ctx.projectRoot, ctx.mainTex, position.point).catch(() => null) : null;
    const located = locateReviewAnnotation({ quote }, corpus, null, synced);
    if (!anchor) ({ anchor, confidence } = located);
    const output = await projectPdfStat(ctx).catch(() => null);
    const version = output ? fileVersion(output.stat) : "";
    pdf = { page: position.page, regions: position.regions, version: spec.pdf.version === version ? version : "" };
  }
  return {
    kind: "create", id: randomUUID(), source: payload.source === "translation" ? "translation" : "manual",
    author: commentText(payload.author, 100) || "我", own: true, text, quote, anchor, pdf,
    type: commentType(payload.type), confidence, status: anchor ? "pending" : "unlocated", round: ""
  };
}

export function mountReviewRoutes(app, { route, rawPdf, context, write }) {
  const previews = new Map();
  async function withLibrary(callback, { legacy = false } = {}) {
    const ctx = await context();
    return write(ctx.projectRoot, async () => {
      const corpus = reviewCorpus(await readReviewSources(ctx.projectRoot, ctx.mainTex, await ctx.editableTexFiles()));
      let log = await readCommentLog(ctx.projectRoot);
      if (legacy) {
        const existing = legacyCommentEvents(ctx.state, log, corpus);
        if (existing.length) {
          await writeEvents(ctx, log, existing);
          log = await readCommentLog(ctx.projectRoot);
        }
      }
      return callback(ctx, corpus, log);
    });
  }

  app.get("/api/reviews", route(async (_req, res) => {
    res.json(await withLibrary(listReviews, { legacy: true }));
  }));

  app.post("/api/reviews/export-pdf", route(async (_req, res) => {
    const ctx = await context();
    const result = await write(ctx.projectRoot, () => exportReview(ctx));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-PaperBridge-Review", result.id);
    res.attachment(result.filename).type("application/pdf").send(result.stamped);
  }));

  app.post("/api/reviews/import-preview", rawPdf, route(async (req, res) => {
    const ctx = await context();
    const log = await readCommentLog(ctx.projectRoot);
    const draft = await prepareImport(ctx, req.body, log);
    const now = Date.now();
    for (const [id, item] of previews) if (item.expires < now) previews.delete(id);
    while (previews.size >= 5) previews.delete(previews.keys().next().value);
    const { bytes, attachment, roundId, ...summary } = draft;
    const token = draft.items.length ? randomUUID() : "";
    if (token) previews.set(token, { ...draft, storage: ctx.storage, expires: now + previewLifetime });
    res.json({ ...summary, token, total: draft.items.length });
  }));

  app.post("/api/reviews/import", route(async (req, res) => {
    const result = await withLibrary(async (ctx, corpus, log) => {
      const draft = previews.get(req.body?.token);
      if (!draft || draft.storage !== ctx.storage || draft.expires < Date.now()) throw reviewError("预览已过期，请重新导入 PDF。");
      const events = importEvents(draft, log, req.body.aliases);
      const added = events.filter((event) => event.kind === "create" || event.kind === "reply");
      if (added.length) {
        const folder = path.join(ctx.storage, "incoming");
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, draft.attachment + ".pdf"), draft.bytes, { flag: "wx" }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      await writeEvents(ctx, log, events);
      previews.delete(req.body.token);
      return { ...(await listReviews(ctx, corpus, await readCommentLog(ctx.projectRoot))), imported: added.length, selected: added[0]?.id };
    }, { legacy: true });
    res.json(result);
  }));

  app.get("/api/reviews/attachment/:digest", route(async (req, res) => {
    const ctx = await context();
    const digest = req.params.digest;
    if (!digestPattern.test(digest)) throw reviewError("找不到审阅 PDF。", 404);
    const file = path.join(ctx.storage, "incoming", digest + ".pdf");
    await fs.access(file).catch(() => { throw reviewError("找不到审阅 PDF。", 404); });
    res.setHeader("Cache-Control", "private, no-store");
    res.type("application/pdf").sendFile(file);
  }));

  app.post("/api/reviews/events", route(async (req, res) => {
    const result = await withLibrary(async (ctx, corpus, log) => {
      const payload = req.body || {};
      const author = commentText(payload.author, 100) || "我";
      const item = log.threads.get(payload.id);
      const events = [];
      if (payload.kind === "create") events.push(await manualComment(ctx, payload, corpus));
      else if (payload.kind === "warnings") {
        const requested = Array.isArray(payload.keys) ? new Set(payload.keys) : null;
        for (const warning of referenceWarningComments(ctx.state, corpus, log)) {
          if (requested && !requested.has(warning.external)) continue;
          events.push({
            kind: "create", id: randomUUID(), external: warning.external, author: "编译警告", source: "compile",
            type: "citation", status: warning.anchor ? "pending" : "unlocated", anchor: warning.anchor,
            confidence: warning.anchor ? "manual" : "unlocated", text: warning.text, quote: "", round: ""
          });
        }
      } else {
        if (!item) throw reviewError("这条批注已不存在。", 404);
        if (payload.kind === "status" && Object.hasOwn(commentStates, payload.status)) {
          events.push({ kind: "status", id: item.id, status: payload.status });
        } else if (payload.kind === "reply" && commentText(payload.text)) {
          events.push({ kind: "reply", id: item.id, replyId: randomUUID(), author, text: commentText(payload.text), source: "manual" });
        } else if (payload.kind === "locate") {
          const spec = payload.anchor || {};
          const anchor = makeReviewAnchor(corpus, String(spec.file || ""), Number(spec.line), { ...spec, quote: spec.quote || item.quote });
          if (!anchor) throw reviewError("请先在当前项目的源码或段落中选中位置。", 400);
          events.push({ kind: "locate", id: item.id, anchor });
        } else throw reviewError("无效的批注操作。", 400);
      }
      await writeEvents(ctx, log, events);
      return { ...(await listReviews(ctx, corpus, await readCommentLog(ctx.projectRoot))), selected: events[0]?.id };
    }, { legacy: true });
    res.json(result);
  }));

  app.get("/api/reviews/replies", route(async (_req, res) => {
    const { threads, rounds } = await withLibrary(listReviews, { legacy: true });
    res.attachment("review-replies.md").type("text/markdown; charset=utf-8").send(reviewReplyMarkdown(threads, rounds));
  }));
}

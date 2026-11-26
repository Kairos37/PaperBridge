import { discoverTexFiles, parseSegments, resolveProjectFile } from "./latex.js";
import fs from "node:fs/promises";
import { normalizeReviewText } from "./pdf-review.js";

export async function readReviewSources(projectRoot, mainTex, additionalFiles = []) {
  const files = [...new Set([...await discoverTexFiles(projectRoot, mainTex), ...additionalFiles])];
  return Object.fromEntries(await Promise.all(files.map(async (file) => {
    const absolute = await resolveProjectFile(projectRoot, file);
    const [text, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return [file, { text, mtime: stat.mtimeMs }];
  })));
}

export function reviewCorpus(sources) {
  const files = new Map();
  const rows = [];
  for (const [file, item] of Object.entries(sources || {})) {
    const text = String(item.text || "").replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    const segments = parseSegments(text, file).segments.map((segment) => ({
      file, line: segment.startLine, endLine: segment.endLine, segmentId: segment.id,
      paragraph: segment.index + 1, section: segment.headingPath?.at(-1)?.title || "",
      paragraphText: segment.english, normalized: normalizeReviewText(segment.english)
    }));
    files.set(file, { text, lines, offsets, segments });
    rows.push(...segments);
  }
  return { files, rows };
}

function similarity(needle, text) {
  if (!needle || !text) return 0;
  if (needle === text) return 1;
  if (needle.length >= 12 && (" " + text + " ").includes(" " + needle + " ")) return 1;
  if (needle.length >= 18 && text.replaceAll(" ", "").includes(needle.replaceAll(" ", ""))) return 0.96;
  const words = needle.split(" ");
  if (words.length < 4) return 0;
  const padded = " " + text + " ";
  let ordered = 0;
  let present = 0;
  for (const [i, word] of words.entries()) {
    if (padded.includes(" " + word + " ")) present += 1;
    if (i > 0 && padded.includes(" " + words[i - 1] + " " + word + " ")) ordered += 1;
  }
  return 0.47 * present / words.length + 0.53 * ordered / (words.length - 1);
}

function findParagraph(corpus, value, file = "") {
  const needle = normalizeReviewText(value);
  if (needle.length < 12) return null;
  const candidates = corpus.rows.map((row) => {
    const score = similarity(needle, row.normalized);
    return { row, score: score + (score > 0 && row.file === file ? 0.05 : 0) };
  }).filter((item) => item.score >= 0.74).sort((a, b) => b.score - a.score);
  const [first, second] = candidates;
  return first && (!second || first.score - second.score >= 0.075) ? first.row : null;
}

function rowAt(corpus, file, line) {
  return corpus.files.get(file)?.segments.find((row) => line >= row.line && line <= row.endLine) || null;
}

export function makeReviewAnchor(corpus, file, line, details = {}) {
  const source = corpus.files.get(file);
  if (!source || !Number.isInteger(line) || line < 1 || line > source.lines.length) return null;
  const row = rowAt(corpus, file, line);
  const snippet = String(details.quote || "").trim().slice(0, 1000);
  const startOfLine = source.offsets[line - 1];
  const endOfLine = startOfLine + source.lines[line - 1].length;
  const rowStart = source.offsets[(row?.line || line) - 1];
  const rowEnd = source.offsets[row?.endLine || line] ?? source.text.length;
  const inRow = snippet ? source.text.slice(rowStart, rowEnd).toLowerCase().indexOf(snippet.replace(/\r?\n/g, " ").toLowerCase()) : -1;
  const exactRange = Number.isInteger(details.start) && Number.isInteger(details.end) && details.start >= 0
    && details.start < details.end && details.end <= source.text.length
    && source.text.slice(details.start, details.end).trim() === snippet;
  const start = exactRange ? details.start : inRow >= 0 ? rowStart + inRow : startOfLine;
  const end = exactRange ? details.end : inRow >= 0 ? start + snippet.length : endOfLine;
  return {
    file, line, start, end, segmentId: row?.segmentId || "", paragraph: row?.paragraph || null, section: row?.section || "",
    quote: snippet, paragraphText: (row?.paragraphText || source.lines[line - 1]).slice(0, 4000),
    before: source.text.slice(Math.max(0, start - 150), start), after: source.text.slice(end, end + 150)
  };
}

function sameParagraph(a, b) {
  return a.file === b.file && a.line === b.line;
}

export function remapReviewAnchor(anchor, corpus) {
  if (!anchor?.file || !anchor.line) return null;
  const atLine = makeReviewAnchor(corpus, anchor.file, anchor.line, anchor);
  const source = corpus.files.get(anchor.file);
  if (atLine && (normalizeReviewText(anchor.paragraphText) === normalizeReviewText(atLine.paragraphText)
      || (anchor.start === atLine.start && anchor.end === atLine.end && source?.text.slice(anchor.start, anchor.end) === anchor.quote))) {
    return { ...atLine, quote: anchor.quote || atLine.quote };
  }
  const moved = findParagraph(corpus, anchor.paragraphText, anchor.file) || findParagraph(corpus, anchor.quote, anchor.file);
  return moved ? makeReviewAnchor(corpus, moved.file, moved.line, anchor) : null;
}

export function locateReviewAnnotation(annotation, current, snapshot, sync) {
  const corpus = snapshot || current;
  const byQuote = findParagraph(corpus, annotation.quote);
  const bySync = sync && makeReviewAnchor(corpus, sync.file, sync.line, { quote: annotation.quote });
  const syncRow = bySync && rowAt(corpus, bySync.file, bySync.line);
  let historical;
  let confidence = "unlocated";
  if (bySync && syncRow && (byQuote ? sameParagraph(byQuote, syncRow) : similarity(normalizeReviewText(annotation.quote), syncRow.normalized) >= 0.88)) {
    historical = bySync;
    confidence = "high";
  } else if (!bySync || !byQuote) {
    historical = byQuote ? makeReviewAnchor(corpus, byQuote.file, byQuote.line, annotation) : bySync;
    if (historical) confidence = "medium";
  }
  const live = historical && (snapshot ? remapReviewAnchor(historical, current) : historical);
  if (live) return { anchor: live, confidence, historical: snapshot ? historical : null };
  const fallback = findParagraph(current, annotation.quote);
  return fallback
    ? { anchor: makeReviewAnchor(current, fallback.file, fallback.line, annotation), confidence: "medium", historical: historical || null }
    : { anchor: null, confidence: "unlocated", historical: historical || null };
}

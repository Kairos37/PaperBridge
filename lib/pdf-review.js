import { createHash } from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const REVIEW_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const markup = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
const reviewTypes = new Set([...markup, "Text", "FreeText", "Ink"]);
const pdfName = PDFName.of;
const reviewField = pdfName("PaperBridgeReviewId");

export const reviewHash = (value) => createHash("sha256").update(value).digest("hex");

export function normalizeReviewText(value) {
  return String(value || "").normalize("NFKC").replace(/\u00ad/g, "")
    .replace(/-\s*(?:\r?\n)\s*(?=\p{L})/gu, "")
    .replace(/\\(?:\(|\[)[\s\S]*?\\(?:\)|\])/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, " ")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|label)\*?(?:\s*\[[^\]]*\])*\s*\{[^{}]*\}/gi, " ")
    .replace(/\\(?:begin|end)\s*\{[^}]+\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, " ")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function strings(dict, field) {
  try { return dict?.lookup(pdfName(field))?.decodeText?.() || ""; }
  catch { return ""; }
}

function numbers(dict, field) {
  const value = dict.lookupMaybe(pdfName(field), PDFArray);
  return value?.asArray().map((item) => dict.context.lookupMaybe(item, PDFNumber)?.asNumber()) || [];
}

function bounds(points) {
  if (points.length < 4 || points.length % 2 || !points.every(Number.isFinite)) return null;
  const x = points.filter((_, index) => index % 2 === 0);
  const y = points.filter((_, index) => index % 2 === 1);
  const left = Math.min(...x);
  const bottom = Math.min(...y);
  const right = Math.max(...x);
  const top = Math.max(...y);
  return right > left && top > bottom ? [left, bottom, right, top] : null;
}

function regionsOf(dict, subtype) {
  let rect = bounds(numbers(dict, "Rect"));
  if (!rect && subtype === "Ink") {
    const strokes = dict.lookupMaybe(pdfName("InkList"), PDFArray);
    const points = strokes?.asArray().flatMap((stroke) =>
      (dict.context.lookupMaybe(stroke, PDFArray)?.asArray() || []).map((value) => dict.context.lookupMaybe(value, PDFNumber)?.asNumber())
    );
    if (points?.length) rect = bounds(points);
  }
  if (!markup.has(subtype)) return rect ? [rect] : [];
  const quads = numbers(dict, "QuadPoints");
  const regions = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const region = bounds(quads.slice(i, i + 8));
    if (region) regions.push(region);
  }
  return regions.length ? regions : rect ? [rect] : [];
}

function selectedFragment(item, rectangles) {
  const [a, b, , , x, y] = item.transform;
  const length = Math.hypot(a, b) || 1;
  const dx = a / length;
  const dy = b / length;
  const width = Math.abs(item.width || 0);
  const height = Math.abs(item.height || length);
  if (!width || !item.str.trim()) return "";
  // A PDF text run may span a whole line. Test the derived character centers
  // against every quadrilateral, then return complete words at the edges.
  const words = [...item.str.matchAll(/\S+/gu)];
  return words.filter((word) => {
    const start = word.index;
    const end = start + word[0].length;
    const step = Math.max(1, Math.floor((end - start) / 20));
    for (let offset = start; offset < end; offset += step) {
      const along = (offset + 0.5) * width / item.str.length;
      const cx = x + dx * along - dy * height * 0.32;
      const cy = y + dy * along + dx * height * 0.32;
      if (rectangles.some(([x1, y1, x2, y2]) => cx >= x1 - 0.5 && cx <= x2 + 0.5 && cy >= y1 - 0.8 && cy <= y2 + 0.8)) return true;
    }
    return false;
  }).map((word) => word[0]).join(" ");
}

export function extractReviewQuote(items, rectangles, view) {
  const selected = items.map((item, index) => ({ item, index, text: selectedFragment(item, rectangles) })).filter((item) => item.text);
  const middle = (view[0] + view[2]) / 2;
  // Text from a TeX page normally arrives in reading order. Explicitly group
  // the two columns when each marked region lies wholly on one side of the gutter.
  const separated = rectangles.length > 1 && rectangles.every((rect) => rect[2] < middle + 4 || rect[0] > middle - 4)
    && rectangles.some((rect) => rect[2] < middle - 4) && rectangles.some((rect) => rect[0] > middle + 4);
  if (separated) selected.sort((left, right) =>
    Number(left.item.transform[4] >= middle) - Number(right.item.transform[4] >= middle) || left.index - right.index
  );
  let quote = "";
  for (const [index, entry] of selected.entries()) {
    const sameLine = index > 0 && Math.abs(selected[index - 1].item.transform[5] - entry.item.transform[5]) < 2;
    quote += (index === 0 ? "" : sameLine ? " " : "\n") + entry.text;
  }
  return quote.slice(0, 1000).trim();
}

function annotationData(pdfPage, pageNumber, items, view) {
  const annotations = pdfPage.node.Annots()?.asArray() || [];
  return annotations.flatMap((reference, position) => {
    try {
      const dict = pdfPage.doc.context.lookupMaybe(reference, PDFDict);
      if (!dict) return [];
      const subtype = dict.lookupMaybe(pdfName("Subtype"), PDFName)?.decodeText();
      if (!reviewTypes.has(subtype)) return [];
      const regions = regionsOf(dict, subtype);
      const contents = strings(dict, "Contents").trim().slice(0, 10000);
      if (!regions.length && !contents) return [];
      return [{
        ref: reference instanceof PDFDict ? "direct:" + pageNumber + ":" + position : String(reference),
        parent: dict.get(pdfName("IRT"))?.toString() || "",
        name: strings(dict, "NM").slice(0, 500),
        subtype, page: pageNumber, regions,
        author: strings(dict, "T").trim().slice(0, 100),
        modified: strings(dict, "M") || strings(dict, "CreationDate"),
        contents,
        quote: markup.has(subtype) ? extractReviewQuote(items, regions, view) : "",
        point: regions.length ? {
          page: pageNumber,
          x: Math.max(0, (regions[0][0] + regions[0][2]) / 2 - view[0]),
          y: Math.max(0, view[3] - (regions[0][1] + regions[0][3]) / 2)
        } : null
      }];
    } catch {
      // An individual malformed annotation must not hide the other review notes.
      return [];
    }
  });
}

function loadedReviewId(document) {
  const info = document.context.lookupMaybe(document.context.trailerInfo.Info, PDFDict);
  const id = strings(info, "PaperBridgeReviewId") || /\bPaperBridgeReview[:=]([a-f0-9-]+)/i.exec(strings(info, "Keywords"))?.[1];
  return REVIEW_ID.test(id || "") ? id.toLowerCase() : "";
}

export async function readReviewPdf(bytes, { annotations = true } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 1024).includes("%PDF-")) throw new Error("请选择有效的 PDF 文件。");
  const raw = annotations ? await PDFDocument.load(bytes, { updateMetadata: false }) : null;
  const loading = getDocument({ data: Uint8Array.from(bytes), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
  const pages = [];
  const comments = [];
  try {
    const document = await loading.promise;
    const rawPages = raw?.getPages();
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      const runs = items.filter((item) => "str" in item);
      pages.push(normalizeReviewText(runs.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("")).slice(0, 18000));
      if (rawPages?.[number - 1]) comments.push(...annotationData(rawPages[number - 1], number, runs, page.view));
      page.cleanup();
    }
    return { exportId: raw ? loadedReviewId(raw) : "", pages, annotations: comments };
  } finally {
    await loading.destroy();
  }
}

export async function stampReviewPdf(bytes, exportId) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const keywords = (document.getKeywords() || "").replace(/\s*PaperBridgeReview:[a-f0-9-]+/gi, "").trim();
  document.setKeywords([keywords, "PaperBridgeReview:" + exportId].filter(Boolean));
  document.context.lookup(document.context.trailerInfo.Info, PDFDict).set(reviewField, PDFString.of(exportId));
  return Buffer.from(await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

function pageSimilarity(left, right) {
  if (left === right) return 1;
  const pairs = (value) => {
    const words = value.split(" ");
    return new Set(words.slice(1).map((word, index) => words[index] + " " + word));
  };
  const other = pairs(right);
  const first = pairs(left);
  if (!other.size || !first.size) return 0;
  const common = [...first].filter((pair) => other.has(pair)).length;
  return 2 * common / (first.size + other.size);
}

export function pdfTextSimilarity(left, right) {
  if (!left.length || left.length !== right.length) return 0;
  let compared = 0;
  let matched = 0;
  for (let i = 0; i < left.length; i += 1) {
    const size = Math.max(left[i].length, right[i].length);
    compared += size;
    matched += size * pageSimilarity(left[i], right[i]);
  }
  return compared >= 40 ? matched / compared : 0;
}

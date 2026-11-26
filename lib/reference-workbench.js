import path from "node:path";
import { hashText, parseSegments } from "./latex.js";
import {
  bibliographyFieldIssues, bibliographyFormatChanges, findCitationCommands, isPreprint,
  normalizedReferenceTitle, parseBibliography, referenceAuthorNames, referenceDoi,
  referenceIdentityMatches, referenceVenueDisplay, referenceYear, texReferenceText
} from "../public/reference-data.js";

export function referenceRecordId(file, key) {
  return JSON.stringify([file, key]);
}

function maskReferenceSource(source) {
  const blank = (value) => value.replace(/[^\r\n]/g, " ");
  return source
    .replace(/\\verb\*?([^A-Za-z\s])([^\r\n]*?)\1/g, blank)
    .replace(/(?:\\.|%[^\r\n]*)/g, (value) => value.startsWith("%") ? blank(value) : value)
    .replace(/\\begin\s*\{(verbatim\*?|lstlisting|minted|comment|thebibliography)\}[\s\S]*?\\end\s*\{\1\}/g, blank);
}

function includeCandidates(file, mainFile, target) {
  const normalized = target.replaceAll("\\", "/");
  const name = normalized + (/\.tex$/i.test(normalized) ? "" : ".tex");
  return [name, path.posix.join(path.posix.dirname(file), name), path.posix.join(path.posix.dirname(mainFile), name)].map((entry) => path.posix.normalize(entry));
}

function linePosition(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

export function collectReferenceCitations(sources, mainFile) {
  const seen = new Set();
  const citations = [];
  const visit = (file) => {
    if (seen.has(file) || !sources.has(file)) return;
    seen.add(file);
    const source = sources.get(file);
    const visible = maskReferenceSource(source);
    const starts = [0, ...[...visible.matchAll(/\n/g)].map((entry) => entry.index + 1)];
    const includes = [...visible.matchAll(/\\(?:input|include|subfile)\s*\{([^{}]+)\}/g)];
    const matches = findCitationCommands(visible);
    const segments = matches.length ? parseSegments(source, file).segments : [];
    let segmentIndex = 0;
    const events = [
      ...includes.map((match) => ({ match, include: true })),
      ...matches.map((match) => ({ match, include: false }))
    ].sort((left, right) => left.match.index - right.match.index);
    for (const { match, include } of events) {
      if (include) {
        const included = includeCandidates(file, mainFile, match[1].trim()).find((candidate) => sources.has(candidate));
        if (included) visit(included);
        continue;
      }
      const nocite = /^\\nocite\b/i.test(match[0]);
      const { line } = linePosition(starts, match.index);
      while (segments[segmentIndex]?.endLine < line) segmentIndex++;
      const paragraph = segments[segmentIndex]?.startLine <= line ? segments[segmentIndex].index + 1 : null;
      const contextStart = Math.max(starts[line - 1], match.index - 112);
      const contextEnd = Math.min(visible.length, match.index + match[0].length + 98, starts[line] ?? visible.length);
      const before = visible.slice(contextStart, match.index).split(/(?<=[.!?。！？])\s+/).at(-1);
      const after = visible.slice(match.index + match[0].length, Math.max(contextEnd, match.index + match[0].length)).split(/(?<=[.!?。！？])\s+/)[0];
      const context = texReferenceText(before + "[" + match[1].trim().replace(/\s+/g, " ") + "]" + after).slice(0, 260);
      for (const token of match[1].matchAll(/[^\s,]+/g)) {
        if (token[0] === "*") continue;
        const position = linePosition(starts, match.indices[1][0] + token.index);
        citations.push({ key: token[0], file, ...position, paragraph, context, nocite });
      }
    }
  };
  visit(mainFile);
  for (const file of sources.keys()) visit(file);
  return citations;
}

export function updateCitationKeys(source, replacements) {
  const visible = maskReferenceSource(source);
  let result = source;
  for (const match of findCitationCommands(visible).reverse()) {
    const [start, end] = match.indices[1];
    const raw = source.slice(start, end);
    if (![...match[1].matchAll(/[^\s,]+/g)].some((token) => replacements.has(token[0]))) continue;
    if (!raw.includes("%")) {
      const keys = match[1].split(",").map((key) => key.trim()).filter(Boolean);
      const updated = keys.map((key) => replacements.get(key) || key);
      if (new Set(updated).size < updated.length) {
        result = result.slice(0, start) + /^\s*/.exec(raw)[0] + [...new Set(updated)].join(", ") + /\s*$/.exec(raw)[0] + result.slice(end);
        continue;
      }
    }
    for (const token of [...match[1].matchAll(/[^\s,]+/g)].reverse()) {
      if (!replacements.has(token[0])) continue;
      const offset = start + token.index;
      result = result.slice(0, offset) + replacements.get(token[0]) + result.slice(offset + token[0].length);
    }
  }
  return result;
}

function parsePrintedReferences(bbl, aux) {
  const printed = new Map();
  const labels = new Map([...String(aux || "").matchAll(/\\bibcite\s*\{([^{}]+)\}\s*\{\{?([^{}]+)\}/g)].map((match) => [match[1], texReferenceText(match[2])]));
  const blocks = [...String(bbl || "").matchAll(/\\bibitem\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/g)];
  for (const [index, match] of blocks.entries()) {
    const next = blocks[index + 1]?.index || bbl.length;
    const raw = bbl.slice(match.index + match[0].length, next).split(/\\end\s*\{thebibliography\}/)[0];
    const text = texReferenceText(raw
      .replace(/\\(?:bibfield|bibinfo|bibAnnoteFile)\s*\{[^{}]+\}/g, "")
      .replace(/\\href\s*\{[^{}]*\}/g, "")
      .replace(/\\(?:newblock|hskip|penalty|unskip|protect|leavevmode|addperiod|bibfont|nopunct)\b(?:\s*[\d.]+(?:em|pt)?)?/g, " ")
      .replace(/\\(?:em|it|rm|bf|url|showarticletitle|showISBNx|showDOI|showURL)\b\s*/g, "")
      .replace(/\\doi\s*\{/g, "doi: {")
      .replace(/\\(?:eprint|path)\b\s*/g, "")
      .replace(/(?:\\.|%[^\r\n]*)/g, (token) => token.startsWith("%") ? "" : token)
      .replace(/\x60\x60|''/g, '"')).replace(/\s+([,.?!:;])/g, "$1");
    if (text) printed.set(match[2], { text, label: labels.get(match[2]) || texReferenceText(match[1]) || String(index + 1) });
  }
  return printed;
}

export function buildReferenceWorkbench({ mainFile, bibSources, texSources, records = {}, bbl = "", aux = "", fieldLabels }) {
  const source = maskReferenceSource(texSources.get(mainFile) || "");
  const style = /\\bibliographystyle\s*\{([^{}]+)\}/.exec(source)?.[1]
    || /\\usepackage\s*\[[^\]]*\b(?:bibstyle|style)\s*=\s*([^,\]\s]+)[^\]]*\]\s*\{biblatex\}/.exec(source)?.[1]
    || (/\\documentclass(?:\[[^\]]*\])?\s*\{acmart\}/.test(source) ? "ACM-Reference-Format" : "");
  const authorYear = /\\citestyle\s*\{acmauthoryear\}|\\setcitestyle\s*\{[^{}]*authoryear|\bauthoryear\b/i.test(source + " " + style);
  const printed = parsePrintedReferences(bbl, aux);
  const occurrences = new Map();
  const entries = bibSources.flatMap(({ file, content }) => parseBibliography(content).map((entry) => {
    const fields = Object.fromEntries(Object.entries(entry.fields).map(([name, value]) => [name, texReferenceText(value)]));
    const recordId = referenceRecordId(file, entry.key);
    const occurrence = occurrences.get(recordId) || 0;
    occurrences.set(recordId, occurrence + 1);
    const id = JSON.stringify([file, entry.key, occurrence]);
    const notes = records[recordId] || {};
    let venue = fields.booktitle || fields.journal || fields.publisher || fields.school || fields.institution || "";
    if (!venue && fields.url) {
      try { venue = new URL(fields.url).hostname; } catch { /* An incomplete URL is still shown in the field list. */ }
    }
    const startLine = content.slice(0, entry.start).split("\n").length;
    return {
      id, file, type: entry.type, key: entry.key, startLine, endLine: startLine + entry.raw.split("\n").length - 1,
      fields, raw: entry.raw, rawHash: hashText(entry.raw),
      title: fields.title || "", author: fields.author || fields.editor || "",
      authors: referenceAuthorNames(entry.fields.author || entry.fields.editor),
      year: referenceYear(fields.year || fields.date), venue, notes,
      addedAt: notes.addedAt || fields.addedat || null,
      printed: printed.get(entry.key) || null,
      warnings: bibliographyFieldIssues(entry), formatIssues: bibliographyFormatChanges(entry).map((change) => change.label),
      duplicateIds: [], publishedIds: [],
      publishedDoi: notes.publishedDoi || (isPreprint(entry) && !/^10\.48550\/arxiv/i.test(referenceDoi(fields.doi)) ? referenceDoi(fields.doi) : "")
    };
  }));
  const byTitle = new Map();
  const byDoi = new Map();
  const byKey = new Map();
  const addBucket = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  for (const entry of entries) {
    addBucket(byTitle, normalizedReferenceTitle(entry.title), entry);
    addBucket(byDoi, referenceDoi(entry.fields.doi), entry);
    addBucket(byKey, entry.key, entry);
  }
  const duplicateGroups = [];
  const duplicateSignatures = new Set();
  function markDuplicate(group) {
    if (group.length < 2) return;
    const ids = group.map((entry) => entry.id);
    const signature = JSON.stringify(ids.slice().sort());
    if (duplicateSignatures.has(signature)) return;
    duplicateSignatures.add(signature);
    duplicateGroups.push({ ids, keys: group.map((entry) => entry.key) });
    for (const entry of group) {
      entry.duplicateIds = [...new Set([...entry.duplicateIds, ...ids.filter((id) => id !== entry.id)])];
    }
  }
  for (const group of byKey.values()) markDuplicate(group);
  for (const group of byDoi.values()) {
    markDuplicate(group.filter(isPreprint));
    markDuplicate(group.filter((entry) => !isPreprint(entry)));
  }
  for (const group of byTitle.values()) {
    for (const entry of group) {
      markDuplicate(group.filter((item) => isPreprint(entry) === isPreprint(item) && referenceIdentityMatches(entry, item)));
      if (isPreprint(entry)) {
        entry.publishedIds = group.filter((item) => !isPreprint(item) && (item.fields.journal || item.fields.booktitle) && referenceIdentityMatches(entry, item)).map((item) => item.id);
      }
    }
  }
  for (const entry of entries) {
    if (!entry.publishedDoi) continue;
    const published = (byDoi.get(entry.publishedDoi) || []).filter((item) => !isPreprint(item));
    entry.publishedIds = [...new Set([...entry.publishedIds, ...published.map((item) => item.id)])];
  }

  const citations = collectReferenceCitations(texSources, mainFile);
  const byCitation = new Map();
  let order = 0;
  for (const citation of citations) {
    addBucket(byCitation, citation.key, { ...citation, order: citation.nocite ? 0 : ++order });
  }
  const ordered = entries.map((entry, index) => {
    const locations = byCitation.get(entry.key) || [];
    const firstCitation = locations.find((citation) => !citation.nocite) || null;
    return { ...entry, locations, cited: Boolean(firstCitation), firstCitation, citationOrder: firstCitation?.order || 0, bibOrder: index + 1 };
  }).sort((left, right) => (left.citationOrder || Infinity) - (right.citationOrder || Infinity) || left.bibOrder - right.bibOrder);
  ordered.forEach((entry, index) => {
    entry.number = index + 1;
    if (entry.venue) entry.shortVenue = referenceVenueDisplay(entry.venue, entry.year).label;
  });
  const missing = [];
  for (const [key, locations] of byCitation) {
    if (byKey.has(key)) continue;
    const candidates = entries.filter((entry) => entry.key.toLowerCase() === key.toLowerCase());
    missing.push({ ...locations[0], locations, candidateKey: candidates.length === 1 ? candidates[0].key : "" });
  }
  return {
    bibliographyFiles: bibSources.map((item) => item.file),
    style, authorYear, entries: ordered, citations, missing, fieldLabels,
    unused: ordered.filter((entry) => !entry.cited).map((entry) => entry.key),
    duplicates: duplicateGroups.map((group) => group.keys), duplicateGroups
  };
}


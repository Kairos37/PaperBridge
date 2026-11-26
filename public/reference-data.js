export const CITE_COMMAND_NAME = "(?:cite(?:p|t|alp|alt|author|year|yearpar|num|text|al)?|(?:paren|text|auto|smart|foot|super|full|online|no)cite)";
export const CITE_OPEN_PATTERN = "\\\\" + CITE_COMMAND_NAME + "\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{";
export const BIB_KEY_PATTERN = /^[A-Za-z0-9_:.+/-]+$/;

const TYPE_LABELS = {
  article: "期刊论文", inproceedings: "会议论文", conference: "会议论文",
  proceedings: "会议论文集", book: "专著", inbook: "书籍章节", incollection: "书籍章节",
  phdthesis: "博士论文", mastersthesis: "硕士论文", techreport: "技术报告",
  unpublished: "未发表", online: "网页", misc: "其他"
};

const VENUES = [
  ["SIGCOMM", "ACM SIGCOMM", /\bSIGCOMM\b|special interest group on data communication/i],
  ["INFOCOM", "IEEE INFOCOM", /\bINFOCOM\b|IEEE\s+(?:international\s+)?conference on computer communications/i],
  ["MobiSys", "ACM MobiSys", /\bMobiSys\b|mobile systems,\s*applications,\s*and services/i],
  ["MobiCom", "ACM MobiCom", /\bMobiCom\b|mobile computing and networking/i],
  ["CoNEXT", "ACM CoNEXT", /\bCoNEXT\b|emerging networking experiments and technologies/i],
  ["SenSys", "ACM SenSys", /\bSenSys\b|embedded networked sensor systems/i],
  ["IMC", "ACM Internet Measurement Conference", /\bIMC\b|internet measurement conference/i],
  ["NSDI", "USENIX NSDI", /\bNSDI\b|networked systems design and implementation/i],
  ["OSDI", "USENIX OSDI", /\bOSDI\b|operating systems design and implementation/i],
  ["EuroSys", "ACM EuroSys", /\bEuroSys\b/i],
  ["MobiHoc", "ACM MobiHoc", /\bMobiHoc\b/i],
  ["IPSN", "ACM/IEEE IPSN", /\bIPSN\b|information processing in sensor networks/i],
  ["ISCA", "ACM/IEEE ISCA", /\bISCA\b|international symposium on computer architecture/i],
  ["ASPLOS", "ACM ASPLOS", /\bASPLOS\b|architectural support for programming languages and operating systems/i],
  ["CHI", "ACM CHI", /\bCHI\b|human factors in computing systems/i],
  ["SIGIR", "ACM SIGIR", /\bSIGIR\b|research and development in information retrieval/i],
  ["IEEE S&P", "IEEE Symposium on Security and Privacy", /IEEE\s*(?:symposium on )?(?:security and privacy|S&P)/i]
];

const MONTHS = Object.fromEntries(
  "January February March April May June July August September October November December"
    .split(" ").map((month) => [month.slice(0, 3).toLowerCase(), month])
);

export function texReferenceText(value) {
  const accents = { "'": "\u0301", '"': "\u0308", "^": "\u0302", "~": "\u0303", "\x60": "\u0300", c: "\u0327", v: "\u030c" };
  return String(value ?? "")
    .replace(/\\(['"^~\x60cv])\s*\{?([a-zA-Z])\}?/g, (_, mark, letter) => (letter + accents[mark]).normalize("NFC"))
    .replace(/\\([&_%#$])/g, "$1")
    .replace(/\\(?:,|;|:|!|enspace\b|quad\b|qquad\b)/g, " ")
    .replace(/\\(?:textendash|textemdash)\b/g, "–")
    .replace(/\\(?:textit|emph|textbf|texttt|mbox|MakeUppercase|protect|relax|natexlab)\b\s*/g, "")
    .replace(/\\LaTeX\b/g, "LaTeX")
    .replace(/\\TeX\b/g, "TeX")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function referenceYear(value) {
  return String(value ?? "").match(/\b(?:1\d{3}|2\d{3})\b/)?.[0] || "";
}

export function referenceDoi(value) {
  return texReferenceText(value).match(/10\.\d{4,9}\/[^\s<>"{}\\]+/i)?.[0].replace(/[.,;]+$/, "").toLowerCase() || "";
}

export function normalizedReferenceTitle(value) {
  return texReferenceText(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function isPreprint(entry) {
  const fields = entry.fields || {};
  return entry.type === "preprint" || /^10\.48550\/arxiv\./i.test(referenceDoi(fields.doi))
    || /arxiv/i.test(String(fields.archiveprefix || fields.eprinttype || ""))
    || /arxiv\s*(?:preprint|:|\d|$)/i.test(String(fields.journal || ""))
    || (!fields.journal && !fields.booktitle && /arxiv\.org\//i.test(String(fields.url || "")));
}

export function referenceTypeLabel(entry) {
  if (isPreprint(entry)) return "预印本";
  if (entry.type === "misc" && entry.fields?.url) return "网页";
  return TYPE_LABELS[entry.type] || entry.type || "其他";
}

function knownVenue(value) {
  // A workshop at SIGCOMM is a distinct venue from the main conference.
  if (/\b(?:workshops?|posters?|demos?|co-located|companion|tutorials?)\b/i.test(value)) return undefined;
  return VENUES.find(([, , pattern]) => pattern.test(value));
}

export function referenceVenueDisplay(value, year = "") {
  const label = texReferenceText(value);
  const short = knownVenue(label)?.[0]
    || label.replace(/^proceedings\s+of\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?/i, "")
      .replace(/^proceedings\s*[,:]\s*/i, "");
  const normalizedYear = referenceYear(year);
  return { title: label, short, label: [short, short.includes(normalizedYear) && normalizedYear ? "" : normalizedYear].filter(Boolean).join(" ") };
}

export function referenceAuthorNames(value) {
  const authors = [];
  const text = String(value || "");
  let depth = 0;
  let start = 0;
  for (const token of text.matchAll(/[{}]|\s+and\s+/gi)) {
    if (token[0] === "{") depth++;
    else if (token[0] === "}") depth--;
    else if (depth === 0) {
      authors.push(text.slice(start, token.index));
      start = token.index + token[0].length;
    }
  }
  authors.push(text.slice(start));
  return authors.map((text) => {
    const name = texReferenceText(text);
    if (!name || /^others$/i.test(name)) return null;
    const commas = name.split(",").map((part) => part.trim());
    if (commas.length > 1 && !text.trim().startsWith("{")) {
      return { family: commas[0], given: commas.at(-1), full: [commas.at(-1), commas[0], commas.length === 3 ? commas[1] : ""].filter(Boolean).join(" ") };
    }
    const family = text.trim().startsWith("{") ? name : name.split(/\s+/).at(-1);
    return { family, given: family === name ? "" : name.slice(0, -family.length).trim(), full: name };
  }).filter(Boolean);
}

export function referenceAuthorLabel(entry) {
  const names = entry.authors || referenceAuthorNames(entry.author || entry.fields?.author || entry.fields?.editor);
  return names.length ? names[0].family + (names.length > 1 || /\band\s+others\b/i.test(entry.author || "") ? " et al." : "") : "作者未知";
}

export function bibliographyFieldIssues(entry) {
  const f = entry.fields || {};
  let required = ["title"];
  let recommended = [];
  if (["article", "inproceedings", "conference", "incollection", "inbook"].includes(entry.type) && !isPreprint(entry)) {
    required = [...required, "author", "year", entry.type === "article" ? "journal" : "booktitle"];
    recommended = ["pages", "doi"];
  } else if (isPreprint(entry)) required = [...required, "author", "year"];
  else if (entry.type === "book") required = [...required, "author", "year", "publisher"];
  else if (["phdthesis", "mastersthesis", "techreport"].includes(entry.type)) required = [...required, "author", "year", entry.type === "techreport" ? "institution" : "school"];
  const missing = (key) => key === "year" ? !referenceYear(f.year) : key === "author" ? !f.author && !f.editor : !f[key];
  return { required: required.filter(missing), recommended: recommended.filter(missing) };
}

function escaped(source, index) {
  let count = 0;
  while (source[--index] === "\\") count++;
  return count % 2 === 1;
}

function endOfBibGroup(source, start) {
  const open = source[start];
  const close = open === "{" ? "}" : open === "(" ? ")" : '"';
  let braces = 0;
  let quoted = false;
  let depth = open === "{" ? 0 : 1;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (escaped(source, i)) continue;
    if (char === "{") braces++;
    else if (char === "}" && braces) braces--;
    else if (!braces && char === close && !quoted && --depth <= 0) return i + 1;
    else if (open === "(" && !braces && char === '"') quoted = !quoted;
  }
  return -1;
}

function bibValue(source, start, limit, macros) {
  let cursor = start;
  const parts = [];
  do {
    while (/\s/.test(source[cursor] || "")) cursor++;
    if (source[cursor] === "{" || source[cursor] === '"') {
      const end = endOfBibGroup(source, cursor);
      if (end < 0 || end > limit) return null;
      parts.push(source.slice(cursor + 1, end - 1));
      cursor = end;
    } else {
      const atom = /^[^\s,#=(){}"]+/.exec(source.slice(cursor, limit))?.[0];
      if (!atom) return null;
      parts.push(macros.get(atom.toLowerCase()) ?? atom);
      cursor += atom.length;
    }
    while (/\s/.test(source[cursor] || "")) cursor++;
    if (source[cursor] !== "#") break;
    cursor++;
  } while (cursor < limit);
  return { value: parts.join(""), end: cursor };
}

export function parseBibliography(content, { strict = false } = {}) {
  const source = String(content || "");
  const entries = [];
  const macros = new Map(Object.entries(MONTHS));
  const headers = /@([a-z]+)\s*([({])/ig;
  for (let header; (header = headers.exec(source));) {
    const start = header.index;
    if (/^\s*%/.test(source.slice(source.lastIndexOf("\n", start - 1) + 1, start))) continue;
    const type = header[1].toLowerCase();
    const body = headers.lastIndex;
    const end = endOfBibGroup(source, body - 1);
    if (end < 0) {
      if (strict) throw new Error("BibTeX 括号不成对（第 " + source.slice(0, start).split("\n").length + " 行）。");
      continue;
    }
    headers.lastIndex = end;
    if (type === "comment" || type === "preamble") continue;
    if (type === "string") {
      const head = /^\s*([a-z][\w-]*)\s*=\s*/i.exec(source.slice(body, end - 1));
      if (head) {
        const value = bibValue(source, body + head[0].length, end - 1, macros);
        if (value) macros.set(head[1].toLowerCase(), value.value);
      }
      continue;
    }
    const keyMatch = /^\s*([^,\s{}()]+)\s*,/.exec(source.slice(body, end - 1));
    if (!keyMatch) {
      if (strict) throw new Error("BibTeX 条目缺少 citation key。");
      continue;
    }
    const key = keyMatch[1];
    const fields = Object.create(null);
    const spans = Object.create(null);
    let cursor = body + keyMatch[0].length;
    while (cursor < end - 1) {
      const skip = /^(?:[\s,]+|%[^\n]*)*/.exec(source.slice(cursor, end - 1))[0];
      cursor += skip.length;
      if (cursor >= end - 1) break;
      const head = /^([a-z][\w-]*)\s*=\s*/i.exec(source.slice(cursor, end - 1));
      const valueAt = head && cursor + head[0].length;
      const value = head && bibValue(source, valueAt, end - 1, macros);
      if (!value || (value.end < end - 1 && source[value.end] !== "," && source[value.end] !== "%")) {
        if (strict) throw new Error("文献 " + key + " 的字段格式无法识别。请检查逗号与花括号。");
        break;
      }
      const name = head[1].toLowerCase();
      fields[name] = value.value.trim();
      spans[name] = [valueAt - start, value.end - start];
      cursor = value.end;
    }
    entries.push({ type, key, fields, spans, start, end, raw: source.slice(start, end) });
  }
  return entries;
}

export function protectReferenceTitle(value) {
  let depth = 0;
  return String(value || "").replace(/\\[A-Za-z]+\b[ \t]*|\\.|[{}]|[\p{L}\p{N}][\p{L}\p{N}-]*/gu, (token) => {
    if (token === "{") depth++;
    if (token === "}") depth--;
    if (depth || !token.match(/^[\p{L}\p{N}]/u)) return token;
    return /[a-z][A-Z]|[A-Z].*[A-Z]|\d[A-Z]/.test(token) ? "{" + token + "}" : token;
  });
}

export function normalizeReferencePages(value) {
  return String(value || "").replace(/([\p{N}])\s*[-‐‑‒–—−]+\s*(?=\p{N})/gu, "$1--");
}

export function bibliographyFormatChanges(entry) {
  const fields = entry.fields || {};
  const changes = [];
  const title = protectReferenceTitle(fields.title);
  if (title && title !== fields.title) changes.push({ field: "title", value: title, label: "保护标题大小写" });
  const pages = normalizeReferencePages(fields.pages);
  if (pages && pages !== fields.pages) changes.push({ field: "pages", value: pages, label: "统一页码范围" });
  const venue = knownVenue(texReferenceText(fields.booktitle));
  if (venue && texReferenceText(fields.booktitle) !== venue[1]) changes.push({ field: "booktitle", value: venue[1], label: "统一会议名称" });
  return changes;
}

export function formatExistingReference(entry) {
  const changes = bibliographyFormatChanges(entry).filter(({ field }) => entry.spans?.[field]);
  let raw = entry.raw;
  for (const { field, value } of changes.sort((a, b) => entry.spans[b.field][0] - entry.spans[a.field][0])) {
    const [start, end] = entry.spans[field];
    const trailing = raw.slice(start, end).match(/\s*$/)[0];
    raw = raw.slice(0, start) + "{" + value + "}" + trailing + raw.slice(end);
  }
  return raw;
}

export function formatNewReference(entry) {
  const fields = { ...entry.fields };
  for (const field of ["abstract", "keywords", "file", "annote", "mendeley-groups", "timestamp"]) delete fields[field];
  for (const change of bibliographyFormatChanges({ ...entry, fields })) fields[change.field] = change.value;
  const doi = referenceDoi(fields.doi);
  if (doi) fields.doi = doi;
  return { type: entry.type, key: entry.key, fields };
}

export function referenceIdentityMatches(first, second) {
  const doi = referenceDoi(first.fields?.doi);
  if (doi && doi === referenceDoi(second.fields?.doi)) return true;
  const leftKey = normalizedReferenceTitle(first.title || first.fields?.title);
  if (!leftKey || leftKey !== normalizedReferenceTitle(second.title || second.fields?.title)) return false;
  const leftYear = referenceYear(first.year || first.fields?.year);
  const rightYear = referenceYear(second.year || second.fields?.year);
  if (isPreprint(first) === isPreprint(second) && leftYear && rightYear && leftYear !== rightYear) return false;
  const left = (first.authors || referenceAuthorNames(first.author || first.fields?.author))[0]?.family;
  const right = (second.authors || referenceAuthorNames(second.author || second.fields?.author))[0]?.family;
  return !left || !right || normalizedReferenceTitle(left) === normalizedReferenceTitle(right);
}

export function suggestReferenceKey(entry, existingKeys = [], rule = "author-year-title") {
  const author = referenceAuthorNames(entry.fields?.author || entry.fields?.editor)[0]?.family || "reference";
  const latin = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = texReferenceText(entry.fields?.title).match(/\b[a-z][a-z0-9-]{2,}\b/gi)?.find((word) => !/^(?:the|and|for|from|with|into|using|toward)$/i.test(word));
  const surname = latin(author) || "reference";
  const year = referenceYear(entry.fields?.year) || "nd";
  const title = latin(word) || "paper";
  const base = rule === "author-year" ? surname + year : rule === "title-year" ? title + year : surname + year + title;
  const taken = new Set(existingKeys.map((key) => String(key).toLowerCase()));
  let key = base;
  for (let suffix = 2; taken.has(key); suffix++) key = base + suffix;
  return key;
}

export function toBibTeX(entry) {
  const parts = Object.entries(entry.fields || {})
    .filter(([name, value]) => /^[a-z][\w-]*$/i.test(name) && String(value ?? "").trim())
    .map(([name, value]) => "  " + name + "={" + value + "}");
  return "@" + entry.type + "{" + entry.key + ",\n" + parts.join(",\n") + "\n}";
}

export function findCitationCommands(source) {
  const pattern = new RegExp(CITE_OPEN_PATTERN + "([^{}]*)\\}", "gid");
  return [...String(source || "").matchAll(pattern)].filter((match) => !escaped(source, match.index));
}


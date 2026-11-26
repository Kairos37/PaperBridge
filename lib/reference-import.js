import { BIB_KEY_PATTERN, parseBibliography, texReferenceText } from "../public/reference-data.js";

const DOI_PATTERN = /10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/i;
const ARXIV_ID_PATTERN = /(?:arxiv:\s*)?((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?)/i;
const KEY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "based", "by", "for", "from", "in", "into",
  "of", "on", "or", "the", "to", "toward", "towards", "via", "with", "using"
]);
const KEY_GENERIC_WORDS = new Set(["study", "analysis", "approach", "method", "system", "model", "framework"]);

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripMarkup(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeDoi(value) {
  let doi = decodeHtml(String(value || ""))
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
  doi = doi.replace(/^doi:\s*/i, "");
  const match = DOI_PATTERN.exec(doi);
  if (!match) return "";
  return match[0].replace(/[),.;]+$/, "").trim();
}

export function extractDoi(value) {
  return normalizeDoi(value);
}

export function extractArxivId(value) {
  return ARXIV_ID_PATTERN.exec(decodeHtml(String(value || "")))?.[1] || "";
}

function ieeeArticleNumber(url) {
  if (!/(^|\.)ieeexplore\.ieee\.org$/i.test(url.hostname)) return "";
  const number = /^\/(?:abstract\/)?document\/(\d+)(?:[\/;]|$)/i.exec(url.pathname)?.[1]
    || url.searchParams.get("arnumber") || "";
  return /^\d+$/.test(number) ? number.replace(/^0+(?=\d)/, "") : "";
}

export function normalizeReferenceUrl(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("请输入论文链接或 DOI。");
  const doi = normalizeDoi(input);
  if (doi) {
    return { input, doi, url: `https://doi.org/${doi}` };
  }
  if (!/^https?:\/\//i.test(input)) {
    const arxivId = extractArxivId(input);
    if (arxivId && /^(?:arxiv\s*:\s*)?(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i.test(input)) {
      return { input, doi: "", url: `https://arxiv.org/abs/${arxivId}` };
    }
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("论文链接格式不正确，请粘贴 DOI、arXiv、IEEE 或普通网页链接。");
  }
  const articleNumber = ieeeArticleNumber(url);
  return { input, doi, url: articleNumber ? "https://ieeexplore.ieee.org/document/" + articleNumber : url.toString() };
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function metadataFromCrossref(message) {
  const authors = Array.isArray(message.author) ? message.author.map((author) => ({
    family: String(author.family || "").trim(),
    given: String(author.given || "").trim(),
    literal: String(author.name || "").trim()
  })).filter((author) => author.family || author.given || author.literal) : [];
  const dateParts = message.issued?.["date-parts"]?.[0] || message.published?.["date-parts"]?.[0] || [];
  const year = dateParts[0] ? String(dateParts[0]) : "";
  const container = firstValue(message["container-title"]);
  const crossrefType = String(message.type || "misc");
  return {
    source: "crossref",
    type: crossrefType === "posted-content" ? "preprint" : crossrefType,
    title: texReferenceText(stripMarkup(firstValue(message.title))),
    authors,
    containerTitle: container,
    journal: message.type === "journal-article" ? container : "",
    booktitle: message.type === "proceedings-article" ? container : "",
    volume: String(message.volume || ""),
    number: String(message.issue || ""),
    pages: String(message.page || ""),
    year,
    publisher: String(message.publisher || ""),
    doi: normalizeDoi(message.DOI || message.doi),
    url: String(message.URL || ""),
    abstract: stripMarkup(message.abstract),
    accessed: ""
  };
}

function htmlMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i");
  return stripMarkup(pattern.exec(html)?.[1] || reverse.exec(html)?.[1] || "");
}

function htmlTitle(html) {
  return stripMarkup(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "");
}

function cleanPageTitle(value) {
  return String(value || "")
    .replace(/\s*[|\-–—]\s*(?:IEEE\s+Xplore|IEEEXplore|ScienceDirect|ACM\s+Digital\s+Library|SpringerLink).*$/i, "")
    .trim();
}

function htmlCanonicalUrl(html) {
  const direct = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const reverse = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i;
  return decodeHtml(direct.exec(html)?.[1] || reverse.exec(html)?.[1] || "").trim();
}

function authorFromName(value) {
  const name = stripMarkup(value);
  if (!name) return null;
  if (name.includes(",")) {
    const [family, ...given] = name.split(",");
    return { family: family.trim(), given: given.join(",").trim(), literal: "" };
  }
  const pieces = name.split(/\s+/).filter(Boolean);
  const family = pieces.pop() || "";
  return { family, given: pieces.join(" "), literal: "" };
}

function currentAccessDate() {
  return new Date().toISOString().slice(0, 10);
}

function doiFromHtml(html, { allowInline = false } = {}) {
  for (const field of ["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi", "doi"]) {
    const doi = normalizeDoi(htmlMeta(html, field));
    if (doi) return doi;
  }
  return allowInline ? normalizeDoi(String(html || "")) : "";
}

function metadataFromHtml(html, url) {
  const authors = [...String(html || "").matchAll(/<meta[^>]+(?:name|property)=["']citation_author["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map((match) => authorFromName(match[1]))
    .filter(Boolean);
  if (!authors.length) {
    const pageAuthor = authorFromName(htmlMeta(html, "author") || htmlMeta(html, "article:author"));
    if (pageAuthor) authors.push(pageAuthor);
  }
  const firstPage = htmlMeta(html, "citation_firstpage");
  const lastPage = htmlMeta(html, "citation_lastpage");
  const citationDoi = doiFromHtml(html);
  const arxivHost = /(^|\.)arxiv\.org$/i.test(url.hostname);
  const arxivId = extractArxivId(htmlMeta(html, "citation_arxiv_id"))
    || (arxivHost ? extractArxivId(url.pathname) : "");
  const journal = htmlMeta(html, "citation_journal_title");
  const booktitle = htmlMeta(html, "citation_conference_title");
  const citationTitle = htmlMeta(html, "citation_title");
  const publishedDate = htmlMeta(html, "citation_publication_date")
    || htmlMeta(html, "citation_date")
    || htmlMeta(html, "article:published_time")
    || htmlMeta(html, "date");
  const type = arxivId ? "preprint"
    : journal ? "journal-article"
      : booktitle ? "proceedings-article"
        : citationTitle ? "scholarly-article" : "webpage";
  return {
    source: "publisher-page",
    type,
    title: citationTitle || htmlMeta(html, "og:title") || htmlMeta(html, "twitter:title") || cleanPageTitle(htmlTitle(html)),
    authors,
    containerTitle: journal || booktitle,
    journal,
    booktitle,
    volume: htmlMeta(html, "citation_volume"),
    number: htmlMeta(html, "citation_issue"),
    pages: [firstPage, lastPage].filter(Boolean).join("--"),
    year: publishedDate.match(/\d{4}/)?.[0] || "",
    publisher: htmlMeta(html, "citation_publisher") || htmlMeta(html, "og:site_name") || url.hostname,
    doi: citationDoi,
    doiDiscovery: citationDoi ? "page" : "",
    url: htmlMeta(html, "citation_public_url") || htmlMeta(html, "og:url") || htmlCanonicalUrl(html) || url.toString(),
    abstract: htmlMeta(html, "description") || htmlMeta(html, "og:description"),
    eprint: arxivId.replace(/v\d+$/i, ""),
    archivePrefix: arxivId ? "arXiv" : "",
    primaryClass: htmlMeta(html, "citation_primary_category") || htmlMeta(html, "arxiv_primary_category"),
    accessed: currentAccessDate()
  };
}

function ieeePageData(html) {
  for (const script of String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const assignment = /\b(?:xplGlobal|global)\.document\.metadata\s*=\s*/.exec(script[1]);
    if (!assignment) continue;
    const start = assignment.index + assignment[0].length;
    if (script[1][start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    for (let index = start; index < script[1].length; index += 1) {
      const character = script[1][index];
      if (quoted && character === "\\") { index += 1; continue; }
      if (character === '"') quoted = !quoted;
      if (quoted) continue;
      if (character === "{") depth += 1;
      if (character !== "}" || --depth !== 0) continue;
      try { return JSON.parse(script[1].slice(start, index + 1)); }
      catch { break; }
    }
  }
  return null;
}

function metadataFromIeeePage(html, url, fallback) {
  const data = ieeePageData(html);
  if (!data || (data.articleNumber && String(data.articleNumber) !== ieeeArticleNumber(url))) return fallback;
  const title = stripMarkup(data.title || data.displayDocTitle);
  if (!title) return fallback;
  const authors = (Array.isArray(data.authors) ? data.authors : []).map((author) => (
    author.lastName || author.firstName
      ? { family: stripMarkup(author.lastName), given: stripMarkup(author.firstName), literal: "" }
      : authorFromName(author.name)
  )).filter(Boolean);
  const contentType = String(data.contentType || "");
  const type = /conference/i.test(contentType) ? "proceedings-article"
    : /journal|magazine|early access/i.test(contentType) ? "journal-article" : fallback.type;
  const container = stripMarkup(data.publicationTitle) || fallback.containerTitle;
  const doi = normalizeDoi(data.doi) || fallback.doi;
  return {
    ...fallback,
    source: "ieee-page",
    type: type === "webpage" ? "scholarly-article" : type,
    title,
    authors: authors.length ? authors : fallback.authors,
    containerTitle: container,
    journal: type === "journal-article" ? container : fallback.journal,
    booktitle: type === "proceedings-article" ? container : fallback.booktitle,
    volume: String(data.volume || fallback.volume),
    number: String(data.issue || fallback.number),
    pages: [data.startPage, data.endPage].filter(Boolean).join("--") || fallback.pages,
    year: String(data.publicationYear || data.publicationDate || "").match(/\d{4}/)?.[0] || fallback.year,
    publisher: stripMarkup(data.publisher) || "IEEE",
    doi,
    doiDiscovery: doi ? "page" : "",
    url: url.toString(),
    abstract: stripMarkup(data.abstract) || fallback.abstract
  };
}

async function ieeeCitation(request, url, articleNumber) {
  const endpoint = new URL("https://ieeexplore.ieee.org/rest/search/citation/format");
  endpoint.searchParams.set("recordIds", articleNumber);
  endpoint.searchParams.set("fromPage", "");
  endpoint.searchParams.set("citations-format", "citation-abstract");
  endpoint.searchParams.set("download-format", "download-bibtex");
  const response = await request(endpoint.toString(), { headers: { Accept: "application/json", Referer: url.toString() } });
  if (!response?.ok) return null;
  const payload = await response.json();
  if (typeof payload.data !== "string") return null;
  const entry = parseBibEntryText(decodeHtml(payload.data));
  const fields = entry.fields;
  if (!fields.title) return null;
  const doi = normalizeDoi(fields.doi);
  return {
    source: "ieee-citation",
    type: entry.type === "inproceedings" || entry.type === "conference" ? "proceedings-article"
      : entry.type === "article" ? "journal-article" : "scholarly-article",
    title: fields.title,
    authors: String(fields.author || "").split(/\s+and\s+/i).map(authorFromName).filter(Boolean),
    containerTitle: fields.journal || fields.booktitle || "",
    journal: fields.journal || "",
    booktitle: fields.booktitle || "",
    volume: fields.volume || "",
    number: fields.number || "",
    pages: fields.pages || "",
    year: fields.year || "",
    publisher: fields.publisher || "IEEE",
    doi,
    doiDiscovery: doi ? "ieee-citation" : "",
    url: url.toString(),
    abstract: fields.abstract || ""
  };
}

function normalizedTitle(value) {
  return decodeHtml(stripMarkup(value))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleSimilarity(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTokens = new Set(a.split(/\s+/));
  const bTokens = new Set(b.split(/\s+/));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return (2 * shared) / (aTokens.size + bTokens.size);
}

function likelyScholarlyPage(metadata, url, html) {
  return /(^|\.)ieeexplore\.ieee\.org$/i.test(url.hostname)
    || metadata.type !== "webpage"
    || /(?:name|property)=["']citation_(?:title|author|journal_title|conference_title)["']/i.test(html);
}

async function crossrefByDoi(request, doi) {
  const response = await request(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
  });
  if (!response?.ok) throw new Error(`文献元数据服务返回 HTTP ${response?.status || "错误"}。`);
  const payload = await response.json();
  return metadataFromCrossref(payload.message || {});
}

async function crossrefByTitle(request, title) {
  const query = new URL("https://api.crossref.org/works");
  query.searchParams.set("query.bibliographic", title);
  query.searchParams.set("rows", "5");
  const response = await request(query.toString(), {
    headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
  });
  if (!response?.ok) return null;
  const payload = await response.json();
  const candidates = Array.isArray(payload.message?.items) ? payload.message.items : [];
  const ranked = candidates
    .map((item) => ({ item, similarity: titleSimilarity(title, firstValue(item.title)) }))
    .sort((left, right) => right.similarity - left.similarity);
  if (!ranked[0] || ranked[0].similarity < 0.86) return null;
  return { metadata: metadataFromCrossref(ranked[0].item), similarity: ranked[0].similarity };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  if (!response?.ok) throw new Error(`文献元数据服务返回 HTTP ${response?.status || "错误"}。`);
  return response.json();
}

export async function lookupReferenceUrl(value, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络文献识别。");
  const normalized = normalizeReferenceUrl(value);
  const request = async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("文献元数据请求超时，请检查网络或直接粘贴 DOI。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  if (/^10\.48550\/arxiv\./i.test(normalized.doi)) {
    const eprint = extractArxivId(normalized.doi.slice("10.48550/arxiv.".length));
    if (eprint) return lookupReferenceUrl("https://arxiv.org/abs/" + eprint, { fetchImpl, timeoutMs });
  }
  if (normalized.doi) {
    try {
      return await crossrefByDoi(request, normalized.doi);
    } catch (error) {
      if (/超时/.test(error.message)) throw error;
      throw new Error(`无法通过 DOI 获取文献元数据：${error.message}`);
    }
  }

  const pageUrl = new URL(normalized.url);
  const arxivHost = /(^|\.)arxiv\.org$/i.test(pageUrl.hostname);
  const arxivId = arxivHost ? extractArxivId(pageUrl.pathname) : "";
  const fetchUrl = arxivHost && /^\/pdf\//i.test(pageUrl.pathname) && arxivId
    ? `https://arxiv.org/abs/${arxivId}`
    : normalized.url;
  const articleNumber = ieeeArticleNumber(pageUrl);
  let html = "";
  try {
    const response = await request(fetchUrl, { headers: { Accept: "text/html,application/xhtml+xml" } });
    if (!response?.ok) throw new Error(`论文网页返回 HTTP ${response?.status || "错误"}。`);
    html = await response.text();
  } catch (error) {
    if (!articleNumber) throw error;
  }
  let metadata = metadataFromHtml(html, pageUrl);
  if (articleNumber) {
    metadata = metadataFromIeeePage(html, pageUrl, metadata);
    if (!metadata.doi || !metadata.title || metadata.type === "webpage") {
      try {
        const citation = await ieeeCitation(request, pageUrl, articleNumber);
        if (citation) metadata = citation;
      } catch {
        // IEEE may restrict its citation endpoint even when the article page is available.
      }
    }
    if (!metadata.title || /^(?:IEEE Xplore(?:\s*[-|:]\s*(?:Error|System Error))?|Access Denied|Request Rejected|Just a moment|Robot Check|Page Not Found)$/i.test(metadata.title)) {
      throw new Error("IEEE 暂未返回论文信息，可能受到访问验证或网络限制。请稍后重试，也可从 IEEE 导出 BibTeX 后粘贴到下方预览框。");
    }
    if (metadata.type === "webpage") metadata.type = "scholarly-article";
  }
  if (metadata.doi && metadata.type !== "preprint" && metadata.source !== "ieee-citation") {
    try {
      metadata = {
        ...await crossrefByDoi(request, metadata.doi),
        url: metadata.url || pageUrl.toString(),
        doiDiscovery: metadata.doiDiscovery || "page",
        source: "publisher-page+crossref"
      };
    } catch {
      // The page metadata is still useful when Crossref is temporarily unavailable.
    }
  } else if (!metadata.doi && metadata.type !== "preprint" && metadata.title && likelyScholarlyPage(metadata, pageUrl, html)) {
    try {
      const resolved = await crossrefByTitle(request, metadata.title);
      if (resolved?.metadata?.doi) {
        metadata = {
          ...resolved.metadata,
          url: metadata.url || pageUrl.toString(),
          source: "publisher-page+crossref-title",
          doiDiscovery: "title-match",
          doiMatchConfidence: resolved.similarity
        };
      }
    } catch {
      // A page without a resolvable DOI can still be cited as a webpage or unpublished item.
    }
  }
  if (!metadata.title && !metadata.doi) throw new Error("没有在论文网页中找到可用的标题或 DOI。请改用 DOI 链接。");
  return metadata;
}

function ascii(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
}

function authorSurname(metadata) {
  const author = metadata.authors?.[0] || {};
  return ascii(author.family || author.literal || author.given).split(/\s+/)[0].toLowerCase() || "reference";
}

function titleKeywords(title) {
  return ascii(String(title || "").replace(/\\[A-Za-z]+\s*/g, " "))
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !KEY_STOP_WORDS.has(word) && !KEY_GENERIC_WORDS.has(word));
}

export function suggestCitationKey(metadata, existingKeys = []) {
  const year = String(metadata.year || "").match(/\d{4}/)?.[0] || "nd";
  const keywords = titleKeywords(metadata.title);
  const prefix = `${authorSurname(metadata)}${year}`;
  const base = `${prefix}${keywords[0] || "paper"}`;
  const used = new Set(existingKeys.map((key) => String(key).toLowerCase()));
  if (!used.has(base)) return base;
  for (const keyword of keywords.slice(1)) {
    const candidate = `${prefix}${keyword}`;
    if (!used.has(candidate)) return candidate;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

function escapeBibValue(value) {
  return String(value || "")
    .replace(/\\&/g, "&")
    .replace(/(^|[^\\])&/g, "$1\\&")
    .replace(/(^|[^\\])%/g, "$1\\%")
    .replace(/(^|[^\\])#/g, "$1\\#")
    .replace(/(^|[^\\])_/g, "$1\\_")
    .replace(/\s+/g, " ")
    .trim();
}

function bibAuthors(authors = []) {
  return authors.map((author) => {
    if (author.literal) return author.literal;
    if (author.family && author.given) return `${author.family}, ${author.given}`;
    return author.family || author.given;
  }).filter(Boolean).join(" and ");
}

export function metadataToBibEntry(metadata, key) {
  const type = metadata.type === "journal-article" ? "article"
    : metadata.type === "proceedings-article" ? "inproceedings"
      : metadata.type === "book-chapter" ? "incollection"
        : metadata.type === "book" ? "book" : "misc";
  const fields = [];
  const add = (name, value) => {
    if (String(value || "").trim()) fields.push([name, escapeBibValue(value)]);
  };
  add("title", metadata.title);
  add("author", bibAuthors(metadata.authors));
  if (type === "article") add("journal", metadata.journal || metadata.containerTitle);
  else if (type === "inproceedings" || type === "incollection") add("booktitle", metadata.booktitle || metadata.containerTitle);
  add("volume", metadata.volume);
  add("number", metadata.number);
  add("pages", String(metadata.pages || "").replace(/(?<!-)\s*-\s*(?!-)/g, "--"));
  add("year", metadata.year);
  add("publisher", metadata.type === "preprint" ? "" : metadata.publisher);
  add("doi", metadata.doi);
  if (metadata.type === "preprint") {
    add("eprint", metadata.eprint);
    add("archivePrefix", metadata.archivePrefix);
    add("primaryClass", metadata.primaryClass);
    add("url", metadata.url);
  } else if (metadata.type === "webpage" || metadata.type === "scholarly-article" || !metadata.doi) {
    add("url", metadata.url);
    if (metadata.type === "webpage") add("note", metadata.accessed ? `Accessed: ${metadata.accessed}` : "");
  }
  const formattedFields = fields.map(([name, value]) => `  ${name}={${value}}`);
  const raw = [
    `@${type}{${key},`,
    ...formattedFields.map((line, index) => `${line}${index < formattedFields.length - 1 ? "," : ""}`),
    "}"
  ].join("\n");
  return { type, key, fields: Object.fromEntries(fields), raw };
}

export function parseBibEntryText(text) {
  const value = String(text || "").trim();
  const [entry, ...extra] = parseBibliography(value, { strict: true });
  if (!entry) throw new Error("BibTeX 内容中没有找到文献条目。");
  if (extra.length || value.slice(entry.end).trim()) throw new Error("一次只能写入一个 BibTeX 条目。");
  if (!BIB_KEY_PATTERN.test(entry.key)) throw new Error("citation key 只能包含字母、数字、下划线、点、冒号、加号或短横线。");
  if (!entry.fields.title && !entry.fields.author) throw new Error("BibTeX 条目至少需要 title 或 author。");
  return { ...entry, fields: { ...entry.fields } };
}

export function serializeBibEntry(entry) {
  const fields = Object.entries(entry.fields || {}).filter(([, value]) => String(value || "").trim());
  const formattedFields = fields.map(([name, value]) => `  ${name}={${value}}`);
  return [
    `@${entry.type || "misc"}{${entry.key},`,
    ...formattedFields.map((line, index) => `${line}${index < formattedFields.length - 1 ? "," : ""}`),
    "}"
  ].join("\n");
}

export async function searchReferenceTitles(value, provider = "crossref", { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const title = stripMarkup(value).slice(0, 300).trim();
  if (title.length < 3) throw new Error("请输入至少三个字符的论文标题。");
  const endpoints = {
    crossref: ["https://api.crossref.org/works", { "query.bibliographic": title, rows: 8 }],
    dblp: ["https://dblp.org/search/publ/api", { q: title, format: "json", h: 8, c: 0 }],
    semantic: ["https://api.semanticscholar.org/graph/v1/paper/search", {
      query: title, limit: 8, fields: "title,authors,year,venue,externalIds,abstract,url,publicationTypes,journal,publicationVenue"
    }],
    arxiv: ["https://export.arxiv.org/api/query", {
      search_query: 'ti:"' + title.replaceAll('"', "") + '"', start: 0, max_results: 8
    }]
  };
  const entry = Object.hasOwn(endpoints, provider) && endpoints[provider];
  if (!entry) throw new Error("请选择有效的文献搜索来源。");
  const url = new URL(entry[0]);
  for (const [name, parameter] of Object.entries(entry[1])) url.searchParams.set(name, parameter);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: provider === "arxiv" ? "application/atom+xml" : "application/json", "User-Agent": "PaperBridge/0.5.5" }
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("标题搜索超时，请切换来源重试。");
    throw new Error("无法连接文献搜索服务。");
  }
  if (!response.ok) throw new Error(response.status === 429 ? "该来源暂时限流，可以切换搜索来源。" : "文献搜索服务返回 HTTP " + response.status + "。");
  let candidates;
  if (provider === "arxiv") {
    const text = await response.text();
    const tag = (xml, name) => stripMarkup(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(xml)?.[1] || "");
    candidates = [...text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].map(([, xml]) => {
      const url = tag(xml, "id").replace(/^http:/i, "https:");
      const eprint = extractArxivId(url);
      return {
        source: "arxiv", type: "preprint", title: tag(xml, "title"),
        authors: [...xml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map(([, author]) => authorFromName(tag(author, "name"))).filter(Boolean),
        year: tag(xml, "published").slice(0, 4), url, abstract: tag(xml, "summary"),
        eprint, archivePrefix: "arXiv", containerTitle: "arXiv",
        publishedDoi: normalizeDoi(tag(xml, "arxiv:doi")), journalRef: tag(xml, "arxiv:journal_ref")
      };
    });
  } else {
    const payload = await response.json();
    if (provider === "crossref") {
      candidates = (payload.message?.items || []).map(metadataFromCrossref);
    } else if (provider === "dblp") {
      candidates = (payload.result?.hits?.hit || []).map(({ info = {} }) => {
        const authors = [info.authors?.author || []].flat().map((author) => authorFromName(stripMarkup(author.text || author))).filter(Boolean);
        const venue = stripMarkup(info.venue);
        const preprint = /^(?:corr|arxiv)$/i.test(venue);
        const type = preprint ? "preprint" : /journal/i.test(info.type) ? "journal-article"
          : /conference|workshop/i.test(info.type) ? "proceedings-article" : /books?\b/i.test(info.type) ? "book" : "scholarly-article";
        const url = [info.ee || info.url || []].flat()[0] || "";
        return {
          source: "dblp", type, title: stripMarkup(info.title), authors, containerTitle: venue,
          year: String(info.year || ""), doi: normalizeDoi(info.doi || url), url,
          pages: String(info.pages || ""), volume: String(info.volume || ""), number: String(info.number || ""),
          eprint: preprint ? extractArxivId(url) : "", archivePrefix: preprint ? "arXiv" : ""
        };
      });
    } else {
      candidates = (payload.data || []).map((record) => {
        const ids = record.externalIds || {};
        const venue = stripMarkup(record.publicationVenue?.name || record.journal?.name || record.venue);
        const preprint = Boolean(ids.ArXiv) && (!venue || /\barxiv\b|\bcorr\b/i.test(venue));
        const types = (record.publicationTypes || []).join(" ") + " " + (record.publicationVenue?.type || "");
        const type = preprint ? "preprint" : /journal|review/i.test(types) ? "journal-article"
          : /conference/i.test(types) ? "proceedings-article" : /\bbook\b/i.test(types) ? "book" : "scholarly-article";
        return {
          source: "semantic", type, title: stripMarkup(record.title),
          authors: (record.authors || []).map((author) => authorFromName(author.name)).filter(Boolean),
          year: String(record.year || ""), doi: normalizeDoi(ids.DOI), url: record.url || "",
          containerTitle: venue, abstract: stripMarkup(record.abstract), pages: record.journal?.pages || "",
          volume: record.journal?.volume || "", eprint: preprint ? ids.ArXiv : "", archivePrefix: preprint ? "arXiv" : ""
        };
      });
    }
  }
  return candidates.filter((record) => record.title).slice(0, 8);
}

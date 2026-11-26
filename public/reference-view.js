import { referenceDoi, referenceTypeLabel, referenceVenueDisplay, referenceYear, texReferenceText } from "./reference-data.js";

export function refNode(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function refIcon(name) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  return icon;
}

export function refButton(label, action, { icon, className = "reference-action", title = label, iconOnly = false } = {}) {
  const button = refNode("button", className);
  button.type = "button";
  button.title = title;
  if (icon) button.append(refIcon(icon));
  if (iconOnly) button.setAttribute("aria-label", label);
  else button.append(refNode("span", "", label));
  button.addEventListener("click", action);
  return button;
}

export function refSection(title, className = "") {
  const section = refNode("section", "reference-detail-section " + className);
  section.append(refNode("h3", "", title));
  return section;
}

export function referenceSearchTerms(value) {
  return [...new Set(String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 20);
}

export function highlightReferenceWords(node, value, terms) {
  const text = String(value || "");
  if (!terms.length) {
    node.textContent = text;
    return;
  }
  const pattern = new RegExp(terms.slice().sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(text.slice(offset, match.index), refNode("mark", "reference-hit", match[0]));
    offset = match.index + match[0].length;
  }
  node.append(text.slice(offset));
}

export function addressIsReferenceInput(value) {
  const text = String(value || "").trim();
  return /^https?:\/\/\S+$|^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$|^(?:doi:\s*)?10\.\d{4,9}\/\S+$|^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i.test(text);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function externalReferenceLink(text, url, icon) {
  const link = refNode("a", "reference-action", "");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = url;
  if (icon) link.append(refIcon(icon));
  link.append(refNode("span", "", text));
  return link;
}

export function referenceIssueTags(entry) {
  const issues = [];
  if (!entry.cited) issues.push(["unused", "未引用"]);
  if (entry.warnings?.required?.length || entry.warnings?.recommended?.length) issues.push(["fields", "信息不全"]);
  if (entry.duplicateIds?.length) issues.push(["duplicate", "疑似重复"]);
  if (referenceTypeLabel(entry) === "预印本") issues.push(["preprint", entry.publishedIds?.length || entry.publishedDoi ? "有正式版本" : "仅预印本"]);
  return issues;
}

export function referenceDetailIdentity(entry) {
  const title = entry.title || texReferenceText(entry.fields?.title) || entry.key || "未填写标题";
  const author = entry.authors?.length ? entry.authors.map((name) => name.full).join(", ") : texReferenceText(entry.fields?.author);
  const venue = entry.venue || texReferenceText(entry.fields?.booktitle || entry.fields?.journal || entry.fields?.publisher);
  const year = referenceYear(entry.year || entry.fields?.year || entry.fields?.date);
  return { title, author, venue, year, type: referenceTypeLabel(entry) };
}

function formattedReference(entry, payload) {
  if (entry.printed) return { ...entry.printed, label: entry.printed.label, status: "上次编译输出" };
  const { title, author, venue, year } = referenceDetailIdentity(entry);
  const style = payload.style || "";
  const doi = referenceDoi(entry.fields.doi);
  const pages = texReferenceText(entry.fields.pages).replace(/--/g, "–");
  const suffix = doi ? "doi: " + doi : entry.fields.url || "";
  const isConference = ["inproceedings", "conference", "incollection"].includes(entry.type);
  const vol = [entry.fields.volume && "vol. " + entry.fields.volume, entry.fields.number && "no. " + entry.fields.number].filter(Boolean).join(", ");
  let text;
  if (/ieee/i.test(style)) {
    const names = entry.authors?.map((name) => {
      const initials = name.given.split(/[\s-]+/).filter(Boolean).map((word) => word[0] + ".").join(" ");
      return [initials, name.family].filter(Boolean).join(" ");
    }) || [];
    text = [names.join(", ") || author, "“" + title.replace(/\.$/, "") + ",”", venue && (isConference ? "in " : "") + venue, vol, pages && "pp. " + pages, year, suffix].filter(Boolean).join(" ");
  } else if (/acm/i.test(style)) {
    text = [author, year, title, venue && (isConference ? "In " : "") + venue,
      [vol, pages].filter(Boolean).join(", "), doi ? "https://doi.org/" + doi : entry.fields.url].filter(Boolean).join(". ");
  } else {
    text = [author, title, [venue, vol, year, pages && "pp. " + pages].filter(Boolean).join(", "), suffix].filter(Boolean).join(". ");
  }
  return {
    text: text.replace(/\s+([,.:;])/g, "$1").replace(/(?<![.!?])$/, "."),
    label: !payload.authorYear && entry.cited ? String(entry.number) : "",
    status: "格式预览 · 编译后可核对"
  };
}

function citationLocations(entry, actions) {
  const locations = entry.locations || [];
  const section = refSection("正文引用" + (locations.length ? " · " + locations.length + " 处" : ""));
  if (!entry.cited) {
    const empty = refNode("div", "reference-empty-citations");
    empty.append(refNode("span", "", "尚未引用"), refButton("插入到光标处", () => actions.insert(entry), { icon: "quote" }));
    section.append(empty);
  }
  for (const location of locations) {
    const link = refButton("", () => actions.gotoCitation(location), { className: "reference-context-link" });
    link.replaceChildren();
    const position = (location.nocite ? "仅列入文献表 · " : "")
      + (location.paragraph ? "P" + String(location.paragraph).padStart(2, "0") + " · " : "")
      + "L" + location.line;
    const header = refNode("span", "reference-context-meta");
    header.append(refIcon("corner-down-right"), refNode("strong", "", position), refNode("span", "", location.file));
    link.title = location.file + ":" + location.line + " · 跳转到编辑区";
    link.append(header, refNode("span", "reference-context-sentence", location.context || "跳转到引用所在行"));
    section.append(link);
  }
  return section;
}

function referenceFieldList(entry, labels) {
  const container = refNode("details", "reference-bib-details reference-field-details");
  container.append(refNode("summary", "", "BibTeX 字段和源码"));
  const list = refNode("dl", "reference-field-list");
  for (const [field, value] of Object.entries(entry.fields || {})) {
    if (!value || ["title", "author", "year", "booktitle", "journal", "abstract"].includes(field)) continue;
    const name = refNode("dt", "", labels?.[field] || field);
    name.title = field;
    const content = refNode("dd");
    const href = field === "doi" && referenceDoi(value) ? "https://doi.org/" + referenceDoi(value)
      : field === "url" ? safeExternalUrl(value) : "";
    if (href) {
      const link = refNode("a", "reference-link", value);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      content.append(link);
    } else content.textContent = value;
    list.append(name, content);
  }
  const source = refNode("pre", "reference-bib-source", entry.raw);
  if (list.children.length) container.append(list);
  container.append(source);
  return container;
}

function referenceNotes(entry, actions) {
  const notes = entry.notes || {};
  const section = refSection("笔记与标签");
  const form = refNode("form", "reference-notes");
  const tags = [...(notes.tags || [])];
  const pills = refNode("div", "reference-notes-tags");
  const input = refNode("input", "reference-tag-input");
  input.placeholder = "输入标签，按 Enter 添加";
  input.setAttribute("aria-label", "添加标签");
  input.maxLength = 200;
  const renderTags = () => {
    pills.replaceChildren();
    for (const tag of tags) {
      const chip = refButton(tag + " ×", () => {
        tags.splice(tags.indexOf(tag), 1);
        renderTags();
      }, { className: "reference-note-tag", title: "移除标签 " + tag });
      pills.append(chip);
    }
  };
  const addTags = () => {
    const upcoming = input.value.split(/[，,、]+/).map((tag) => tag.trim().slice(0, 40)).filter(Boolean);
    for (const tag of upcoming) if (!tags.includes(tag) && tags.length < 20) tags.push(tag);
    input.value = "";
    renderTags();
  };
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || !["Enter", ",", "，"].includes(event.key)) return;
    event.preventDefault();
    addTags();
  });
  renderTags();

  const reason = refNode("textarea");
  reason.rows = 2;
  reason.value = notes.reason || "";
  reason.placeholder = "这篇论文支持哪句话或方法？";
  reason.maxLength = 3000;
  const label = refNode("label", "reference-note-field", "引用理由");
  label.append(reason);
  const translation = refNode("details", "reference-bib-details");
  translation.open = Boolean(notes.translatedTitle || notes.translatedAbstract);
  translation.append(refNode("summary", "", "中文标题与摘要"));
  const title = refNode("input");
  title.value = notes.translatedTitle || "";
  title.maxLength = 1200;
  const abstract = refNode("textarea");
  abstract.value = notes.translatedAbstract || "";
  abstract.maxLength = 10000;
  abstract.rows = 3;
  const titleLabel = refNode("label", "reference-note-field", "中文标题");
  titleLabel.append(title);
  const abstractLabel = refNode("label", "reference-note-field", "中文摘要");
  abstractLabel.append(abstract);
  const translate = refButton("译成中文", async () => {
    translate.disabled = true;
    status.textContent = "正在翻译标题与摘要…";
    try {
      const result = await actions.translate(entry);
      title.value = result.translatedTitle;
      abstract.value = result.translatedAbstract;
      status.textContent = result.hasAbstract ? "翻译已填入，可检查后保存。" : "标题已译，未获取到原文摘要。";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      translate.disabled = false;
    }
  }, { icon: "languages" });
  const status = refNode("span", "reference-note-status");
  status.setAttribute("role", "status");
  translation.append(titleLabel, abstractLabel, translate, status);

  const save = refNode("button", "reference-action", "保存笔记");
  save.type = "submit";
  form.append(pills, input, label, translation, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    addTags();
    save.disabled = true;
    try {
      await actions.saveNotes(entry, { tags, reason: reason.value, translatedTitle: title.value, translatedAbstract: abstract.value });
    } finally {
      save.disabled = false;
    }
  });
  section.append(form);
  return section;
}

export function renderReferenceDetail(container, entry, payload, actions) {
  container.replaceChildren();
  if (!entry) {
    container.append(refNode("div", "empty-state", "选择文献后查看详情和正文引用位置。"));
    return;
  }
  const identity = referenceDetailIdentity(entry);
  const header = refNode("header", "reference-detail-header");
  header.append(refNode("h2", "", identity.title));
  header.append(refNode("p", "reference-detail-authors", identity.author || "作者未知"));
  const venue = refNode("p", "reference-detail-meta");
  venue.textContent = [identity.venue, identity.year, identity.type].filter(Boolean).join(" · ");
  header.append(venue);
  const line = refNode("div", "reference-key-line");
  const key = refNode("code", "reference-key-chip", entry.key);
  const source = refButton(entry.file + ":" + entry.startLine, () => actions.gotoSource(entry), { icon: "external-link", className: "reference-source-link" });
  line.append(key, source);
  header.append(line);

  const toolbar = refNode("div", "reference-detail-actions");
  toolbar.append(
    refButton("插入引用", () => actions.insert(entry), { icon: "quote", className: "reference-action reference-action-primary" }),
    refButton("复制 \\cite", () => actions.copy(entry), { icon: "copy", title: "复制 \\cite{" + entry.key + "}" }),
    refButton("编辑", () => actions.edit(entry), { icon: "pencil" }),
    refButton("删除", () => actions.remove(entry), { icon: "trash-2", className: "reference-action reference-action-danger" })
  );
  const doi = referenceDoi(entry.fields.doi);
  const url = safeExternalUrl(entry.fields.url);
  if (doi) toolbar.insertBefore(externalReferenceLink("打开 DOI", "https://doi.org/" + doi, "external-link"), toolbar.children[2]);
  else if (url) toolbar.insertBefore(externalReferenceLink("打开链接", url, "external-link"), toolbar.children[2]);
  header.append(toolbar);

  const problems = refSection("检查结果", "reference-issue-detail");
  const missing = [...(entry.warnings?.required || []), ...(entry.warnings?.recommended || [])];
  if (missing.length) {
    const fieldText = missing.map((name) => payload.fieldLabels?.[name] || name).join("、");
    const item = refNode("div", "reference-issue-line");
    item.append(refNode("span", "", "缺少 " + fieldText), refButton("补全字段", () => actions.enrich(entry), { icon: "list-plus" }));
    problems.append(item);
  }
  for (const related of entry.duplicateIds?.map((id) => payload.entries.find((item) => item.id === id)).filter(Boolean) || []) {
    const item = refNode("div", "reference-issue-line");
    item.append(refButton("疑似重复 #" + related.number, () => actions.select(related), { className: "reference-source-link", title: related.title }),
      refButton("合并到此条", () => actions.merge(related, entry), { icon: "merge" }));
    problems.append(item);
  }
  if (referenceTypeLabel(entry) === "预印本") {
    const published = entry.publishedIds?.map((id) => payload.entries.find((item) => item.id === id)).filter(Boolean) || [];
    for (const related of published) {
      const item = refNode("div", "reference-issue-line");
      item.append(refButton("正式版本 #" + related.number, () => actions.select(related), { className: "reference-source-link", title: related.title }),
        refButton("改用正式版", () => actions.merge(entry, related), { icon: "arrow-right-left" }));
      problems.append(item);
    }
    if (!published.length) {
      const item = refNode("div", "reference-issue-line");
      item.append(refNode("span", "", entry.publishedDoi ? "已知对应正式发表版本" : "当前仅收录预印本"),
        refButton(entry.publishedDoi ? "获取正式版" : "查找正式版", () => actions.findPublication(entry), { icon: "search" }));
      problems.append(item);
    }
  }
  if (entry.formatIssues?.length) {
    const item = refNode("div", "reference-issue-line");
    item.append(refNode("span", "", entry.formatIssues.join("、")), refButton("统一格式", () => actions.normalize(entry), { icon: "wand-sparkles" }));
    problems.append(item);
  }

  const preview = formattedReference(entry, payload);
  const previewSection = refSection("参考文献表预览");
  previewSection.append(refNode("div", "reference-preview-caption", [payload.style, preview.status].filter(Boolean).join(" · ")));
  const sample = refNode("div", "reference-printed-preview");
  if (preview.label) sample.append(refNode("span", "reference-print-number", "[" + preview.label + "]"));
  sample.append(refNode("span", "", preview.text));
  previewSection.append(sample);
  container.append(header, citationLocations(entry, actions));
  if (problems.children.length > 1) container.append(problems);
  container.append(previewSection, referenceNotes(entry, actions), referenceFieldList(entry, payload.fieldLabels));
}


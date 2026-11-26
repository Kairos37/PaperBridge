import { reviewCrop, renderReviewMarks } from "./review-preview.js";

const byId = (id) => document.getElementById(id);
const states = { pending: "待处理", resolved: "已处理", rejected: "不采纳", unlocated: "待定位" };
const types = { task: "待办", question: "疑问", term: "术语", citation: "引用", polish: "润色" };
const sources = { manual: "手动", pdf: "PDF 审阅", compile: "编译警告", translation: "需重译" };
const markup = { Highlight: "高亮", Underline: "下划线", StrikeOut: "删除线", Squiggly: "波浪线", Text: "便签", FreeText: "文本批注", Ink: "手写批注" };
const confidenceText = { high: "高置信", medium: "中等置信", unlocated: "待定位", manual: "手动定位" };
const unresolved = (item) => item.status === "pending" || item.status === "unlocated";
const ownerKey = "paperBridge.reviewAuthor";

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value != null) item.textContent = value;
  return item;
}

function button(label, action, { icon, className = "review-action" } = {}) {
  const item = node("button", className);
  item.type = "button";
  if (icon) {
    const vector = node("i");
    vector.dataset.lucide = icon;
    item.append(vector);
  }
  item.append(node("span", "", label));
  item.addEventListener("click", action);
  return item;
}

function locationName(item) {
  if (item?.file) return [item.file, item.paragraph && "P" + String(item.paragraph).padStart(2, "0"), "L" + item.line].filter(Boolean).join(" · ");
  if (item?.pdf?.page) return "PDF 第 " + item.pdf.page + " 页";
  return "";
}

function noteText(item) {
  return item.text || markup[item.subtype] || "批注";
}

async function responseError(response) {
  const error = await response.json().catch(() => ({}));
  return new Error(error.error || "操作失败（" + response.status + "）");
}

async function download(url, options, fallback) {
  const response = await fetch(url, options);
  if (!response.ok) throw await responseError(response);
  const disposition = response.headers.get("content-disposition") || "";
  const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const ascii = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = node("a");
  anchor.href = objectUrl;
  anchor.download = name ? decodeURIComponent(name) : ascii || fallback;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function highlightInReading(reader, quote) {
  if (!quote || !reader) return;
  const walker = document.createTreeWalker(reader, NodeFilter.SHOW_TEXT, {
    acceptNode(text) {
      return text.parentElement.closest("mark, [data-latex]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  const target = quote.trim().toLowerCase();
  while (walker.nextNode()) {
    const text = walker.currentNode;
    const start = text.data.toLowerCase().indexOf(target);
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + target.length);
    range.surroundContents(node("mark", "review-inline-quote"));
    return;
  }
}

export function mountReviewCenter({ api, project, beforeWrite, openPanel, locate, currentSelection, notify, icons, onChange, pdfjs }) {
  const panel = byId("reviewCenter");
  const list = byId("reviewThreadList");
  const importDialog = byId("reviewImportDialog");
  const noteDialog = byId("reviewNoteDialog");
  const fileInput = byId("reviewImportFile");
  const importStatus = byId("reviewImportStatus");
  const importConfirm = byId("reviewImportConfirm");
  const selectionButton = byId("reviewSelectionButton");
  const replyDrafts = new Map();
  const openRounds = new Map();
  const inlineOpen = new Set();
  let projectId = "";
  let data = null;
  let read = null;
  let dataRevision = 0;
  let filter = "all";
  let selected = "";
  let writing = false;
  let preview = null;
  let previewFile = null;
  let importSequence = 0;
  let note = null;
  let floating = null;
  let locating = "";
  let readError = "";
  let refreshTimer = 0;
  const me = () => (localStorage.getItem(ownerKey) || "我").trim();

  function syncProject() {
    const next = project();
    if (next === projectId) return;
    projectId = next;
    dataRevision += 1;
    data = null;
    read = null;
    selected = "";
    locating = "";
    readError = "";
    filter = "all";
    preview = null;
    previewFile = null;
    ++importSequence;
    if (importDialog.open) importDialog.close();
    if (noteDialog.open) noteDialog.close();
    replyDrafts.clear();
    openRounds.clear();
    inlineOpen.clear();
    hideSelection();
    onChange();
  }

  function apply(result) {
    dataRevision += 1;
    data = result;
    readError = "";
    render();
    onChange();
  }

  async function load({ force = false } = {}) {
    syncProject();
    if (!projectId) return;
    if (read) return read;
    if (data && !force) { render(); return data; }
    const revision = dataRevision;
    if (!data) render();
    const operation = api("/api/reviews")
      .then((result) => {
        if (revision === dataRevision && projectId === project()) apply(result);
        return result;
      })
      .catch((error) => {
        if (revision === dataRevision) { readError = error.message; render(); }
        return null;
      }).finally(() => { if (read === operation) read = null; });
    read = operation;
    return read;
  }

  function invalidate() {
    syncProject();
    window.clearTimeout(refreshTimer);
    if (projectId) refreshTimer = window.setTimeout(() => void load({ force: true }), 280);
  }

  function all() {
    return data?.threads || [];
  }

  function visibleItems() {
    const name = me().toLowerCase();
    return all().filter((item) => {
      if (filter === "open") return unresolved(item);
      if (filter === "unlocated") return !item.anchor;
      if (filter === "mine") return item.own || item.displayAuthor.toLowerCase() === name;
      if (filter === "mentioned") return [item.text, ...item.replies.map((reply) => reply.text)]
        .some((text) => String(text).toLowerCase().includes("@" + name));
      return true;
    });
  }

  function choose(id, { jump = false } = {}) {
    const item = all().find((entry) => entry.id === id);
    if (!item) return;
    selected = id;
    if (!visibleItems().some((entry) => entry.id === id)) filter = "all";
    if (item.round) openRounds.set(item.round, true);
    if (item.anchor?.segmentId) inlineOpen.add(item.anchor.segmentId);
    openPanel();
    render();
    onChange();
    list.querySelector('[data-review-id="' + CSS.escape(id) + '"]')?.scrollIntoView({ block: "nearest" });
    if (jump) void locate(item).catch((error) => notify(error.message, "info"));
  }

  async function change(event) {
    if (writing) return null;
    writing = true;
    const requested = project();
    try {
      if (event.kind === "create" || event.kind === "locate") await beforeWrite();
      if (requested !== project()) throw new Error("当前项目已切换。");
      const result = await api("/api/reviews/events", {
        method: "POST", body: JSON.stringify({ author: me(), ...event })
      });
      if (requested !== project()) return null;
      apply(result);
      return result;
    } finally { writing = false; }
  }

  function safeChange(event) {
    return change(event).catch((error) => { notify(error.message, "error"); return null; });
  }

  function showCrop(host, item, file = null) {
    if (!item.pdf?.regions?.length || (!file && !item.pdf.attachment)) return;
    const details = node("details", "review-crop");
    details.append(node("summary", "", "查看批注截图"));
    details.addEventListener("toggle", async () => {
      if (!details.open || details.hasAttribute("data-loaded")) return;
      details.dataset.loaded = "true";
      const loading = node("p", "review-muted", "正在生成截图…");
      details.append(loading);
      try {
        const input = file ? { data: new Uint8Array(await file.arrayBuffer()) } : { url: "/api/reviews/attachment/" + item.pdf.attachment };
        const image = await reviewCrop(pdfjs, input, item.pdf.page, item.pdf.regions);
        if (image) details.append(image);
      } catch (error) { details.append(node("p", "review-inline-error", "截图不可用 · " + error.message)); }
      finally { loading.remove(); }
    }, { passive: true });
    host.append(details);
  }

  function threadBody(item, { inline = false } = {}) {
    const article = node("div", "review-thread-body");
    if (!inline) {
      const detail = [confidenceText[item.confidence], item.at && item.at.slice(0, 10)].filter(Boolean).join(" · ");
      if (detail) article.append(node("p", "review-inline-meta", detail));
      if (item.text && item.quote) article.append(node("blockquote", "review-quote", item.quote));
      if (item.pdf && (!item.anchor || item.subtype === "Ink")) showCrop(article, item);
    } else {
      article.append(node("p", "review-inline-meta", item.displayAuthor + " · " + (states[item.status] || "")),
        node("p", "review-thread-text", item.text || item.quote || noteText(item)));
    }
    if (item.replies.length) {
      const replies = node("div", "review-replies");
      for (const reply of item.replies) {
        const row = node("div", "review-reply");
        row.append(node("span", "review-muted", reply.displayAuthor + " · " + String(reply.at || "").slice(0, 10)),
          node("p", "", reply.text));
        replies.append(row);
      }
      article.append(replies);
    }
    const tools = node("div", "review-thread-tools");
    const status = node("select");
    status.setAttribute("aria-label", "批注状态");
    for (const [value, label] of Object.entries(states)) {
      if (value !== "unlocated" || item.status === "unlocated") status.append(new Option(label, value));
    }
    status.value = item.status;
    status.addEventListener("change", async () => {
      const old = item.status;
      status.disabled = true;
      const result = await safeChange({ kind: "status", id: item.id, status: status.value });
      if (!result) status.value = old;
      status.disabled = false;
    });
    tools.append(status);
    if (!inline) {
      if (item.anchor || item.pdf) tools.append(button("定位", () => choose(item.id, { jump: true }), { icon: "locate-fixed" }));
      if (!item.anchor) {
        tools.append(button(locating === item.id ? "绑定到光标处" : "手动定位", async () => {
          if (locating !== item.id) {
            locating = item.id;
            render();
            notify("在源码或段落中选好位置，再点“绑定到光标处”。", "info");
            return;
          }
          const anchor = currentSelection();
          if (!anchor?.file || !anchor.line) { notify("请先在 TeX 源码或段落中选择位置。", "info"); return; }
          const result = await safeChange({ kind: "locate", id: item.id, anchor });
          if (result) {
            locating = "";
            choose(item.id, { jump: true });
          }
        }, { icon: "map-pin" }));
      }
    }
    article.append(tools);
    const composer = node("form", "review-reply-form");
    const input = node("textarea");
    input.rows = 2;
    input.spellcheck = false;
    input.placeholder = "写回复…";
    input.setAttribute("aria-label", "回复内容");
    input.value = replyDrafts.get(item.id) || "";
    input.addEventListener("input", () => replyDrafts.set(item.id, input.value));
    const submit = node("button", "button secondary", "回复");
    submit.type = "submit";
    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      submit.disabled = true;
      replyDrafts.delete(item.id);
      const result = await safeChange({ kind: "reply", id: item.id, text });
      if (!result) { replyDrafts.set(item.id, text); submit.disabled = false; }
    });
    composer.append(input, submit);
    article.append(composer);
    return article;
  }

  function renderItem(item) {
    const article = node("article", "review-thread" + (item.id === selected ? " active" : ""));
    article.dataset.reviewId = item.id;
    const opener = node("button", "review-thread-select");
    opener.type = "button";
    opener.setAttribute("aria-expanded", String(item.id === selected));
    const status = node("span", "review-thread-status " + item.status, states[item.status]);
    const meta = node("span", "review-thread-meta");
    meta.append(node("strong", "", item.displayAuthor), status);
    const label = node("span", "review-thread-title", item.text || item.quote || noteText(item));
    const position = locationName(item.anchor || item);
    const context = node("span", "review-thread-context",
      [position, types[item.type], sources[item.source], item.replies.length && item.replies.length + " 回复"].filter(Boolean).join(" · "));
    opener.append(meta, label, context);
    opener.addEventListener("click", () => choose(item.id, { jump: true }));
    article.append(opener);
    if (item.id === selected) article.append(threadBody(item));
    return article;
  }

  function renderGroups(items) {
    const grouped = new Map();
    for (const item of items) {
      const round = item.round || "";
      const group = grouped.get(round) || [];
      group.push(item);
      grouped.set(round, group);
    }
    for (const [round, group] of grouped) {
      const groupNode = round ? node("details", "review-round") : node("section", "review-local");
      if (round) {
        const label = data.rounds?.find((entry) => entry.id === round)?.label || "外部审阅";
        groupNode.open = openRounds.get(round) ?? true;
        groupNode.append(node("summary", "", label + " · " + group.length));
        groupNode.addEventListener("toggle", () => openRounds.set(round, groupNode.open));
      }
      const sections = new Map();
      for (const item of group) {
        const label = item.anchor?.section || item.anchor?.file || "待定位";
        const items = sections.get(label) || [];
        items.push(item);
        sections.set(label, items);
      }
      for (const [name, children] of sections) {
        const section = node("section", "review-chapter");
        section.append(node("h3", "", name + " · " + children.length), ...children.map(renderItem));
        groupNode.append(section);
      }
      list.append(groupNode);
    }
  }

  function renderWarnings() {
    const host = byId("reviewWarningList");
    host.replaceChildren();
    if (!data?.warnings?.length) return;
    const details = node("details", "review-warning-group");
    details.append(node("summary", "", "引用警告 · " + data.warnings.length));
    for (const item of data.warnings) {
      const row = node("div", "review-warning-row");
      row.append(node("span", "", item.text + (item.file ? " · " + item.file + ":" + item.line : "")),
        button("转为批注", async () => {
          const result = await safeChange({ kind: "warnings", keys: [item.external] });
          if (result?.selected) choose(result.selected);
        }, { icon: "plus" }));
      details.append(row);
    }
    host.append(details);
  }

  function render() {
    const items = visibleItems();
    const count = all().filter(unresolved).length;
    byId("annotationCount").textContent = String(count);
    byId("annotationCount").classList.toggle("hidden", !count);
    byId("reviewRepliesButton").disabled = !all().length;
    for (const item of panel.querySelectorAll("[data-review-filter]")) {
      item.setAttribute("aria-pressed", String(filter === item.dataset.reviewFilter));
    }
    list.replaceChildren();
    renderWarnings();
    if (readError && !data) {
      list.append(node("p", "review-inline-error", readError), button("重新读取", () => void load({ force: true })));
    } else if (!data && projectId) list.append(node("p", "review-muted review-list-message", "正在读取批注…"));
    else if (!all().length) {
      const empty = node("section", "review-empty");
      empty.append(node("h3", "", "还没有批注"),
        node("p", "", "在源码或 PDF 中选中文字即可添加，也可以导入导师批注过的 PDF。"),
        button("导入审阅", () => fileInput.click(), { icon: "file-up" }),
        button("添加批注", () => newNote(currentSelection()), { icon: "message-square-plus" }));
      list.append(empty);
    } else if (!items.length) list.append(node("p", "review-muted review-list-message", "当前筛选下没有批注。"));
    else renderGroups(items);
    if (data?.unreadable) list.prepend(node("p", "review-inline-error", data.unreadable + " 条批注日志无法读取。"));
    icons();
  }

  function newNote(anchor, { type = "question", text = "", source = "manual" } = {}) {
    if (!project()) { notify("请先打开论文项目。", "info"); return; }
    hideSelection();
    note = { anchor: anchor || {}, source };
    byId("reviewNoteAnchor").textContent = locationName(anchor) || "待定位";
    const quote = byId("reviewNoteQuote");
    quote.textContent = anchor?.quote || "";
    quote.classList.toggle("hidden", !quote.textContent);
    byId("reviewNoteType").value = type;
    byId("reviewNoteText").value = text;
    byId("reviewNoteError").textContent = "";
    if (!noteDialog.open) noteDialog.showModal();
    byId("reviewNoteText").focus();
  }

  function hideSelection() {
    floating = null;
    selectionButton.classList.add("hidden");
  }

  function showSelection(anchor, { x, y }) {
    if (!anchor?.quote || noteDialog.open || importDialog.open) { hideSelection(); return; }
    floating = anchor;
    selectionButton.querySelector("span").textContent = locating && anchor.file ? "绑定到这里" : "添加批注";
    selectionButton.style.left = Math.max(8, Math.min(innerWidth - 116, x + 8)) + "px";
    selectionButton.style.top = Math.max(6, Math.min(innerHeight - 40, y + 10)) + "px";
    selectionButton.classList.remove("hidden");
  }

  function renderImport() {
    const inputs = byId("reviewImportAliases");
    const list = byId("reviewImportItems");
    inputs.replaceChildren();
    list.replaceChildren();
    importConfirm.disabled = !preview?.token || !preview.added;
    if (!preview) return;
    if (!preview.total) {
      importStatus.textContent = preview.possibleFlattened
        ? "未发现可导入的批注。若标记可见，阅读器可能已将批注压平到页面图像里。"
        : "这份审阅版还没有可导入的批注。";
      return;
    }
    const label = preview.match === "text" ? preview.label + " · 按正文匹配" : preview.label;
    importStatus.textContent = label + "\n发现 " + preview.total + " 条批注，" + preview.authors.length + " 位作者，"
      + preview.unlocated + " 条待定位" + (preview.duplicates ? "，" + preview.duplicates + " 条已导入" : "") + "。";
    for (const author of preview.authors) {
      const label = node("label", "review-author-field", author.name);
      const input = node("input");
      input.type = "text";
      input.maxLength = 100;
      input.placeholder = "显示名，例如王老师";
      input.value = author.alias;
      input.dataset.reviewAuthor = author.name;
      label.append(input);
      inputs.append(label);
    }
    for (const item of preview.items) {
      const row = node("article", "review-import-item");
      const status = item.duplicate ? "已导入" : item.replyTo ? "回复" : confidenceText[item.confidence] || "待定位";
      row.append(node("p", "review-thread-context", [item.author, markup[item.subtype], "第 " + item.pdf.page + " 页", status].filter(Boolean).join(" · ")),
        node("strong", "", noteText(item)));
      if (item.quote) row.append(node("blockquote", "review-quote", item.quote));
      if (item.anchor) row.append(node("p", "review-muted", locationName(item.anchor)));
      if (!item.duplicate && (!item.anchor || item.subtype === "Ink")) showCrop(row, item, previewFile);
      list.append(row);
    }
    icons();
  }

  async function importFile(file) {
    if (!file || !project()) { if (file) notify("请先打开论文项目。", "info"); return; }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return;
    const sequence = ++importSequence;
    const requested = project();
    preview = null;
    previewFile = file;
    renderImport();
    importStatus.textContent = "正在读取 PDF 批注和对应源码…";
    if (!importDialog.open) importDialog.showModal();
    try {
      const response = await fetch("/api/reviews/import-preview", {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: file
      });
      if (!response.ok) throw await responseError(response);
      const result = await response.json();
      if (sequence !== importSequence || requested !== project()) return;
      preview = result;
      renderImport();
    } catch (error) {
      if (sequence === importSequence) importStatus.textContent = error.message;
    }
  }

  function decorateRows(container) {
    for (const row of container.querySelectorAll(".segment-row[data-segment-id]")) {
      const id = row.dataset.segmentId;
      const threads = all().filter((item) => item.anchor?.segmentId === id);
      const actions = row.querySelector(".segment-actions");
      let control = actions?.querySelector(".review-segment-button");
      if (actions && !control) {
        control = button("", () => {
          const items = all().filter((item) => item.anchor?.segmentId === id);
          if (!items.length) { newNote(currentSelection(row)); return; }
          if (inlineOpen.has(id)) inlineOpen.delete(id);
          else inlineOpen.add(id);
          decorateRows(container);
        }, { icon: "message-square", className: "mini-button review-segment-button" });
        actions.prepend(control);
      }
      if (control) {
        control.title = threads.length ? threads.length + " 条批注" : "给本段添加批注";
        control.setAttribute("aria-label", control.title);
        control.setAttribute("aria-expanded", String(inlineOpen.has(id)));
        control.querySelector("span").textContent = threads.length ? String(threads.length) : "";
        control.classList.toggle("has-reviews", Boolean(threads.length));
      }
      const menu = row.querySelector(".segment-menu-items");
      const task = menu?.querySelector(".review-translation-task");
      const needsTranslation = row.querySelector(".segment-status:is(.pending,.english-changed)");
      if (task && !needsTranslation) task.remove();
      if (menu && !task && needsTranslation) {
        menu.append(button("将需重译转为待办", () => newNote(currentSelection(row), {
          type: "task", text: "这段中文工作稿已修改，需要重新翻译。", source: "translation"
        }), { icon: "list-todo", className: "mini-button review-translation-task" }));
      }
      for (const reader of row.querySelectorAll(".segment-reading")) {
        if (reader === document.activeElement) continue;
        reader.querySelectorAll(".review-inline-quote").forEach((mark) => { mark.replaceWith(...mark.childNodes); });
        for (const item of threads) highlightInReading(reader, item.quote);
      }
      row.querySelector(".review-inline-threads")?.remove();
      if (threads.length && inlineOpen.has(id)) {
        const sections = node("div", "review-inline-threads");
        for (const item of threads) sections.append(threadBody(item, { inline: true }));
        sections.append(button("添加批注", () => newNote(currentSelection(row)), { icon: "plus" }));
        row.append(sections);
      }
    }
    icons();
  }

  byId("reviewProfileName").value = localStorage.getItem(ownerKey) || "";
  byId("reviewProfileName").addEventListener("change", (event) => {
    localStorage.setItem(ownerKey, event.currentTarget.value.trim());
    render();
  });
  panel.querySelectorAll("[data-review-filter]").forEach((item) => item.addEventListener("click", () => {
    filter = item.dataset.reviewFilter;
    render();
  }));
  for (const item of document.querySelectorAll("[data-close-review]")) item.addEventListener("click", () => byId(item.dataset.closeReview).close());
  byId("reviewImportButton").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { const file = fileInput.files[0]; fileInput.value = ""; if (file) void importFile(file); });
  importDialog.addEventListener("close", () => { ++importSequence; preview = null; previewFile = null; });
  importConfirm.addEventListener("click", async () => {
    if (!preview?.token || writing) return;
    writing = true;
    importConfirm.disabled = true;
    const token = preview.token;
    const requested = project();
    const aliases = Object.fromEntries([...byId("reviewImportAliases").querySelectorAll("input")].map((input) => [input.dataset.reviewAuthor, input.value]));
    try {
      const result = await api("/api/reviews/import", { method: "POST", body: JSON.stringify({ token, aliases }) });
      if (requested !== project()) return;
      apply(result);
      importDialog.close();
      if (result.selected) choose(result.selected);
      else openPanel();
      notify("已合并 " + result.imported + " 条批注。", "success");
    } catch (error) {
      importStatus.textContent = error.message;
      importConfirm.disabled = false;
    } finally { writing = false; }
  });
  byId("reviewAddButton").addEventListener("click", () => newNote(currentSelection()));
  byId("reviewNoteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!note || writing) return;
    const submit = byId("reviewNoteSubmit");
    submit.disabled = true;
    try {
      const result = await change({ kind: "create", ...note, type: byId("reviewNoteType").value, text: byId("reviewNoteText").value });
      if (result?.selected) { noteDialog.close(); choose(result.selected); }
    } catch (error) { byId("reviewNoteError").textContent = error.message; }
    finally { submit.disabled = false; }
  });
  selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionButton.addEventListener("click", async () => {
    if (locating && floating?.file) {
      const result = await safeChange({ kind: "locate", id: locating, anchor: floating });
      if (result) { hideSelection(); locating = ""; choose(result.selected, { jump: true }); }
    } else newNote(floating);
  });
  document.addEventListener("pointerdown", (event) => { if (!selectionButton.contains(event.target)) hideSelection(); });
  byId("reviewExportButton").addEventListener("click", async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      await beforeWrite();
      await download("/api/reviews/export-pdf", { method: "POST" }, "review.pdf");
      notify("审阅版 PDF 已生成。", "success");
      invalidate();
    } catch (error) { notify(error.message, "info", 6500); }
    finally { control.disabled = false; }
  });
  byId("reviewRepliesButton").addEventListener("click", () => download("/api/reviews/replies", {}, "review-replies.md")
    .catch((error) => notify(error.message, "error")));

  return {
    load, invalidate, all, choose, newNote, showSelection, hideSelection, importFile, decorateRows,
    renderPdf: (target, options) => renderReviewMarks(target, all(), { ...options, selected, choose, icons })
  };
}

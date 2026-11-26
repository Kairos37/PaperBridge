import { isPreprint, referenceAuthorLabel, referenceDoi, referenceTypeLabel, referenceVenueDisplay } from "./reference-data.js";
import { mountReferenceImportDialog } from "./reference-import-dialog.js";
import {
  addressIsReferenceInput, highlightReferenceWords, referenceDetailIdentity, referenceIssueTags, referenceSearchTerms,
  refButton, refIcon, refNode, refSection, renderReferenceDetail
} from "./reference-view.js";

export function mountReferenceWorkbench({
  api, project, bibTargets, showWorkbench, insert, hasCitationTarget, gotoCitation, gotoSource, beforeWrite, afterWrite, notify, icons, dragType
}) {
  const byId = (id) => document.getElementById(id);
  const root = byId("referencesView");
  const list = byId("referencesList");
  const detail = byId("referenceDetail");
  const search = byId("referencesSearch");
  const insertSearch = byId("referenceInsertSearch");
  const insertList = byId("referenceInsertList");
  const health = byId("referenceHealth");
  const issueSummary = byId("referenceFilterContext");
  const sort = byId("referenceSort");
  const from = byId("referenceYearFrom");
  const to = byId("referenceYearTo");
  const type = byId("referenceTypeFilter");
  const filters = new Set();
  let data = null;
  let projectId = "";
  let generation = 0;
  let request = null;
  let dirty = true;
  let refreshTimer = 0;
  let selectedId = "";
  let selectedMissingKey = "";
  let issueMode = "";
  let readError = "";
  let detailFingerprint = "";
  let writing = false;
  let flashTimer = 0;
  let lookupByKey = new Map();

  const importer = mountReferenceImportDialog({
    api, data: () => data, load: () => load({ render: false }), project, bibTargets, beforeWrite, hasCitationTarget,
    onResult: acceptMutation, select: (entry) => void openReference(entry), insert, notify, icons
  });

  function resetControls() {
    search.value = "";
    from.value = "";
    to.value = "";
    type.value = "";
    issueMode = "";
    filters.clear();
    selectedMissingKey = "";
  }

  function syncProject() {
    const key = project();
    if (key === projectId) return;
    projectId = key;
    generation++;
    data = null;
    lookupByKey = new Map();
    dirty = true;
    readError = "";
    selectedId = "";
    detailFingerprint = "";
    resetControls();
  }

  function setData(payload) {
    data = payload;
    dirty = false;
    readError = "";
    lookupByKey = new Map();
    for (const entry of data.entries) if (!lookupByKey.has(entry.key)) lookupByKey.set(entry.key, entry);
  }

  async function load({ force = false, render = true } = {}) {
    syncProject();
    if (data && !dirty && !force) {
      if (render) renderAll();
      return data;
    }
    if (!projectId) {
      if (render) {
        renderAll();
        byId("referencesMeta").textContent = "请先打开论文项目";
      }
      return null;
    }
    if (request?.generation === generation) {
      const payload = await request.promise;
      if (render) renderAll();
      return payload;
    }
    if (!data && render) {
      readError = "";
      renderAll();
    }
    const ownGeneration = generation;
    const promise = api("/api/references").then((payload) => {
      if (generation !== ownGeneration || project() !== projectId) return null;
      setData(payload);
      return data;
    }).catch((error) => {
      if (generation !== ownGeneration) return null;
      readError = error.message;
      return null;
    });
    const pending = { generation: ownGeneration, promise };
    request = pending;
    const payload = await promise;
    if (request === pending) request = null;
    if (render || !root.classList.contains("hidden")) renderAll();
    return payload;
  }

  function invalidate() {
    syncProject();
    dirty = true;
    generation++;
    window.clearTimeout(refreshTimer);
    if (!root.classList.contains("hidden")) refreshTimer = window.setTimeout(() => void load(), 140);
  }

  function entryMatches(entry, terms) {
    const info = referenceDetailIdentity(entry);
    const haystack = [entry.key, info.title, info.author, info.venue, info.year, info.type, entry.shortVenue,
      entry.notes?.translatedTitle, ...(entry.notes?.tags || []), ...Object.values(entry.fields)].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  function matching(query) {
    const terms = referenceSearchTerms(query);
    return (data?.entries || []).filter((entry) => entryMatches(entry, terms));
  }

  function incomplete(entry) {
    return Boolean(entry.warnings?.required?.length || entry.warnings?.recommended?.length);
  }

  const issueTests = {
    unused: (entry) => !entry.cited,
    fields: incomplete,
    duplicate: (entry) => Boolean(entry.duplicateIds?.length),
    preprint: isPreprint,
    format: (entry) => Boolean(entry.formatIssues?.length)
  };

  function typeOf(entry) {
    return isPreprint(entry) ? "preprint" : entry.type;
  }

  function visibleEntries() {
    let result = matching(search.value);
    const active = [...filters, issueMode].filter((name) => issueTests[name]);
    const first = Number(from.value) || 0;
    const last = Number(to.value) || 0;
    result = result.filter((entry) => {
      const year = Number(entry.year) || 0;
      return (!first || year >= first) && (!last || (year && year <= last))
        && (!type.value || typeOf(entry) === type.value) && active.every((name) => issueTests[name](entry));
    });
    const key = sort.value;
    if (key === "year") result.sort((left, right) => (Number(right.year) || 0) - (Number(left.year) || 0) || left.number - right.number);
    else if (key === "author") result.sort((left, right) => {
      const a = left.authors?.[0]?.family || "";
      const b = right.authors?.[0]?.family || "";
      return Number(!a) - Number(!b) || a.localeCompare(b, undefined, { sensitivity: "base" }) || left.number - right.number;
    });
    else if (key === "added") result.sort((left, right) => String(right.addedAt || "").localeCompare(String(left.addedAt || "")) || right.bibOrder - left.bibOrder);
    return result;
  }

  function highlightNewRow(entry) {
    window.clearTimeout(flashTimer);
    const visibleList = byId("referenceInsertDialog").open ? insertList : list;
    const row = [...visibleList.querySelectorAll(".reference-row")].find((node) => node.dataset.referenceId === entry.id);
    row?.scrollIntoView({ block: "nearest" });
    row?.classList.add("reference-arrived");
    flashTimer = window.setTimeout(() => row?.classList.remove("reference-arrived"), 1200);
  }

  function select(entry, { reveal = false } = {}) {
    if (!entry) return;
    if (reveal) resetControls();
    selectedId = entry.id;
    if (reveal) {
      renderAll();
      highlightNewRow(entry);
    } else {
      for (const row of list.querySelectorAll(".reference-row")) {
        const active = row.dataset.referenceId === entry.id;
        row.classList.toggle("active", active);
        row.querySelector(".reference-row-main")?.setAttribute("aria-current", String(active));
      }
      renderSelected(entry);
      icons();
    }
  }

  async function openReference(reference) {
    const payload = await load({ render: false });
    showWorkbench();
    if (!payload) return;
    const entry = typeof reference === "string" ? lookupByKey.get(reference)
      : payload.entries.find((item) => item.id === reference.id) || lookupByKey.get(reference.key);
    if (entry) {
      select(entry, { reveal: true });
      return;
    }
    const key = String(reference);
    const missing = payload.missing.find((item) => item.key === key);
    if (missing) {
      resetControls();
      issueMode = "missing";
      selectedMissingKey = key;
      renderAll();
    } else importer.open("", { key });
  }

  async function copy(entry) {
    try {
      await navigator.clipboard.writeText("\\cite{" + entry.key + "}");
      notify("已复制 \\cite{" + entry.key + "}。", "success");
    } catch (error) {
      notify("无法复制引用，请从详情复制 citation key。", "error");
    }
  }

  function rowBody(entry, terms, includeTags) {
    const body = refNode("span", "reference-row-body");
    const info = referenceDetailIdentity(entry);
    const title = refNode("span", "reference-row-title");
    title.title = info.title;
    highlightReferenceWords(title, info.title, terms);
    const meta = refNode("span", "reference-row-meta");
    const author = refNode("span");
    author.title = info.author || "作者未知";
    highlightReferenceWords(author, referenceAuthorLabel(entry), terms);
    const venue = refNode("span");
    const display = referenceVenueDisplay(info.venue, entry.year);
    venue.title = [display.title, entry.year || "年份未注明"].filter(Boolean).join(" · ");
    const shortVenue = display.short && entry.year && display.short.endsWith(" " + entry.year) ? display.short.slice(0, -5) : display.short;
    highlightReferenceWords(venue, shortVenue || (entry.year ? "" : "年份未注明"), terms);
    meta.append(author, refNode("span", "reference-meta-dot", "·"));
    if (venue.textContent) {
      venue.className = "reference-meta-venue";
      meta.append(venue);
    }
    if (entry.year) {
      const year = refNode("span", "reference-meta-year");
      highlightReferenceWords(year, entry.year, terms);
      meta.append(year);
    }
    body.append(title, meta);
    if (terms.length) {
      const visibleText = [info.title, author.textContent, venue.textContent].join(" ").toLowerCase();
      const hiddenMatches = terms.filter((term) => !visibleText.includes(term));
      if (hiddenMatches.length) {
        const fields = [["引用名", entry.key], ["DOI", entry.fields.doi], ["作者", info.author], ["刊会", info.venue], ["中文标题", entry.notes?.translatedTitle]];
        const matchingField = fields.find(([, value]) => value && hiddenMatches.some((term) => value.toLowerCase().includes(term)));
        if (matchingField) {
          const note = refNode("span", "reference-search-context");
          highlightReferenceWords(note, matchingField.join(" · "), terms);
          note.title = matchingField[1];
          body.append(note);
        }
      }
    }
    if (includeTags) {
      const tags = referenceIssueTags(entry);
      if (tags.length) {
        const line = refNode("span", "reference-status-list");
        for (const [kind, text] of tags) line.append(refNode("span", "reference-status-tag " + kind, text));
        body.append(line);
      }
    }
    return body;
  }

  function renderRow(entry, terms, compact = false) {
    const row = refNode(compact ? "button" : "article", "reference-row" + (compact ? " compact" : ""));
    row.dataset.referenceId = entry.id;
    row.dataset.referenceKey = entry.key;
    const active = entry.id === selectedId;
    const order = refNode("span", "reference-order" + (entry.cited ? "" : " uncited"), "#" + entry.number);
    if (!entry.cited) order.title = "尚未引用";
    const body = rowBody(entry, terms, !compact);
    if (compact) {
      row.type = "button";
      row.classList.toggle("active", active);
      row.setAttribute("aria-current", String(active));
      row.append(order, body);
      row.addEventListener("click", () => {
        const dialog = byId("referenceInsertDialog");
        dialog.close();
        if (insert(entry)) selectedId = entry.id;
        else dialog.showModal();
      });
      return row;
    }
    row.draggable = true;
    row.classList.toggle("active", active);
    const main = refNode("button", "reference-row-main");
    main.type = "button";
    main.setAttribute("aria-current", String(active));
    main.append(order, body);
    main.addEventListener("click", () => select(entry));
    main.addEventListener("dblclick", () => insert(entry));
    const controls = refNode("div", "reference-row-actions");
    controls.append(refButton("插入引用", () => insert(entry), { icon: "quote", iconOnly: true, title: "插入引用，也可拖入编辑器" }));
    const menu = refNode("details", "reference-row-menu");
    const trigger = refNode("summary", "reference-menu-trigger");
    trigger.title = "更多文献操作";
    trigger.setAttribute("aria-label", "更多文献操作");
    trigger.append(refIcon("ellipsis"));
    const actions = refNode("div", "reference-row-menu-items");
    for (const [label, icon, run] of [
      ["复制引用", "copy", () => copy(entry)],
      ["跳到 Bib 源码", "external-link", () => gotoSource(entry)],
      ["编辑", "pencil", () => importer.edit(entry)],
      ["删除", "trash-2", () => remove(entry)]
    ]) {
      actions.append(refButton(label, () => { menu.open = false; void run(); }, { icon, className: "reference-action" + (label === "删除" ? " reference-action-danger" : "") }));
    }
    menu.append(trigger, actions);
    controls.append(menu);
    row.append(main, controls);
    row.addEventListener("dragstart", (event) => {
      select(entry);
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(dragType, entry.key);
      event.dataTransfer.setData("text/plain", "\\cite{" + entry.key + "}");
      const preview = refNode("div", "citation-drag-preview", "\\cite{" + entry.key + "}");
      document.body.append(preview);
      event.dataTransfer.setDragImage(preview, 18, 18);
      window.setTimeout(() => preview.remove(), 0);
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".citation-drop-target").forEach((node) => node.classList.remove("citation-drop-target"));
    });
    return row;
  }

  function missingMatches() {
    const terms = referenceSearchTerms(search.value);
    return (data?.missing || []).filter((item) => {
      const searchText = [item.key, item.file, item.context].join(" ").toLowerCase();
      return terms.every((term) => searchText.includes(term));
    });
  }

  function renderMissing(item) {
    detailFingerprint = "";
    detail.replaceChildren();
    if (!item) {
      detail.append(refNode("div", "empty-state", "没有待补齐的引用名。"));
      return;
    }
    const header = refNode("header", "reference-detail-header");
    header.append(refNode("h2", "", item.key), refNode("p", "reference-detail-meta", "正文使用了这个引用名，Bib 文件中缺少对应条目。"));
    const actions = refNode("div", "reference-detail-actions");
    actions.append(refButton("用此 key 导入", () => importer.open("", { key: item.key }), { icon: "plus", className: "reference-action reference-action-primary" }));
    if (item.candidateKey) actions.append(refButton("改为 " + item.candidateKey, () => void mutate("repair-key", null, { key: item.key, targetKey: item.candidateKey }), { icon: "wand-sparkles" }));
    header.append(actions);
    if (!item.candidateKey && data.entries.length) {
      const form = refNode("div", "reference-missing-repair");
      const options = refNode("select");
      options.setAttribute("aria-label", "改用现有文献");
      options.append(new Option("选择库中条目", ""));
      for (const entry of lookupByKey.values()) options.append(new Option("#" + entry.number + " " + (entry.title || entry.key), entry.key));
      const replace = refButton("替换全部引用", () => void mutate("repair-key", null, { key: item.key, targetKey: options.value }), { icon: "arrow-right-left" });
      replace.disabled = true;
      options.addEventListener("change", () => { replace.disabled = !options.value; });
      form.append(options, replace);
      header.append(form);
    }
    detail.append(header);
    const section = refSection("引用位置");
    for (const location of item.locations || [item]) {
      const link = refButton(location.file + ":" + location.line + (location.paragraph ? " · P" + String(location.paragraph).padStart(2, "0") : ""), () => gotoCitation(location), { icon: "corner-down-right" });
      const block = refNode("div", "reference-missing-context");
      block.append(link, refNode("p", "", location.context));
      section.append(block);
    }
    detail.append(section);
  }

  function renderList() {
    list.replaceChildren();
    for (const button of root.querySelectorAll("[data-reference-filter]")) {
      button.setAttribute("aria-pressed", String(filters.has(button.dataset.referenceFilter) || issueMode === button.dataset.referenceFilter));
    }
    if (!data) {
      byId("referencesCount").textContent = "";
      list.append(refNode("div", "empty-state", readError ? readError : "正在读取参考文献…"));
      if (readError) list.append(refButton("重试", () => void load({ force: true }), { icon: "refresh-cw" }));
      renderSelected(null);
      return;
    }
    const terms = referenceSearchTerms(search.value);
    if (issueMode === "missing") {
      const missing = missingMatches();
      byId("referencesCount").textContent = missing.length + "/" + data.missing.length;
      if (!missing.some((item) => item.key === selectedMissingKey)) selectedMissingKey = missing[0]?.key || "";
      for (const item of missing) {
        const row = refButton("", () => {
          selectedMissingKey = item.key;
          renderList();
          icons();
        }, { className: "reference-row reference-missing-row" });
        row.classList.toggle("active", item.key === selectedMissingKey);
        row.setAttribute("aria-current", String(item.key === selectedMissingKey));
        const key = refNode("strong", "reference-row-title");
        highlightReferenceWords(key, item.key, terms);
        row.append(key, refNode("span", "reference-row-meta", item.file + ":" + item.line));
        list.append(row);
      }
      if (!missing.length) list.append(refNode("div", "empty-state", "没有匹配的缺失 key。"));
      renderMissing(missing.find((item) => item.key === selectedMissingKey));
      return;
    }
    const entries = visibleEntries();
    byId("referencesCount").textContent = entries.length + "/" + data.entries.length;
    if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id || "";
    for (const entry of entries) list.append(renderRow(entry, terms));
    if (!entries.length) {
      const empty = refNode("div", "empty-state reference-empty-list", data.entries.length ? "没有匹配的文献。" : "当前项目还没有参考文献。");
      if (addressIsReferenceInput(search.value)) {
        empty.append(refButton(/(?:doi:)?\s*10\.\d+\//i.test(search.value) ? "作为 DOI 导入" : "作为链接导入",
          () => importer.open(search.value, { autoLookup: true }), { icon: "plus", className: "reference-action reference-action-primary" }));
      } else if (!data.entries.length) empty.append(refButton("新增参考文献", () => importer.open(""), { icon: "plus" }));
      list.append(empty);
    }
    renderSelected(entries.find((entry) => entry.id === selectedId));
  }

  function renderInsert() {
    const terms = referenceSearchTerms(insertSearch.value);
    const entries = matching(insertSearch.value);
    insertList.replaceChildren(...entries.map((entry) => renderRow(entry, terms, true)));
    if (!entries.length) insertList.append(refNode("div", "empty-state", data?.entries.length ? "没有匹配的文献。" : "当前没有可插入的文献。"));
    icons();
  }

  function renderHealth() {
    health.replaceChildren();
    issueSummary.replaceChildren();
    issueSummary.classList.add("hidden");
    if (!data) return;
    const counts = [
      ["", data.entries.length + " 篇文献", ""],
      ["unused", data.unused.length + " 未引用", "muted"],
      ["duplicate", data.duplicateGroups.length + " 组疑似重复", "warning"],
      ["fields", data.entries.filter(incomplete).length + " 缺字段", "warning"],
      ["missing", data.missing.length + " 缺失 key", "danger"],
      ["preprint", data.entries.filter(isPreprint).length + " 预印本", "muted"],
      ["format", data.entries.filter(issueTests.format).length + " 格式", "muted"]
    ];
    for (const [mode, label, tone] of counts) {
      const button = refButton(label, () => {
        if (!mode) resetControls();
        else {
          const nextMode = issueMode === mode ? "" : mode;
          resetControls();
          issueMode = nextMode;
        }
        renderAll();
      }, { className: "reference-health-item " + tone });
      button.setAttribute("aria-pressed", String(issueMode === mode));
      health.append(button);
    }
    if (issueMode === "format" && data.entries.some(issueTests.format)) {
      issueSummary.classList.remove("hidden");
      issueSummary.append(refNode("span", "", "统一会议名、页码与标题大小写"), refButton("一键统一格式", () => void mutate("normalize", null, { all: true }), { icon: "wand-sparkles" }));
    }
  }

  function renderAlerts() {
    const container = byId("referencesAlerts");
    container.replaceChildren();
    if (!data) return;
    const key = "paperBridge.dismissedReferenceAlerts:" + projectId;
    let dismissed;
    try { dismissed = new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
    catch { dismissed = new Set(); }
    const alerts = [];
    if (!data.bibliographyFiles.length) alerts.push(["warning", "当前项目还没有检测到 .bib 文件。"]);
    if (data.missing.length) {
      const sample = data.missing.slice(0, 5).map((item) => item.key + "（" + item.file + ":" + item.line + "）").join("，");
      alerts.push(["error", "正文中有 " + data.missing.length + " 个 citation key 找不到 BibTeX：" + sample + (data.missing.length > 5 ? "…" : "")]);
    }
    if (data.unused.length) alerts.push(["muted", "Bib 文件中有 " + data.unused.length + " 篇暂未被正文引用：" + data.unused.slice(0, 5).join("，") + (data.unused.length > 5 ? "…" : "")]);
    if (data.duplicates.length) alerts.push(["warning", "检测到 " + data.duplicates.length + " 组疑似重复文献：" + data.duplicates.slice(0, 3).map((group) => group.join(" / ")).join("；") + (data.duplicates.length > 3 ? "…" : "")]);
    for (const [tone, message] of alerts) {
      const id = JSON.stringify([tone, message]);
      if (dismissed.has(id)) continue;
      const node = refNode("div", "references-alert " + tone);
      const close = refButton("关闭此提示，不再显示", () => {
        dismissed.add(id);
        localStorage.setItem(key, JSON.stringify([...dismissed]));
        node.remove();
      }, { icon: "x", iconOnly: true, className: "reference-alert-dismiss" });
      node.append(refNode("span", "", message), close);
      container.append(node);
    }
  }

  function renderAll() {
    if (data) {
      const current = type.value;
      const types = new Map(data.entries.map((entry) => [typeOf(entry), referenceTypeLabel(entry)]));
      type.replaceChildren(new Option("全部类型", ""));
      for (const [value, label] of types) type.append(new Option(label, value));
      type.value = types.has(current) ? current : "";
    }
    byId("referencesMeta").textContent = data ? (data.bibliographyFiles.join("，") || "未检测到 Bib 文件")
      : readError ? "参考文献读取失败" : "正在读取 Bib 文件和正文引用…";
    renderHealth();
    renderList();
    renderAlerts();
    if (byId("referenceInsertDialog").open) renderInsert();
    icons();
  }

  function renderSelected(entry) {
    const fingerprint = JSON.stringify([entry, data?.style]);
    if (fingerprint === detailFingerprint) return;
    detailFingerprint = fingerprint;
    renderReferenceDetail(detail, entry, data, {
      gotoCitation, gotoSource, insert, copy, edit: (item) => importer.edit(item), remove, merge,
      enrich: (item) => importer.update(item, "fill"), findPublication: (item) => importer.update(item, "published"),
      normalize: (item) => void mutate("normalize", item),
      select: (item) => select(item, { reveal: true }),
      saveNotes: (item, notes) => mutate("notes", item, { notes }),
      translate: (item) => api("/api/references/translate-metadata", {
        method: "POST", body: JSON.stringify({ id: item.id, rawHash: item.rawHash })
      })
    });
    detail.scrollTop = 0;
    if (entry) detail.dataset.referenceId = entry.id;
    else delete detail.dataset.referenceId;
  }

  async function acceptMutation(result, { added = false, selectKey = "" } = {}) {
    generation++;
    window.clearTimeout(refreshTimer);
    await afterWrite(result);
    setData(result.references);
    if (added || selectKey) resetControls();
    if (added && byId("referenceInsertDialog").open) insertSearch.value = "";
    const chosen = result.selected || (result.entry ? { file: result.file, key: result.entry.key } : null);
    if (chosen) {
      const match = data.entries.find((entry) => entry.key === chosen.key && entry.file === chosen.file);
      if (match) selectedId = match.id;
    }
    detailFingerprint = "";
    renderAll();
    const entry = data.entries.find((item) => item.id === selectedId);
    if ((added || selectKey) && entry) highlightNewRow(entry);
    return entry;
  }

  async function mutate(action, entry, options = {}) {
    if (writing) return null;
    writing = true;
    try {
      if (action !== "notes") await beforeWrite();
      const result = await api("/api/references/change", {
        method: "POST",
        body: JSON.stringify({ action, id: entry?.id, rawHash: entry?.rawHash, ...options })
      });
      await acceptMutation(result);
      notify(action === "notes" ? "笔记已保存。" : "参考文献已更新。", "success");
      return result;
    } catch (error) {
      notify(error.message, "error", 5200);
      return null;
    } finally {
      writing = false;
    }
  }

  function remove(entry) {
    const count = entry.locations?.length || 0;
    const message = "删除「" + entry.title + "」？" + (count ? "正文还有 " + count + " 处引用将缺少对应条目。" : "")
      + "\n可按 Ctrl+Z 撤销。";
    if (window.confirm(message)) void mutate("delete", entry, { confirmed: true });
  }

  function merge(from, keep) {
    if (!window.confirm("将 #" + from.number + " 合并到 #" + keep.number + "「" + keep.title + "」？\n正文引用会使用 " + keep.key + "，可按 Ctrl+Z 撤销。")) return;
    void mutate("merge", from, { keepId: keep.id, keepHash: keep.rawHash, confirmed: true });
  }

  function refilter() {
    renderList();
    icons();
  }

  search.addEventListener("input", refilter);
  for (const control of [sort, from, to, type]) control.addEventListener("input", refilter);
  byId("clearReferenceFilters").addEventListener("click", (event) => {
    event.currentTarget.closest("details").open = false;
    const query = search.value;
    resetControls();
    search.value = query;
    renderAll();
  });
  for (const button of root.querySelectorAll("[data-reference-filter]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.referenceFilter;
      if (issueMode === value || issueMode === "missing") issueMode = "";
      else if (filters.has(value)) filters.delete(value);
      else filters.add(value);
      renderAll();
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of root.querySelectorAll(".reference-row-menu[open], .reference-filter-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  insertSearch.addEventListener("input", renderInsert);
  byId("referenceAddButton").addEventListener("click", () => importer.open(search.value));
  byId("referenceInsertAddButton").addEventListener("click", () => importer.open(insertSearch.value));
  return { load, invalidate, entry: (key) => lookupByKey.get(key), matching, openReference, renderInsert };
}


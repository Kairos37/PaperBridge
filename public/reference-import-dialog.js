import {
  BIB_KEY_PATTERN, bibliographyFieldIssues, formatNewReference, isPreprint, parseBibliography,
  referenceAuthorLabel, referenceDoi, referenceIdentityMatches, referenceTypeLabel,
  suggestReferenceKey, texReferenceText, toBibTeX
} from "./reference-data.js";
import { addressIsReferenceInput, refButton, refNode, referenceDetailIdentity } from "./reference-view.js";

const FIELD_NAMES = {
  title: "论文标题", author: "作者", year: "年份", booktitle: "会议 / 书名", journal: "期刊名称",
  publisher: "出版社", institution: "机构", school: "学校", volume: "卷号", number: "期号",
  pages: "页码", doi: "DOI", url: "链接", eprint: "arXiv 编号"
};
const CORE_FIELDS = ["title", "author", "year"];
const FIELDS_BY_TYPE = {
  inproceedings: ["booktitle", "pages", "doi"],
  article: ["journal", "volume", "number", "pages", "doi"],
  book: ["publisher", "doi"],
  incollection: ["booktitle", "publisher", "pages", "doi"],
  phdthesis: ["school", "doi"],
  mastersthesis: ["school", "doi"],
  techreport: ["institution", "number", "doi"],
  preprint: ["eprint", "doi"],
  misc: ["url", "doi"]
};

function replaceKey(raw, key) {
  return raw.replace(/^(@[A-Za-z]+\s*[({]\s*)[^,\s]+(\s*,)/, (_, before, after) => before + key + after);
}

function normalizeManualValue(field, value) {
  const text = value.trim();
  if (field === "url" || field === "doi") return text;
  return text.replace(/(^|[^\\])([&%#_])/g, "$1\\$2");
}

export function mountReferenceImportDialog({ api, data, load, project, bibTargets, beforeWrite, hasCitationTarget, onResult, select, insert, notify, icons }) {
  const el = (id) => document.getElementById(id);
  const dialog = el("referenceAddDialog");
  const form = el("referenceAddForm");
  const submit = el("addReferenceButtonSubmit");
  const cite = el("addAndCiteReferenceButton");
  const status = el("referenceAddStatus");
  const doiInput = el("referenceAddUrl");
  const keyInput = el("referenceAddKey");
  const rawInput = el("referenceAddBib");
  const destination = el("referenceAddBibFile");
  const preview = el("referenceImportPreview");
  const candidates = el("referenceImportCandidates");
  const rule = el("referenceKeyRule");
  const manualType = el("referenceManualType");
  const titleInput = el("referenceTitleQuery");
  const bibInput = el("referencePasteBib");
  const bulkInput = el("referenceBulkDoi");
  let mode = "doi";
  let rows = [];
  let current = -1;
  let request = 0;
  let fetching = false;
  let saving = false;
  let forcedKey = "";
  let purpose = "add";
  let sourceEntry = null;
  let manualValues = {};
  let draftProject = "";
  let inputTimer = 0;
  let rawError = "";
  let manualKey = "";

  function announce(message = "", tone = "") {
    status.textContent = message;
    status.className = "reference-add-status" + (message ? "" : " hidden") + (tone ? " " + tone : "");
  }

  function setFiles(files, preferred = "") {
    const available = [...new Set([...(files || []), ...bibTargets()])];
    if (!available.length) available.push("references.bib");
    if (sourceEntry && !available.includes(sourceEntry.file)) available.push(sourceEntry.file);
    const selected = preferred || destination.value || available[0];
    destination.replaceChildren(...available.map((file) => new Option(file, file)));
    destination.value = available.includes(selected) ? selected : available[0];
    const wrapper = el("referenceBibTarget");
    if (available.length > 1) el("referenceImportMultipleFiles").append(wrapper);
    else el("referenceImportAdvanced").querySelector(".reference-add-grid").prepend(wrapper);
    wrapper.classList.toggle("hidden", purpose !== "add");
  }

  function occupiedKeys(excluding) {
    return [...(data()?.entries || []).filter((entry) => entry.id !== sourceEntry?.id).map((entry) => entry.key),
      ...rows.filter((row) => row !== excluding).map((row) => row.entry.key)];
  }

  function formats(row) {
    const entry = row.entry;
    const values = bibliographyFieldIssues(entry);
    const known = (data()?.entries || []).filter((item) => item.id !== sourceEntry?.id);
    const keyConflict = [...known, ...rows.filter((item) => item !== row && item.selected).map((item) => item.entry)]
      .some((item) => item.key.toLowerCase() === entry.key.toLowerCase());
    const duplicates = purpose === "add" ? known.filter((item) => referenceIdentityMatches(item, entry)) : [];
    return {
      ...values, keyConflict, duplicates,
      sameDoi: duplicates.some((item) => referenceDoi(item.fields.doi) && referenceDoi(item.fields.doi) === referenceDoi(entry.fields.doi) && isPreprint(item) === isPreprint(entry)),
      invalid: !BIB_KEY_PATTERN.test(entry.key) || !entry.fields.title?.trim() || row.invalid
    };
  }

  function updateButtons() {
    const selected = rows.filter((row) => row.selected);
    const usable = selected.length && selected.every((row) => {
      const result = formats(row);
      return !result.invalid && !result.keyConflict && !result.sameDoi && (!result.duplicates.length || row.allowDuplicate);
    });
    submit.disabled = !usable || fetching || saving || Boolean(rawError);
    submit.textContent = purpose !== "add" ? "保存到 Bib 文件" : selected.length > 1 ? "加入 " + selected.length + " 篇文献" : "加入 Bib 文件";
    const insertable = purpose === "add" && selected.length === 1 && rows.length > 0;
    cite.classList.toggle("hidden", !insertable);
    cite.disabled = submit.disabled || !hasCitationTarget();
    cite.title = hasCitationTarget() ? "加入并插入到记住的光标位置" : "先在正文编辑器中放置光标";
  }

  function renderCandidates() {
    candidates.replaceChildren();
    candidates.classList.toggle("hidden", !rows.length || (rows.length === 1 && mode !== "title"));
    if (candidates.classList.contains("hidden")) return;
    const single = mode === "title" || purpose !== "add";
    rows.forEach((row, index) => {
      const item = refNode("div", "reference-import-option" + (index === current ? " active" : ""));
      if (!single) {
        const checkbox = refNode("input");
        checkbox.type = "checkbox";
        checkbox.checked = row.selected;
        checkbox.setAttribute("aria-label", "选择 " + (row.entry.fields.title || row.entry.key));
        checkbox.addEventListener("change", () => {
          row.selected = checkbox.checked;
          pick(index, false);
        });
        item.append(checkbox);
      }
      const button = refButton("", () => pick(index), { className: "reference-import-option-title" });
      button.setAttribute("aria-pressed", String(index === current));
      button.replaceChildren(
        refNode("strong", "", texReferenceText(row.entry.fields.title) || row.entry.key),
        refNode("span", "", [referenceAuthorLabel(row.entry), row.entry.fields.year, row.entry.fields.booktitle || row.entry.fields.journal, row.metadata?.source].filter(Boolean).join(" · "))
      );
      item.append(button);
      if (formats(row).duplicates.length) item.append(refNode("span", "reference-status-tag duplicate", "疑似重复"));
      candidates.append(item);
    });
  }

  function renderWarnings(row) {
    const node = el("referenceImportWarnings");
    node.replaceChildren();
    if (rawError) node.append(refNode("p", "reference-input-error", rawError));
    if (!row) return;
    const info = formats(row);
    if (!BIB_KEY_PATTERN.test(row.entry.key)) node.append(refNode("p", "reference-input-error", "请输入有效的 citation key。"));
    if (info.keyConflict) node.append(refNode("p", "reference-input-error", "这个 citation key 已被使用。"));
    if (info.required.length || info.recommended.length) {
      node.append(refNode("p", "", "缺少 " + [...info.required, ...info.recommended].map((name) => FIELD_NAMES[name] || name).join("、")));
    }
    for (const duplicate of info.duplicates.slice(0, 4)) {
      const line = refNode("div", "reference-duplicate-line");
      line.append(refNode("span", "", "已存在于 #" + duplicate.number + " "),
        refButton("查看", () => { dialog.close(); select(duplicate); }, { className: "reference-source-link", title: duplicate.title }));
      node.append(line);
    }
    if (info.sameDoi) node.append(refNode("p", "reference-input-error", "DOI 相同，请使用库中已有条目。"));
    else if (info.duplicates.length) {
      const confirm = refNode("label", "reference-confirm-duplicate", "这是另一条文献或版本，仍要加入");
      const check = refNode("input");
      check.type = "checkbox";
      check.checked = Boolean(row.allowDuplicate);
      check.addEventListener("change", () => {
        row.allowDuplicate = check.checked;
        if (check.checked) row.selected = true;
        renderCandidates();
        updateButtons();
      });
      confirm.prepend(check);
      node.append(confirm);
    }
  }

  function renderPreview({ syncSource = true, syncKey = true } = {}) {
    const row = rows[current];
    preview.classList.toggle("hidden", !row);
    if (!row) {
      keyInput.value = "";
      rawInput.value = "";
      updateButtons();
      return;
    }
    const { entry } = row;
    const identity = referenceDetailIdentity(entry);
    const card = el("referenceImportIdentity");
    card.replaceChildren(refNode("h3", "", identity.title),
      refNode("p", "", identity.author || "作者未知"),
      refNode("p", "reference-detail-meta", [identity.venue, identity.year, identity.type].filter(Boolean).join(" · ")));
    if (syncKey) keyInput.value = entry.key;
    if (syncSource) rawInput.value = entry.raw;
    renderWarnings(row);
    updateButtons();
  }

  function pick(index, choose = true) {
    current = index;
    if (choose) {
      if (mode === "title" || purpose !== "add") rows.forEach((row, i) => { row.selected = index === i; });
      else rows[index].selected = true;
    }
    rawError = "";
    renderCandidates();
    renderPreview();
  }

  function openResults(resultRows, { chooseFirst = true, preselect = null } = {}) {
    rows = resultRows;
    current = -1;
    rawError = "";
    if (preselect !== null) rows.forEach((row) => { row.selected = preselect && !formats(row).duplicates.length; });
    if (rows.length && chooseFirst) {
      current = 0;
      if (preselect === null) rows[0].selected = true;
    }
    renderCandidates();
    renderPreview();
    icons();
  }

  function selectMode(next, { reset = true } = {}) {
    mode = next;
    request++;
    fetching = false;
    window.clearTimeout(inputTimer);
    if (reset) {
      openResults([]);
      announce("");
    }
    for (const button of dialog.querySelectorAll("[data-import-mode]")) button.setAttribute("aria-pressed", String(next === button.dataset.importMode));
    for (const panel of dialog.querySelectorAll("[data-import-panel]")) panel.classList.toggle("hidden", panel.dataset.importPanel !== next);
    if (next === "manual") renderManualFields();
  }

  function open(query = "", { key = "", autoLookup = false, target = null, operation = "add" } = {}) {
    form.reset();
    rows = [];
    current = -1;
    purpose = operation;
    sourceEntry = target;
    draftProject = project();
    forcedKey = key || (target?.key || "");
    manualKey = forcedKey;
    rawError = "";
    fetching = false;
    saving = false;
    manualValues = {};
    rule.value = localStorage.getItem("paperBridge.referenceKeyRule") || "author-year-title";
    el("referenceImportSource").open = false;
    el("referenceImportAdvanced").open = false;
    el("referenceAddTitle").textContent = operation === "edit" ? "编辑参考文献"
      : operation === "fill" ? "补全文献字段"
        : operation === "published" ? "查找正式发表版本" : "新增参考文献";
    dialog.querySelector(".reference-import-methods").classList.toggle("hidden", operation === "edit");
    const input = String(query || "").trim();
    const kind = operation === "edit" ? "manual" : input && !addressIsReferenceInput(input) ? "title" : "doi";
    setFiles(data()?.bibliographyFiles, target?.file);
    if (!dialog.open) dialog.showModal();
    selectMode(kind);
    if (input) (kind === "title" ? titleInput : doiInput).value = input;
    if (forcedKey && operation === "add") announce("导入后将使用引用名 " + forcedKey + "。");
    (kind === "title" ? titleInput : kind === "manual" ? manualType : doiInput).focus();
    updateButtons();
    icons();
    if (autoLookup && input) void lookup(kind);
    if (!data()) void load().then((payload) => {
      if (dialog.open && draftProject === project() && payload) {
        setFiles(payload.bibliographyFiles, sourceEntry?.file);
        renderWarnings(rows[current]);
        updateButtons();
      }
    });
  }

  function edit(entry) {
    open("", { target: entry, operation: "edit" });
    const parsed = parseBibliography(entry.raw)[0];
    if (!parsed) {
      announce("无法读取此条的 BibTeX，请从 Bib 文件源码编辑。", "error");
      return;
    }
    manualValues = { ...parsed.fields };
    if (isPreprint(parsed)) manualType.value = "preprint";
    else manualType.value = ["conference", "inbook", "online"].includes(parsed.type)
      ? ({ conference: "inproceedings", inbook: "incollection", online: "misc" })[parsed.type] : parsed.type;
    if (!manualType.value) manualType.value = "misc";
    renderManualFields();
    openResults([{ entry: { ...parsed, key: entry.key, raw: entry.raw }, metadata: {}, selected: true }]);
  }

  function update(entry, operation) {
    const doi = operation === "published" ? entry.publishedDoi : referenceDoi(entry.fields.doi);
    open(doi || entry.title, { target: entry, operation, autoLookup: true });
  }

  function importedRow(result) {
    const { metadata = {} } = result;
    let entry = { ...result.entry };
    if (!entry.fields?.title) return null;
    if (purpose === "published") {
      if (isPreprint(entry) || !(entry.fields.booktitle || entry.fields.journal)) return null;
      const knownDoi = referenceDoi(sourceEntry.publishedDoi);
      if ((!knownDoi || knownDoi !== referenceDoi(entry.fields.doi)) && !referenceIdentityMatches(sourceEntry, entry)) return null;
    }
    if (purpose === "fill") {
      if (!referenceIdentityMatches(sourceEntry, entry)) return null;
      const original = parseBibliography(sourceEntry.raw)[0];
      if (!original) return null;
      const fields = { ...original.fields };
      for (const [name, value] of Object.entries(entry.fields)) {
        if (value && !fields[name] && !["eprint", "archiveprefix", "primaryclass"].includes(name.toLowerCase())) fields[name] = value;
      }
      entry = { type: original.type, key: sourceEntry.key, fields };
    }
    const autoKey = !forcedKey;
    const key = forcedKey || suggestReferenceKey(entry, occupiedKeys(), rule.value);
    entry = { ...entry, key };
    return { entry: { ...entry, raw: toBibTeX(entry) }, metadata, autoKey, selected: false };
  }

  async function lookup(kind) {
    const value = kind === "title" ? titleInput.value.trim() : kind === "bulk" ? bulkInput.value.trim() : doiInput.value.trim();
    if (!value) {
      announce(kind === "title" ? "请输入论文标题。" : "请输入 DOI 或链接。", "warning");
      return;
    }
    if (kind === "doi" && !addressIsReferenceInput(value)) {
      announce("无法识别链接。可以切换“按标题”或“手动填写”。", "error");
      return;
    }
    const token = ++request;
    fetching = true;
    openResults([]);
    announce(kind === "title" ? "正在搜索候选文献…" : "正在获取元数据…", "waiting");
    updateButtons();
    const inputs = kind === "bulk" ? [...new Set(value.split(/\r?\n|\s+(?=(?:doi:)?10\.)/).map((input) => input.trim()).filter(Boolean))] : null;
    try {
      const endpoint = kind === "title" ? "/api/references/search" : "/api/references/lookup";
      const body = kind === "title" ? { title: value, provider: el("referenceTitleProvider").value }
        : inputs ? { urls: inputs } : { url: value };
      const result = await api(endpoint, { method: "POST", body: JSON.stringify({ ...body, keyRule: rule.value }) });
      if (request !== token || !dialog.open || draftProject !== project()) return;
      setFiles(result.bibFiles, sourceEntry?.file || destination.value || result.defaultBibFile);
      const nextRows = [];
      for (const item of result.candidates || [result]) {
        const row = importedRow(item);
        if (!row) continue;
        if (row.autoKey) {
          const key = suggestReferenceKey(row.entry, [...occupiedKeys(), ...nextRows.map((item) => item.entry.key)], rule.value);
          row.entry = { ...row.entry, key, raw: toBibTeX({ ...row.entry, key }) };
        }
        nextRows.push(row);
      }
      const failures = result.failures || [];
      if (!nextRows.length) {
        const message = failures.length ? failures.map(({ input, message }) => input + " · " + message).join("\n")
          : purpose === "published" ? "未找到标题及作者匹配的正式版本，可以切换来源。"
            : purpose === "fill" ? "没有找到已匹配的元数据，可以手动填写缺失字段。"
              : "未找到候选文献，可以更换标题、来源或手动填写。";
        announce(message, "warning");
        return;
      }
      openResults(nextRows, { chooseFirst: kind !== "title", preselect: kind === "bulk" ? true : null });
      if (purpose === "fill" && kind !== "title" && nextRows.length === 1) {
        announce("已补入可用字段，请核对后保存。", "success");
      } else {
        announce(kind === "title" ? "找到 " + nextRows.length + " 条候选，请选择。"
          : ("已获取 " + nextRows.length + " 篇文献" + (failures.length ? "，" + failures.length + " 条失败\n" + failures.map((item) => item.input + " · " + item.message).join("\n") : "。")),
        failures.length ? "warning" : "success");
      }
    } catch (error) {
      if (request !== token || !dialog.open || draftProject !== project()) return;
      announce(error.message + "\n可以切换“手动填写”。", "error");
      status.append(refButton("手动填写", () => {
        if (sourceEntry) edit(sourceEntry);
        else {
          if (kind === "doi") manualValues[referenceDoi(value) ? "doi" : "url"] = value;
          if (kind === "title") manualValues.title = value;
          selectMode("manual");
          updateManual();
        }
      }, { className: "reference-source-link" }));
    } finally {
      if (request === token) {
        fetching = false;
        updateButtons();
      }
    }
  }

  function pastedBibliography(value) {
    if (!value.trim()) {
      openResults([]);
      announce("");
      return;
    }
    try {
      const entries = parseBibliography(value, { strict: true });
      if (!entries.length) throw new Error("没有找到可导入的 BibTeX 条目。");
      if (entries.length > 500) throw new Error("一次最多导入 500 篇文献。");
      const parsed = entries.filter((entry) => entry.fields.title || entry.fields.author).map((entry) => {
        const normalized = formatNewReference({ ...entry, key: forcedKey && entries.length === 1 ? forcedKey : entry.key });
        return { entry: { ...normalized, raw: toBibTeX(normalized) }, metadata: { abstract: entry.fields.abstract }, selected: true };
      });
      if (!parsed.length) throw new Error("文献条目至少需要标题或作者。");
      openResults(parsed, { preselect: true });
      announce("已识别 " + parsed.length + " 篇文献，可选择要加入的条目。", "success");
    } catch (error) {
      openResults([]);
      announce(error.message, "error");
    }
  }

  function renderManualFields() {
    const area = el("referenceManualFields");
    area.replaceChildren();
    const typeFields = FIELDS_BY_TYPE[manualType.value] || FIELDS_BY_TYPE.misc;
    for (const field of [...CORE_FIELDS, ...typeFields]) {
      const label = refNode("label", "reference-manual-field" + (["title", "author", "booktitle", "journal", "url"].includes(field) ? " wide" : ""), FIELD_NAMES[field]);
      label.title = field;
      const input = refNode("input");
      input.name = field;
      if (field === "year") input.inputMode = "numeric";
      if (field === "doi" || field === "url") input.inputMode = "url";
      if (field === "author") input.placeholder = "如 Tong, Shuai and Wang, Jiliang";
      if (field === "pages") input.placeholder = "234–246";
      input.value = manualValues[field] || "";
      input.addEventListener("input", () => {
        manualValues[field] = input.value;
        updateManual();
      });
      label.append(input);
      area.append(label);
    }
  }

  function updateManual() {
    const chosenType = manualType.value;
    const names = new Set([...CORE_FIELDS, ...(FIELDS_BY_TYPE[chosenType] || FIELDS_BY_TYPE.misc)]);
    const fields = purpose === "edit" ? { ...manualValues } : {};
    for (const name of names) {
      const value = normalizeManualValue(name, String(manualValues[name] || ""));
      if (value) fields[name] = value;
      else delete fields[name];
    }
    if (chosenType === "preprint") fields.archiveprefix = "arXiv";
    else if (chosenType !== sourceEntry?.type) {
      delete fields.archiveprefix;
      delete fields.eprinttype;
    }
    if (!fields.title) {
      openResults([]);
      return;
    }
    const model = { type: chosenType === "preprint" ? "misc" : chosenType, fields };
    const key = manualKey || suggestReferenceKey(model, occupiedKeys(rows[current]), rule.value);
    const normalized = purpose === "edit" ? { ...model, key } : formatNewReference({ ...model, key });
    const candidate = { entry: { ...normalized, raw: toBibTeX(normalized) }, selected: true, autoKey: !manualKey };
    openResults([candidate]);
  }

  function keyChanged() {
    const row = rows[current];
    if (!row) return;
    const key = keyInput.value.trim();
    row.entry = { ...row.entry, key };
    row.autoKey = false;
    if (mode === "manual") manualKey = key;
    if (BIB_KEY_PATTERN.test(key)) {
      row.entry.raw = replaceKey(row.entry.raw, key);
      rawInput.value = row.entry.raw;
    }
    renderWarnings(row);
    updateButtons();
  }

  function rawChanged() {
    const row = rows[current];
    if (!row) return;
    try {
      const entries = parseBibliography(rawInput.value, { strict: true });
      if (entries.length !== 1 || !entries[0].fields.title) throw new Error("请输入一条包含标题的 BibTeX 文献。");
      rawError = "";
      row.entry = entries[0];
      row.autoKey = false;
      if (mode === "manual") {
        manualValues = { ...row.entry.fields };
        manualKey = row.entry.key;
        renderManualFields();
      }
    } catch (error) {
      rawError = error.message;
    }
    renderPreview({ syncSource: false, syncKey: !rawError });
  }

  async function save(insertAfter) {
    if (submit.disabled || saving || (insertAfter && !hasCitationTarget())) return;
    const selected = rows.filter((row) => row.selected);
    saving = true;
    announce("正在写入 Bib 文件…", "waiting");
    updateButtons();
    try {
      await beforeWrite();
      if (draftProject !== project()) throw new Error("当前项目已切换，请重新打开文献窗口。");
      const result = purpose === "add"
        ? await api("/api/references/add", {
          method: "POST",
          body: JSON.stringify({ bibFile: destination.value, entries: selected.map((row) => ({
            raw: row.entry.raw, key: row.entry.key, metadata: row.metadata, allowDuplicate: Boolean(row.allowDuplicate)
          })) })
        })
        : await api("/api/references/change", {
          method: "POST",
          body: JSON.stringify({ action: "edit", id: sourceEntry.id, rawHash: sourceEntry.rawHash, raw: selected[0].entry.raw, key: selected[0].entry.key })
        });
      const entry = await onResult(result, { added: purpose === "add", selectKey: selected[0].entry.key });
      dialog.close();
      if (insertAfter && entry) {
        const picker = el("referenceInsertDialog");
        if (picker.open) picker.close();
        if (!insert(entry)) return;
      }
      notify(purpose === "add" ? "已写入 " + selected.length + " 篇文献。" : "已保存参考文献。", "success");
    } catch (error) {
      announce(error.message, "error");
    } finally {
      saving = false;
      updateButtons();
    }
  }

  function handleEnter(control, kind) {
    control.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (kind === "doi" && rows.length && !fetching && mode === "doi") {
        // The input can be edited after a lookup. Its input event clears the previous preview.
        return;
      }
      if (!fetching) void lookup(kind);
    });
  }

  for (const button of dialog.querySelectorAll("[data-import-mode]")) {
    button.addEventListener("click", () => {
      if (saving) return;
      if (button.dataset.importMode === "manual" && sourceEntry && purpose !== "edit") {
        edit(sourceEntry);
        return;
      }
      selectMode(button.dataset.importMode);
      if (mode === "manual") updateManual();
      dialog.querySelector('[data-import-panel="' + mode + '"] :is(input, textarea, select)')?.focus();
    });
  }
  for (const [control, kind] of [[doiInput, "doi"], [titleInput, "title"]]) {
    handleEnter(control, kind);
    control.addEventListener("input", () => {
      request++;
      fetching = false;
      openResults([]);
      announce("");
    });
  }
  doiInput.addEventListener("paste", () => window.setTimeout(() => {
    if (dialog.open && mode === "doi" && addressIsReferenceInput(doiInput.value)) void lookup("doi");
  }, 0));
  el("referenceTitleSearchButton").addEventListener("click", () => { if (!fetching) void lookup("title"); });
  bulkInput.addEventListener("paste", () => window.setTimeout(() => {
    if (dialog.open && mode === "bulk" && bulkInput.value.trim()) void lookup("bulk");
  }, 0));
  el("referenceBulkLookupButton").addEventListener("click", () => { if (!fetching) void lookup("bulk"); });
  bibInput.addEventListener("input", () => {
    window.clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => pastedBibliography(bibInput.value), 100);
  });
  el("referenceBibUpload").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const token = ++request;
    if (file.size > 4 * 1024 * 1024) {
      announce("请上传不超过 4 MB 的 .bib 文件。", "error");
      return;
    }
    try {
      const value = await file.text();
      if (request === token && dialog.open) pastedBibliography(value);
    } catch (error) {
      announce(error.message, "error");
    }
  });
  manualType.addEventListener("change", () => { renderManualFields(); updateManual(); });
  keyInput.addEventListener("input", keyChanged);
  rawInput.addEventListener("input", rawChanged);
  rule.addEventListener("change", () => {
    localStorage.setItem("paperBridge.referenceKeyRule", rule.value);
    for (const row of rows) {
      if (!row.autoKey) continue;
      const key = suggestReferenceKey(row.entry, occupiedKeys(row), rule.value);
      row.entry = { ...row.entry, key, raw: replaceKey(row.entry.raw, key) };
    }
    renderCandidates();
    renderPreview();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save(event.submitter === cite);
  });
  for (const id of ["closeReferenceAddButton", "cancelReferenceAddButton"]) el(id).addEventListener("click", () => { if (!saving) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    request++;
    fetching = false;
    window.clearTimeout(inputTimer);
  });
  return { open, edit, update };
}


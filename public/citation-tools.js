import { CITE_COMMAND_NAME, CITE_OPEN_PATTERN, findCitationCommands, referenceAuthorLabel, referenceVenueDisplay } from "./reference-data.js";
import { highlightReferenceWords, refNode, referenceDetailIdentity, referenceSearchTerms } from "./reference-view.js";

const openCitation = new RegExp(CITE_OPEN_PATTERN + "([^{}]*)$", "i");
const mayContainCite = new RegExp("\\\\" + CITE_COMMAND_NAME + "\\b", "i");

function contextAtCaret(textarea) {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd || caret < 6) return null;
  const before = textarea.value.slice(Math.max(0, caret - 640), caret);
  const match = openCitation.exec(before);
  if (!match) return null;
  const lineStart = before.lastIndexOf("\n", match.index - 1) + 1;
  if (/(?:^|[^\\])%/.test(before.slice(lineStart, match.index)) || /%/.test(match[1])) return null;
  const fragment = match[1].split(",").at(-1);
  const leading = /^\s*/.exec(fragment)[0];
  const needle = fragment.slice(leading.length).trim();
  const next = textarea.value.slice(caret);
  const tail = /^[A-Za-z0-9_.:+/-]*(?=\s*[,}])/.exec(next)?.[0] || "";
  const terminator = next.slice(tail.length).match(/^\s*([,}])/)?.[1];
  return { commandStart: caret - before.length + match.index, start: caret - fragment.length + leading.length, end: caret + tail.length, needle, terminator };
}

function referenceAtPointer(textarea, offset) {
  const start = Math.max(0, offset - 320);
  const text = textarea.value.slice(start, offset + 320);
  for (const match of findCitationCommands(text)) {
    const [left, right] = match.indices[0];
    if (offset < start + left || offset > start + right) continue;
    const prefix = text.slice(text.lastIndexOf("\n", left - 1) + 1, left);
    if (/(?:^|[^\\])%/.test(prefix)) return "";
    const groupStart = start + match.indices[1][0];
    const hits = [...match[1].matchAll(/[^\s,]+/g)];
    return hits.find((token) => offset >= groupStart + token.index && offset <= groupStart + token.index + token[0].length)?.[0]
      || hits[0]?.[0] || "";
  }
  return "";
}

function textareaAnchor(textarea) {
  const bounds = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const mirror = refNode("div", "citation-caret-mirror");
  mirror.style.width = textarea.clientWidth + "px";
  for (const name of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "tab-size",
    "overflow-wrap", "word-break", "text-align", "white-space", "padding", "font-variant-ligatures"]) {
    mirror.style.setProperty(name, style.getPropertyValue(name));
  }
  const marker = refNode("span", "", "\u200b");
  const caret = textarea.selectionStart;
  mirror.append(textarea.value.slice(0, caret), marker, textarea.value.slice(caret));
  document.body.append(mirror);
  const box = marker.getBoundingClientRect();
  mirror.remove();
  return {
    x: Math.max(bounds.left, Math.min(bounds.right - 12, bounds.left + box.left - textarea.scrollLeft)),
    y: Math.max(bounds.top, Math.min(bounds.bottom - 8, bounds.top + box.bottom - textarea.scrollTop))
  };
}

function editorAnchor(editor) {
  if (!editor.isContentEditable) return textareaAnchor(editor);
  const selection = document.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const caret = range && editor.contains(range.startContainer) && range.getClientRects()[0];
  const bounds = caret || editor.getBoundingClientRect();
  return { x: bounds.left, y: bounds.bottom };
}

function positionPopup(panel, x, y) {
  const { width, height } = panel.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(x, innerWidth - width - 8)) + "px";
  panel.style.top = Math.max(8, y + height + 12 <= innerHeight ? y + 6 : y - height - 8) + "px";
}

export function createCitationTools({ references, canCite, offsetFromPoint }) {
  const suggestions = refNode("div", "citation-suggestions hidden");
  suggestions.id = "citationSuggestions";
  suggestions.setAttribute("role", "listbox");
  suggestions.setAttribute("aria-label", "引用自动补全");
  const preview = refNode("div", "citation-hover-preview hidden");
  preview.id = "citationHoverPreview";
  preview.setAttribute("role", "tooltip");
  document.body.append(suggestions, preview);

  let completionToken = 0;
  let previewToken = 0;
  let updateTimer = 0;
  let pointerTimer = 0;
  let activeEditor = null;
  let choices = [];
  let choiceIndex = 0;
  let context = null;
  let previewAnchor = null;
  const boundChips = new WeakSet();

  function hideSuggestions() {
    completionToken++;
    window.clearTimeout(updateTimer);
    activeEditor?.removeAttribute("aria-activedescendant");
    activeEditor = null;
    choices = [];
    context = null;
    suggestions.classList.add("hidden");
  }

  function hidePreview() {
    previewToken++;
    window.clearTimeout(pointerTimer);
    if (previewAnchor?.getAttribute("aria-describedby") === preview.id) previewAnchor.removeAttribute("aria-describedby");
    previewAnchor = null;
    preview.classList.add("hidden");
  }

  function renderActiveChoice() {
    if (!activeEditor) return;
    for (const [index, child] of [...suggestions.querySelectorAll("[role=option]")].entries()) {
      child.classList.toggle("active", index === choiceIndex);
      child.setAttribute("aria-selected", String(index === choiceIndex));
    }
    const option = suggestions.querySelector('[aria-selected="true"]');
    if (option) {
      activeEditor.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else activeEditor.removeAttribute("aria-activedescendant");
  }

  function applyCompletion(index) {
    const editor = activeEditor;
    const entry = choices[index];
    const target = editor && contextAtCaret(editor);
    if (!entry || !target || !context || target.start !== context.start || target.end !== context.end) return;
    const value = entry.key + (target.terminator ? "" : "}");
    hideSuggestions();
    if (editor.isContentEditable && target.terminator !== ",") {
      const close = target.terminator ? editor.value.indexOf("}", target.end) + 1 : target.end;
      const citation = editor.value.slice(target.commandStart, target.start) + entry.key + "}";
      editor.setRangeText(citation, target.commandStart, close, "end");
    } else {
      editor.setRangeText(value, target.start, target.end, "end");
    }
    if (target.terminator === "}" && !editor.isContentEditable) {
      const skip = editor.value.slice(editor.selectionEnd).match(/^\s*}/)?.[0].length || 0;
      editor.setSelectionRange(editor.selectionEnd + skip, editor.selectionEnd + skip);
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus({ preventScroll: true });
  }

  async function updateSuggestions(textarea) {
    if (!canCite(textarea) || document.activeElement !== textarea) return;
    const target = contextAtCaret(textarea);
    if (!target) {
      if (activeEditor === textarea) hideSuggestions();
      return;
    }
    const token = ++completionToken;
    const payload = await references.load({ render: false });
    if (token !== completionToken || !payload || document.activeElement !== textarea) return;
    const current = contextAtCaret(textarea);
    if (!current || current.needle !== target.needle || current.start !== target.start) return;
    hidePreview();
    activeEditor = textarea;
    context = current;
    choices = references.matching(current.needle).slice(0, 8);
    choiceIndex = 0;
    suggestions.replaceChildren();
    const terms = referenceSearchTerms(current.needle);
    if (!choices.length) suggestions.append(refNode("p", "citation-suggestion-empty", "没有匹配的引用"));
    for (const [index, entry] of choices.entries()) {
      const option = refNode("div", "citation-suggestion");
      option.id = "citation-suggestion-" + index;
      option.setAttribute("role", "option");
      const key = refNode("code");
      highlightReferenceWords(key, entry.key, terms);
      const title = refNode("strong");
      highlightReferenceWords(title, referenceDetailIdentity(entry).title, terms);
      const meta = refNode("span", "citation-suggestion-meta", [referenceAuthorLabel(entry), entry.year].filter(Boolean).join(" · "));
      option.append(key, title, meta);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => applyCompletion(index));
      suggestions.append(option);
    }
    suggestions.classList.remove("hidden");
    const point = editorAnchor(textarea);
    positionPopup(suggestions, point.x, point.y);
    renderActiveChoice();
  }

  async function showPreview(key, point, anchor = null, editable = false) {
    if (!key || !suggestions.classList.contains("hidden")) return;
    const token = ++previewToken;
    const payload = await references.load({ render: false });
    if (token !== previewToken || !payload || (anchor && !anchor.isConnected)) return;
    const entry = references.entry(key);
    preview.replaceChildren();
    if (entry) {
      const info = referenceDetailIdentity(entry);
      preview.append(refNode("strong", "", info.title), refNode("span", "", [referenceAuthorLabel(entry), referenceVenueDisplay(info.venue, entry.year).label || entry.year].filter(Boolean).join(" · ")));
    } else preview.append(refNode("strong", "", "库中暂无此文献"));
    preview.append(refNode("code", "", key), refNode("span", "citation-hover-hint", editable ? "Ctrl / ⌘ + 单击在工作台查看" : "点击在工作台查看"));
    previewAnchor = anchor;
    if (anchor && !editable) anchor.setAttribute("aria-describedby", preview.id);
    const bounds = point || anchor?.getBoundingClientRect();
    preview.classList.remove("hidden");
    positionPopup(preview, bounds.x ?? bounds.left, bounds.bottom ?? bounds.y);
  }

  function bindChip(button, key) {
    if (boundChips.has(button)) return;
    boundChips.add(button);
    button.addEventListener("pointerenter", () => void showPreview(key, null, button));
    button.addEventListener("pointerleave", hidePreview);
    button.addEventListener("focus", () => void showPreview(key, null, button));
    button.addEventListener("blur", hidePreview);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      hidePreview();
      void references.openReference(key);
    });
  }

  function bindEditor(textarea) {
    textarea.setAttribute("aria-autocomplete", "list");
    textarea.setAttribute("aria-controls", suggestions.id);
    textarea.addEventListener("input", (event) => {
      hidePreview();
      hideSuggestions();
      if (event.isComposing || !canCite(textarea) || !contextAtCaret(textarea)) return;
      updateTimer = window.setTimeout(() => void updateSuggestions(textarea), 80);
    });
    textarea.addEventListener("compositionend", () => {
      if (canCite(textarea) && contextAtCaret(textarea)) void updateSuggestions(textarea);
    });
    textarea.addEventListener("keydown", (event) => {
      if (activeEditor !== textarea || suggestions.classList.contains("hidden") || event.isComposing) return;
      if (event.key === "Escape") hideSuggestions();
      else if (!event.ctrlKey && !event.metaKey && !event.altKey && choices.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        choiceIndex = (choiceIndex + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
        renderActiveChoice();
      } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && choices.length && ["Enter", "Tab"].includes(event.key)) applyCompletion(choiceIndex);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    textarea.addEventListener("blur", () => {
      hideSuggestions();
      hidePreview();
    });
    if (textarea.isContentEditable) {
      textarea.addEventListener("click", hideSuggestions);
      return;
    }
    textarea.addEventListener("pointermove", (event) => {
      if (event.buttons || !suggestions.classList.contains("hidden") || !canCite(textarea) || !mayContainCite.test(textarea.value)) return;
      window.clearTimeout(pointerTimer);
      const point = { x: event.clientX, y: event.clientY };
      pointerTimer = window.setTimeout(() => {
        if (!textarea.isConnected || !textarea.getBoundingClientRect().width) return;
        const key = referenceAtPointer(textarea, offsetFromPoint(textarea, point.x, point.y));
        if (key) void showPreview(key, point, textarea, true);
        else hidePreview();
      }, 290);
    });
    textarea.addEventListener("pointerleave", hidePreview);
    textarea.addEventListener("click", (event) => {
      hideSuggestions();
      if ((!event.ctrlKey && !event.metaKey) || !canCite(textarea) || !mayContainCite.test(textarea.value)) return;
      const key = referenceAtPointer(textarea, offsetFromPoint(textarea, event.clientX, event.clientY));
      if (!key) return;
      event.preventDefault();
      hidePreview();
      void references.openReference(key);
    });
  }

  window.addEventListener("resize", () => { hideSuggestions(); hidePreview(); });
  document.addEventListener("scroll", (event) => {
    if (!suggestions.contains(event.target)) {
      hidePreview();
      if (activeEditor && event.target !== activeEditor) hideSuggestions();
    }
  }, true);
  return { bindChip, bindEditor };
}


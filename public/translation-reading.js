const inlineToken = /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n\\])+\$|\\(?:[A-Za-z]*cite[A-Za-z]*|(?:eq|auto|c|C|page)?ref)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^{}]*\}|\\(?:textbf|textit|emph|texttt|url)\{[^{}]*\}|\\(?:label|index)\{[^{}]*\}|\\[%&#_$]|~/gi;

function formula(text, displayMode = false) {
  const span = document.createElement("span");
  span.className = displayMode ? "reading-display-math" : "reading-inline-math";
  try {
    if (!window.katex) throw new Error("KaTeX");
    window.katex.render(text.trim(), span, { displayMode, throwOnError: true, strict: "ignore", trust: false });
  } catch {
    span.textContent = text.trim();
    span.classList.add("reading-math-fallback");
  }
  return span;
}

const formatTags = { textbf: "strong", textit: "em", emph: "em", texttt: "code", url: "code" };

function readingToken(source) {
  const format = /^\\(textbf|textit|emph|texttt|url)\{([^{}]*)\}$/.exec(source);
  if (format?.[2]) {
    const inline = document.createElement(formatTags[format[1]]);
    inline.dataset.latexCommand = format[1];
    inline.textContent = format[2];
    return inline;
  }

  const token = document.createElement("span");
  token.contentEditable = "false";
  token.dataset.latex = source;
  if (source.startsWith("\\(") || source.startsWith("$") || source.startsWith("\\[")) {
    const display = source.startsWith("$$") || source.startsWith("\\[");
    const delimiter = source.startsWith("\\") || display ? 2 : 1;
    token.append(formula(source.slice(delimiter, -delimiter), display));
  } else if (/^\\(?:[a-z]*cite[a-z]*|(?:eq|auto|c|page)?ref)\b/i.test(source)) {
    const group = source.match(/\{([^{}]*)\}$/)[1];
    const interactive = /^\\[a-z]*cite[a-z]*\b/i.test(source);
    const keys = interactive ? group.split(",").map((key) => key.trim()).filter(Boolean) : [group];
    keys.forEach((key, index) => {
      if (index) token.append(" ");
      const chip = document.createElement(interactive ? "button" : "span");
      chip.className = "reading-reference" + (interactive ? " reading-reference-action" : "");
      chip.textContent = "[" + key + "]";
      if (interactive) {
        chip.type = "button";
        chip.dataset.citationKey = key;
        chip.setAttribute("aria-label", "查看文献 " + key);
      }
      token.append(chip);
    });
  } else if (/^\\(?:label|index)\{/i.test(source)) {
    token.hidden = true;
  } else {
    token.textContent = source === "~" ? "\u00a0" : source.length === 2 ? source.slice(1) : source;
  }
  return token;
}

export function readingFragment(value) {
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const match of value.matchAll(inlineToken)) {
    if (end < match.index) fragment.append(value.slice(end, match.index));
    fragment.append(readingToken(match[0]));
    end = match.index + match[0].length;
  }
  if (end < value.length) fragment.append(value.slice(end));
  return fragment;
}

// Keep source offsets and DOM caret positions aligned across rendered TeX and browser-created line breaks.
export function readingSource(root) {
  const positions = new WeakMap();
  const pieces = [];
  let value = "";
  const append = (text, start, end, linear = false) => {
    if (!text) return;
    pieces.push({ offset: value.length, length: text.length, start, end, linear });
    value += text;
  };
  const walk = (parent) => {
    const offsets = [value.length];
    let previousBlock = false;
    for (const [index, child] of Array.from(parent.childNodes).entries()) {
      const before = [parent, index];
      const after = [parent, index + 1];
      const block = child.nodeName === "DIV" || child.nodeName === "P";
      if (index > 0 && (block || previousBlock)) append("\n", before, block ? [child, 0] : before);
      if (child.nodeType === Node.TEXT_NODE) {
        positions.set(child, value.length);
        append(child.data, [child, 0], [child, child.length], true);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.hasAttribute("data-latex")) {
        append(child.dataset.latex, before, after);
      } else if (child.nodeName === "BR") {
        // A final <br> lets the browser place a caret on an otherwise empty line.
        if (child.nextSibling) append("\n", before, after);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const command = child.dataset.latexCommand || { B: "textbf", STRONG: "textbf", I: "textit", EM: "textit" }[child.tagName];
        if (command) append(`\\${command}{`, before, [child, 0]);
        walk(child);
        if (command) append("}", [child, child.childNodes.length], after);
      }
      offsets.push(value.length);
      previousBlock = block;
    }
    positions.set(parent, offsets);
  };
  walk(root);
  return {
    value,
    offset(node, index) {
      const offsets = positions.get(node);
      if (typeof offsets === "number") return offsets + index;
      if (offsets) return offsets[index] ?? offsets.at(-1);
      const atom = node.parentElement?.closest("[data-latex]");
      return atom && positions.has(atom.parentNode)
        ? positions.get(atom.parentNode)[Array.prototype.indexOf.call(atom.parentNode.childNodes, atom)]
        : 0;
    },
    point(offset) {
      for (const piece of pieces) {
        const delta = offset - piece.offset;
        if (delta > piece.length) continue;
        if (piece.linear) return [piece.start[0], Math.max(0, delta)];
        return delta <= 0 ? piece.start : piece.end;
      }
      return [root, root.childNodes.length];
    }
  };
}

export function renderDisplayFormula(container, source) {
  let value = source.trim().replace(/\\label\s*\{[^{}]*\}/g, "");
  const environment = value.match(/^\\begin\{([\w*]+)\}([\s\S]*)\\end\{\1\}$/);
  if (environment) {
    const name = environment[1].replace(/\*$/, "");
    value = environment[2];
    if (["align", "alignat", "flalign", "eqnarray", "split", "aligned"].includes(name)) {
      value = "\\begin{aligned}" + (name === "alignat" ? value.replace(/^\s*\{\d+\}/, "") : value) + "\\end{aligned}";
    } else if (["gather", "multline", "gathered"].includes(name)) {
      value = "\\begin{gathered}" + value + "\\end{gathered}";
    } else if (name !== "equation") value = environment[0];
  } else if (/^\\\[[\s\S]*\\\]$|^\$\$[\s\S]*\$\$$/.test(value)) {
    value = value.slice(2, -2);
  }
  container.replaceChildren(formula(value, true));
}

export function describeDraftDiff(container, previous, current) {
  container.replaceChildren();
  if (typeof previous !== "string" || previous === current) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const before = [...previous];
  const after = [...current];
  let first = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  let tail = 0;
  while (tail < before.length - first && tail < after.length - first && before.at(-tail - 1) === after.at(-tail - 1)) tail++;
  const deleted = document.createElement("del");
  const added = document.createElement("ins");
  deleted.textContent = before.slice(first, before.length - tail).join("");
  added.textContent = after.slice(first, after.length - tail).join("");
  container.append(document.createTextNode("中文改动 "), deleted, document.createTextNode(" "), added);
}

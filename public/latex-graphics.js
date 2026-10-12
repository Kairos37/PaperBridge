function escaped(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

function visibleSource(source) {
  return String(source || "").split(/\r?\n/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === "%" && !escaped(line, index)) return line.slice(0, index);
    }
    return line;
  }).join("\n");
}

function readGroup(source, start) {
  const closer = source[start] === "{" ? "}" : source[start] === "[" ? "]" : "";
  if (!closer) return null;
  const stack = [closer];
  for (let index = start + 1; index < source.length; index += 1) {
    if (escaped(source, index)) continue;
    const char = source[index];
    if (char === "{") stack.push("}");
    else if (char === "[" && stack.at(-1) === "]") stack.push("]");
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

export function graphicsCommands(source) {
  const visible = visibleSource(source);
  const pattern = /\\(includegraphics|includesvg|graphicspath)(?![A-Za-z@])\*?\s*/g;
  const commands = [];
  for (const match of visible.matchAll(pattern)) {
    if (escaped(visible, match.index)) continue;
    let cursor = match.index + match[0].length;
    while (visible[cursor] === "[") {
      const option = readGroup(visible, cursor);
      if (!option) break;
      cursor = option.end;
      while (/\s/.test(visible[cursor] || "")) cursor += 1;
    }
    const argument = visible[cursor] === "{" ? readGroup(visible, cursor) : null;
    if (argument) commands.push({ command: match[1], value: argument.value.trim() });
  }
  return commands;
}

export function graphicsSearchPaths(source, inherited = []) {
  const declaration = graphicsCommands(source).filter((item) => item.command === "graphicspath").at(-1);
  if (!declaration) return inherited;
  const paths = [];
  let cursor = 0;
  while (cursor < declaration.value.length) {
    if (/\s/.test(declaration.value[cursor])) { cursor += 1; continue; }
    const group = readGroup(declaration.value, cursor);
    if (!group) break;
    paths.push(group.value.trim());
    cursor = group.end;
  }
  return paths;
}

function literalPath(value) {
  let result = String(value || "").trim();
  const wrapper = /^\\detokenize\s*/.exec(result);
  if (wrapper) {
    const group = readGroup(result, wrapper[0].length);
    if (group && !result.slice(group.end).trim()) result = group.value;
  }
  return result.replace(/^"(.*)"$/, "$1").replace(/\\([_ %&#])/g, "$1").replaceAll("\\", "/");
}

function projectPath(value) {
  if (/^(?:\/|[A-Za-z]:)/.test(value)) return "";
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function resolveGraphicPath(value, { files = [], sourceFile = "", mainFile = "", searchPaths = [], command = "includegraphics" } = {}) {
  const reference = literalPath(value);
  if (!reference) return "";
  const mainDirectory = String(mainFile).replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  const sourceDirectory = String(sourceFile).replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  const bases = ["", mainDirectory, ...searchPaths.map(literalPath), sourceDirectory];
  for (const directory of [mainDirectory, sourceDirectory].filter(Boolean)) {
    for (const searchPath of searchPaths) bases.push(`${directory}/${literalPath(searchPath)}`);
  }
  const extensions = command === "includesvg" ? [".svg"] : [".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp", ".gif", ".bmp", ".tif", ".tiff"];
  const hasExtension = extensions.some((ext) => reference.toLowerCase().endsWith(ext));
  const available = new Map(files.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.path]));
  // Follow explicit directories in order; never choose an unrelated same-named image.
  for (const base of new Set(bases)) {
    const candidate = projectPath(base ? `${base}/${reference}` : reference);
    if (!candidate) continue;
    for (const name of [candidate, ...(!hasExtension ? extensions.map((ext) => `${candidate}${ext}`) : [])]) {
      if (available.has(name)) return available.get(name);
      const matches = files.filter((entry) => entry.type === "file" && entry.path.toLowerCase() === name.toLowerCase());
      if (matches.length === 1) return matches[0].path;
    }
  }
  return projectPath(reference) || reference;
}

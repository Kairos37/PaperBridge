function visibleSource(source) {
  return String(source || "").replace(/(\\[\s\S])|%[^\r\n]*/g, (match, escaped) => escaped || "");
}

function groupAt(source, start, open = "{", close = "}") {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== open) return null;
  const begin = ++cursor;
  let depth = 1;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue; }
    if (source[cursor] === open) depth += 1;
    if (source[cursor] === close) depth -= 1;
    if (!depth) return { value: source.slice(begin, cursor), end: cursor + 1 };
  }
  return null;
}

function commandArgument(source, name) {
  const match = source.match(new RegExp(`\\\\${name}\\*?\\s*(?:\\[[^\\]]*\\]\\s*)?`));
  return match ? groupAt(source, match.index + match[0].length)?.value || "" : "";
}

function tableColumns(spec) {
  const columns = [];
  for (let cursor = 0; cursor < spec.length; cursor += 1) {
    const char = spec[cursor];
    if ("lcrX".includes(char)) columns.push(char === "r" ? "right" : char === "c" ? "center" : "left");
    else if ("pmb".includes(char)) {
      columns.push("left");
      cursor = (groupAt(spec, cursor + 1)?.end || cursor + 1) - 1;
    } else if ("@!><".includes(char)) cursor = (groupAt(spec, cursor + 1)?.end || cursor + 1) - 1;
    else if (char === "*") {
      const count = groupAt(spec, cursor + 1);
      const inner = count && groupAt(spec, count.end);
      if (inner) {
        const repeat = Math.min(64, Math.max(0, Number(count.value) || 0));
        for (let index = 0; index < repeat; index += 1) columns.push(...tableColumns(inner.value));
        cursor = inner.end - 1;
      }
    }
  }
  return columns;
}

function tableCell(source) {
  const cell = { source: source.trim(), colspan: 1, rowspan: 1, align: "" };
  const match = cell.source.match(/^\\(multicolumn|multirow)\s*/);
  if (!match) return cell;
  const count = groupAt(cell.source, match[0].length);
  const option = count && groupAt(cell.source, count.end);
  const content = option && groupAt(cell.source, option.end);
  if (content) {
    cell[match[1] === "multicolumn" ? "colspan" : "rowspan"] = Math.min(64, Math.max(1, Number(count.value) || 1));
    cell.source = content.value;
    if (match[1] === "multicolumn") cell.align = tableColumns(option.value)[0] || "";
  }
  return cell;
}

export function parseLatexTable(value) {
  const source = visibleSource(value);
  const begin = /\\begin\s*\{(tabular\*?|tabularx|longtable)\}/.exec(source);
  if (!begin) return null;
  let cursor = begin.index + begin[0].length;
  const optional = groupAt(source, cursor, "[", "]");
  if (optional) cursor = optional.end;
  if (["tabular*", "tabularx"].includes(begin[1])) cursor = groupAt(source, cursor)?.end || cursor;
  const alignmentOption = groupAt(source, cursor, "[", "]");
  if (alignmentOption) cursor = alignmentOption.end;
  const spec = groupAt(source, cursor);
  if (!spec) return null;
  const end = source.indexOf(`\\end{${begin[1]}}`, spec.end);
  if (end < 0) return null;
  let body = source.slice(spec.end, end);
  // Rules and longtable header markers are layout controls, not cell contents.
  body = body.replace(/\\(?:hline|toprule|midrule|bottomrule|addlinespace)(?:\s*\[[^\]]*\])?/g, "")
    .replace(/\\(?:cmidrule|cline)(?:\s*\[[^\]]*\])?(?:\s*\([^)]*\))?\s*\{[^}]*\}/g, "")
    .replace(/\\end(?:firsthead|head|foot|lastfoot)\b/g, "");
  const rows = [];
  let row = [];
  let cell = "";
  let depth = 0;
  let environmentDepth = 0;
  const flushCell = () => { row.push(tableCell(cell)); cell = ""; };
  const flushRow = () => {
    if (cell.trim() || row.length) { flushCell(); rows.push(row); }
    row = []; cell = "";
  };
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") {
      const environment = /^\\(begin|end)\{([^}]+)\}/.exec(body.slice(index));
      if (environment) environmentDepth += environment[1] === "begin" ? 1 : -1;
      if (body[index + 1] === "\\" && depth === 0 && environmentDepth === 0) {
        flushRow(); index += 1;
        if (body[index + 1] === "*") index += 1;
        const spacing = groupAt(body, index + 1, "[", "]");
        if (spacing) index = spacing.end - 1;
      } else { cell += body[index] + (body[++index] || ""); }
      continue;
    }
    if (body[index] === "{") depth += 1;
    if (body[index] === "}") depth -= 1;
    if (body[index] === "&" && depth === 0 && environmentDepth === 0) flushCell();
    else cell += body[index];
  }
  flushRow();
  return { rows, columns: tableColumns(spec.value), caption: commandArgument(source, "caption"), grid: spec.value.includes("|") };
}

export function escapeStructureText(value) {
  const replacements = { "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
  return String(value ?? "").replace(/[\\&%$#_{}~^]/g, (char) => replacements[char]).replace(/\r?\n/g, " ");
}

function structureLabel(value, prefix) {
  const label = String(value || "").trim().replace(/[^a-zA-Z0-9:_.-]/g, "-");
  return label ? `${prefix}:${label.replace(new RegExp(`^${prefix}:`), "")}` : "";
}

export function createTableLatex({ rows, caption = "", label = "", span = false, grid = false } = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100 || rows.some((row) => !Array.isArray(row))) throw new Error("请选择 1 至 100 行的表格。");
  const columns = Math.max(...rows.map((row) => row.length));
  if (!columns || columns > 24) throw new Error("请选择 1 至 24 列的表格。");
  const env = span ? "table*" : "table";
  const spec = grid ? `|${Array(columns).fill("c").join("|")}|` : "c".repeat(columns);
  const lines = [`\\begin{${env}}[!htbp]`, "  \\centering"];
  if (caption.trim()) lines.push(`  \\caption{${escapeStructureText(caption)}}`);
  const key = structureLabel(label, "tab");
  if (key) lines.push(`  \\label{${key}}`);
  lines.push(`  \\begin{tabular}{${spec}}`, "    \\hline");
  rows.forEach((row, index) => {
    lines.push(`    ${Array.from({ length: columns }, (_, column) => escapeStructureText(row[column])).join(" & ")} \\\\`);
    if (grid || index === 0 || index === rows.length - 1) lines.push("    \\hline");
  });
  lines.push("  \\end{tabular}", `\\end{${env}}`);
  return lines.join("\n");
}

export function createFormulaLatex({ latex = "", numbered = true, label = "" } = {}) {
  const body = String(latex).trim().replace(/\\placeholder(?:\[[^\]]*\])?\{[^}]*\}/g, "{}");
  if (!body) throw new Error("请输入公式。");
  const key = numbered && structureLabel(label, "eq");
  return numbered
    ? ["\\begin{equation}", ...(key ? [`  \\label{${key}}`] : []), `  ${body}`, "\\end{equation}"].join("\n")
    : ["\\[", `  ${body}`, "\\]"].join("\n");
}

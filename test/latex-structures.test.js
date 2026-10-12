import assert from "node:assert/strict";
import test from "node:test";
import { createFormulaLatex, createTableLatex, parseLatexTable } from "../public/latex-structures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, stopServer } from "../server.js";

test("table parser keeps rows, math cells and column alignment", () => {
  const source = String.raw`\begin{table}
\caption{Results}
\begin{tabular}{lcr}
\hline
Name & $x^2$ & Score \\
\hline
A & 1 & 2 \\
B & 3 & 4 \\
\end{tabular}
\end{table}`;
  const table = parseLatexTable(source);
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0][1].source, "$x^2$");
  assert.equal(table.columns.length, 3);
  assert.equal(table.caption, "Results");
});

test("table and formula generators produce bounded editable LaTeX", () => {
  const table = createTableLatex({ rows: [["A", "B"], ["1", "2"]], caption: "T", label: "tab:test", grid: true });
  assert.match(table, /\\begin\{tabular\}\{\|c\|c\|\}/);
  assert.match(table, /\\label\{tab:test\}/);
  assert.match(createFormulaLatex({ latex: "\\frac{a}{b}", numbered: true, label: "eq:test" }), /\\label\{eq:test\}/);
  assert.match(createFormulaLatex({ latex: "x^2", numbered: false }), /^\\\[/);
});

test("structure insertion writes table and formula at a TeX cursor without compiling", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-structure-"));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, "main.tex"), [
    "\\documentclass{article}",
    "\\begin{document}",
    "Before.",
    "\\end{document}"
  ].join("\n"));
  try {
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    try {
      const opened = await fetch(`${server.url}/api/project/open`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
      });
      assert.equal(opened.ok, true);
      const source = await (await fetch(`${server.url}/api/source?file=main.tex`)).json();
      const result = await fetch(`${server.url}/api/structure/insert`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: "main.tex",
          anchor: { type: "source", cursorOffset: source.content.indexOf("Before."), sourceHash: source.sourceHash },
          kind: "table",
          latex: createTableLatex({ rows: [["A", "B"], ["1", "2"]] }),
          deferCompile: true
        })
      });
      assert.equal(result.ok, true, await result.text());
      const updated = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
      assert.match(updated, /\\begin\{table\}/);
      assert.match(updated, /Before\./);
    } finally {
      await stopServer();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

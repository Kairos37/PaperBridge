import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-inline-format-"));
let browser;
try {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const source = String.raw`\documentclass{article}
\begin{document}
This paragraph has enough words to be detected in the bilingual editor.

\begin{table}
\begin{tabular}{ll}
Metric & Value \\
Delay & 10 ms \\
\end{tabular}
\end{table}
\end{document}`;
  await fs.writeFile(path.join(projectRoot, "main.tex"), source);
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true);
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("This paragraph"));
  const editor = page.locator("#sourceEditor");
  const select = async (locator, text) => locator.evaluate((element, text) => {
    element.focus();
    const start = element.value.indexOf(text);
    if (start < 0) throw new Error(`Missing selection: ${text}`);
    element.setSelectionRange(start, start + text.length);
  }, text);
  await select(editor, "paragraph");
  await editor.press("Control+b");
  assert.ok((await editor.inputValue()).includes(String.raw`\textbf{paragraph}`));
  await editor.press("Control+z");
  assert.equal(await editor.inputValue(), source);
  await select(editor, "paragraph");
  await editor.press("Control+i");
  assert.ok((await editor.inputValue()).includes(String.raw`\textit{paragraph}`));
  await editor.press("Control+z");
  assert.equal(await editor.inputValue(), source);
  console.log("PASS: source bold and italic shortcuts each support native undo");

  await page.locator('[data-mode="edit"]').click();
  await page.waitForSelector(".english-table textarea");
  const cell = page.locator(".english-table textarea").first();
  await select(cell, "Metric");
  await cell.press("Control+b");
  assert.equal(await cell.inputValue(), String.raw`\textbf{Metric}`);
  await cell.press("Control+z");
  assert.equal(await cell.inputValue(), "Metric");
  await select(cell, "Metric");
  await cell.press("Control+i");
  assert.equal(await cell.inputValue(), String.raw`\textit{Metric}`);
  await select(cell, "Metric");
  await cell.press("Control+b");
  assert.equal(await cell.inputValue(), String.raw`\textit{\textbf{Metric}}`);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/table-block")),
    page.locator(".save-table-button").click()
  ]);
  await page.waitForFunction(() => document.querySelector(".english-table textarea")?.value === String.raw`\textit{\textbf{Metric}}`);
  assert.ok((await fs.readFile(path.join(projectRoot, "main.tex"), "utf8")).includes(String.raw`\textit{\textbf{Metric}}`));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes(String.raw`\textit{\textbf{Metric}}`));
  await page.locator('[data-mode="edit"]').click();
  await page.waitForFunction(() => document.querySelector(".english-table textarea")?.value === String.raw`\textit{\textbf{Metric}}`);
  assert.deepEqual(errors, []);
  console.log("PASS: table bold/italic shortcuts support undo and nested formatting survives save and reload");
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-inline-format-"));
  await fs.rm(root, { recursive: true, force: true });
}

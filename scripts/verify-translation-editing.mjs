import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const temp = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temp, "paperbridge-translation-editing-"));
const projectRoot = path.join(root, "project");
const file = "main.tex";
const draft = String.raw`中文工作稿使用文字和 inline variables 描述一个可以稳定换行的完整段落。行内公式 \(BW\) 与引用~\cite{alpha,beta}都应该保留，鼠标点进这段时，文字仍留在原处。`;
const english = String.raw`The receiver uses a wide spectrum to recover additional signals during each interval.
The method compares \textbf{independent results} with \(BW\) and uses a \citep[see][p. 2]{alpha,beta} reference.\label{par:receiver}`;
const tex = [
  "\\documentclass{article}", "\\usepackage{natbib}", "\\begin{document}", "\\section{Introduction}", "",
  english, "", "\\newpage", "", "The second page contains a reproducible control experiment for the receiver.",
  "", "\\bibliographystyle{plainnat}", "\\bibliography{papers}", "\\end{document}"
].join("\n");
let browser;
try {
  await fs.mkdir(projectRoot);
  const sourcePath = path.join(projectRoot, file);
  await fs.writeFile(sourcePath, tex);
  await fs.writeFile(path.join(projectRoot, "papers.bib"), [
    "@article{alpha,title={An experiment about radio channels},author={Chen, Li},journal={Radio},year={2020}}",
    "@article{beta,title={A reproducible control},author={Park, Jo},journal={Radio},year={2022}}"
  ].join("\n"));

  const { url } = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const api = async (route, body) => {
    const response = await fetch(url + route, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    return response.json();
  };
  await api("/api/project/open", { projectRoot, mainTex: file });
  const getSegment = async () => (await api("/api/document?file=" + file)).segments[0];
  const original = await getSegment();
  await api("/api/segment/english", {
    file, index: original.index, sourceHash: original.sourceHash, english, chinese: draft, deferCompile: true
  });
  const revisedEnglish = english.replace("wide spectrum", "shared spectrum");
  await fs.writeFile(sourcePath, tex.replace(english, revisedEnglish));
  assert.equal((await getSegment()).translationStatus, "english-changed");
  const build = await api("/api/compile", {});
  assert.equal(build.success, true, JSON.stringify(build.errors));

  browser = await chromium.launch({
    executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1740, height: 1020 } });
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/compile", (route) => route.fulfill({ json: build }));
  await page.goto(url);

  const translation = page.getByRole("button", { name: "中英对照", exact: true });
  const row = page.locator("#segmentList .segment-row").first();
  const pdf = page.locator(".preview-panel");
  const stacked = page.getByRole("button", { name: "上下排版", exact: true });
  const columns = page.getByRole("button", { name: "左右排版", exact: true });
  const expand = page.locator("#translationExpandButton");
  await translation.click();
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector("#visiblePage").textContent.endsWith("/2"));
  await page.locator("#nextPageButton").click();
  await page.waitForFunction(() => document.querySelector("#visiblePage").textContent === "2/2");
  const zoom = await page.locator("#pdfZoomValue").textContent();
  await columns.click();
  assert.equal(await pdf.isVisible(), true);
  assert.equal(await columns.getAttribute("aria-pressed"), "true");
  await stacked.click();
  assert.equal(await pdf.isVisible(), true);
  await columns.click();
  await expand.click();
  assert.equal(await pdf.isVisible(), false);
  assert.equal(await columns.getAttribute("aria-pressed"), "true");
  await stacked.click();
  assert.equal(await pdf.isVisible(), false);
  await expand.click();
  assert.equal(await pdf.isVisible(), true);
  assert.equal(await stacked.getAttribute("aria-pressed"), "true");
  await page.waitForFunction(() => document.querySelector("#visiblePage").textContent === "2/2");
  assert.equal(await page.locator("#pdfZoomValue").textContent(), zoom);
  await columns.click();
  console.log("PASS PDF is independent of paragraph layout and keeps its page and zoom");

  const toolbar = page.locator("#editView > .panel-toolbar");
  const barLayout = () => toolbar.evaluate((bar) => {
    const top = bar.getBoundingClientRect().top;
    const bottom = bar.getBoundingClientRect().bottom;
    const controls = [...bar.querySelectorAll("button, .translation-file-progress")].map((item) => item.getBoundingClientRect());
    return {
      oneLine: controls.every((item) => item.top >= top && item.bottom <= bottom) && bar.offsetHeight <= 48,
      fits: bar.scrollWidth === bar.clientWidth
    };
  });
  assert.deepEqual(await barLayout(), { oneLine: true, fits: true });
  assert.equal(await toolbar.locator("#currentFile").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.setViewportSize({ width: 1120, height: 960 });
  assert.deepEqual(await barLayout(), { oneLine: true, fits: true });
  await page.setViewportSize({ width: 1740, height: 1020 });
  assert.equal(await row.locator(".segment-status").textContent(), "需重译");
  assert.equal(await row.locator(".segment-draft-diff").isVisible(), false);
  assert.equal(await page.getByText("英文源码已修改，可以重新生成中文。", { exact: true }).count(), 0);
  console.log("PASS translation controls fit on one row and stale drafts have a single status");

  const chinese = row.locator(".segment-reading.chinese");
  const englishEditor = row.locator(".segment-reading.english");
  await page.evaluate(() => document.fonts.ready);
  const geometry = (editor) => editor.evaluate((node) => {
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      font: style.font, spacing: style.letterSpacing, wrap: style.whiteSpace, height: node.offsetHeight,
      lines: [...range.getClientRects()].map((rect) => [rect.x, rect.y, rect.width, rect.height])
    };
  });
  const testClick = async (editor, expected) => {
    assert.equal(await editor.evaluate((node) => node.value), expected);
    const before = await geometry(editor);
    const point = await editor.evaluate((node) => {
      const range = document.createRange();
      range.setStart(node.firstChild, 8);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 0.1, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await editor.evaluate((node) => document.activeElement === node), true);
    assert.equal(await editor.evaluate((node) => node.selectionStart), 8);
    assert.deepEqual(await geometry(editor), before);
  };
  await testClick(chinese, draft);
  const chineseSaved = page.waitForResponse((response) => response.url().endsWith("/api/segment/chinese"));
  await page.keyboard.insertText("直接编辑");
  assert.ok((await chineseSaved).ok());
  const updatedDraft = draft.slice(0, 8) + "直接编辑" + draft.slice(8);
  assert.equal((await getSegment()).chinese, updatedDraft);
  assert.equal(await row.locator(".segment-draft-diff").isVisible(), true);
  await testClick(englishEditor, revisedEnglish);
  const englishSaved = page.waitForResponse((response) => response.url().endsWith("/api/segment/english"));
  await page.keyboard.insertText("X");
  const editedEnglish = revisedEnglish.slice(0, 8) + "X" + revisedEnglish.slice(8);
  assert.ok((await englishSaved).ok());
  assert.equal((await getSegment()).english, editedEnglish);
  const undoSaved = page.waitForResponse((response) => response.url().endsWith("/api/segment/english"));
  await page.keyboard.press("Control+z");
  assert.ok((await undoSaved).ok());
  assert.equal((await getSegment()).english, revisedEnglish);
  console.log("PASS Chinese and English use the same line layout and click position while editing; native undo works after saving");

  const copySource = "\\(BW\\) and uses a \\citep[see][p. 2]{alpha,beta}";
  const copyStart = revisedEnglish.indexOf(copySource);
  const copied = await englishEditor.evaluate((node, range) => {
    node.setSelectionRange(...range);
    const clipboard = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    return clipboard.getData("text/plain");
  }, [copyStart, copyStart + copySource.length]);
  assert.equal(copied, copySource);
  await englishEditor.evaluate((node) => node.setSelectionRange(0, 3));
  await page.keyboard.press("Control+i");
  assert.match(await englishEditor.evaluate((node) => node.value), /^\\textit\{The\}/);
  await page.keyboard.press("Control+z");
  assert.equal(await englishEditor.evaluate((node) => node.value), revisedEnglish);
  await englishEditor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await page.keyboard.insertText(" Additional evidence \\cite{be");
  await page.getByRole("option").filter({ hasText: "beta" }).waitFor();
  await page.keyboard.press("Enter");
  assert.equal(await englishEditor.locator('[data-citation-key="beta"]').count(), 2);
  assert.match(await englishEditor.evaluate((node) => node.value), /Additional evidence \\cite\{beta\}\\label\{par:receiver\}$/);

  await englishEditor.click({ button: "right" });
  await page.getByRole("button", { name: "插入文献", exact: true }).click();
  await page.locator("#referenceInsertDialog").getByText("A reproducible control", { exact: true }).click();
  assert.equal(await englishEditor.locator('[data-citation-key="beta"]').count(), 3);

  await row.locator('summary[aria-label="段落操作"]').click();
  await row.getByRole("button", { name: "编辑段落源码" }).click();
  const raw = row.locator("textarea.segment-textarea.english");
  assert.equal(await raw.isVisible(), true);
  assert.match(await raw.inputValue(), /\\\(BW\\\).*\\citep\[see\]\[p\. 2\]\{alpha,beta\}/s);
  await raw.fill(revisedEnglish.replace("\\(BW\\)", "\\(SF\\)"));
  await raw.press("Escape");
  assert.equal(await raw.isVisible(), false);
  assert.equal(await englishEditor.isVisible(), true);
  assert.match(await englishEditor.locator(".reading-inline-math").textContent(), /SF/);
  assert.deepEqual(errors, []);
  console.log("PASS TeX commands round-trip, citation completions and insertion stay live, and source mode remains available");
} finally {
  await browser?.close();
  await stopServer();
  const relative = path.relative(temp, await fs.realpath(root));
  if (!path.isAbsolute(relative) && /^paperbridge-translation-editing-[^\\/]+$/.test(relative)) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

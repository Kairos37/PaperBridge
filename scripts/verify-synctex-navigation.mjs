import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const apiOnly = process.argv.includes("--api-only");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-synctex-navigation-"));
const projectRoot = path.join(root, "project");
const output = path.resolve("release/verification");
let browser;
let page;
try {
  await fs.mkdir(path.join(projectRoot, "parts"), { recursive: true });
  const repeated = "A shared repeated passage describes reliable communication across changing network conditions with repeatable scientific experiments.";
  const main = ["\\documentclass{article}", "\\begin{document}", "\\section{First page}", repeated,
    "\\newpage", "\\input{parts/second}", "\\end{document}"].join("\n");
  const second = ["\\section{Second page}", repeated, "", "\\begin{equation}", "E = mc^{2} + \\alpha", "\\end{equation}",
    "\\begin{center}", "\\begin{tabular}{cc}", "Token & Value\\\\", "TARGETCELL & 42\\\\", "\\end{tabular}", "\\end{center}"].join("\n");
  await fs.writeFile(path.join(projectRoot, "main.tex"), main);
  await fs.writeFile(path.join(projectRoot, "parts", "second.tex"), second);
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const request = async (url, body) => {
    const response = await fetch(`${server.url}${url}`, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : undefined);
    const payload = await response.json();
    assert.equal(response.ok, true, payload.error);
    return payload;
  };
  await request("/api/project/open", { projectRoot, mainTex: "main.tex" });
  const build = await request("/api/compile", {});
  assert.equal(build.previewAvailable, true, JSON.stringify(build.errors));
  assert.equal(build.pdf.pages, 2);
  const map = await fs.readFile(path.join(projectRoot, "main.synctex.gz"));
  const mapText = gunzipSync(map).toString("utf8");
  const checks = [];
  for (const target of [{ file: "main.tex", line: 4, column: 3 }, { file: "parts/second.tex", line: 2, column: 3 },
    { file: "parts/second.tex", line: 5, column: 3 }, { file: "parts/second.tex", line: 10, column: 3 }]) {
    const rect = await request("/api/synctex/forward", target);
    assert.equal(rect.page, target.file === "main.tex" ? 1 : 2);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0, JSON.stringify(rect));
    const inverse = await request("/api/synctex/inverse", { page: rect.page, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    assert.equal(inverse.file, target.file);
    assert.ok(Math.abs(inverse.line - target.line) <= 1, JSON.stringify({ target, rect, inverse }));
    checks.push({ target, rect, inverse });
  }
  await fs.mkdir(output, { recursive: true });
  const report = { engine: build.engine, pages: build.pdf.pages, inputTags: mapText.split(/\r?\n/).filter((line) => line.startsWith("Input:")), checks };
  await fs.writeFile(path.join(output, "synctex-navigation-api.json"), JSON.stringify(report, null, 2));
  console.log("PASS: real compiled SyncTeX locates both source files, repeated paragraphs, math, and a table cell in PDF big-point coordinates");
  if (!apiOnly) {
    browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    const queries = [];
    let browserCompileCalls = 0;
    await page.addInitScript(() => {
      window.syncTeXToasts = [];
      window.syncTeXDoubleClicks = [];
      document.addEventListener("dblclick", (event) => window.syncTeXDoubleClicks.push({
        x: event.clientX, y: event.clientY, tag: event.target.tagName, id: event.target.id,
        classes: event.target.className, page: event.target.closest(".pdf-page-shell")?.dataset.page
      }), true);
      new MutationObserver(() => {
        const text = document.querySelector("#toastRegion")?.textContent;
        if (text && window.syncTeXToasts.at(-1) !== text) window.syncTeXToasts.push(text);
      }).observe(document, { childList: true, subtree: true });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (entry) => {
      if (new URL(entry.url()).pathname.startsWith("/api/synctex/")) queries.push({ path: new URL(entry.url()).pathname, body: entry.postDataJSON() });
    });
    // Compilation was performed above; boot uses that exact real PDF/map pair.
    await page.route("**/api/compile", (route) => { browserCompileCalls++; return route.fulfill({ json: build }); });
    const bootCompile = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/compile");
    await page.goto(server.url);
    await (await bootCompile).finished();
    await page.waitForFunction(() => !document.querySelector("#compileButton").disabled
      && !document.querySelector(".preview-panel").classList.contains("compile-running")
      && document.querySelector('#pdfScroll .pdf-page[data-page="2"]') && document.querySelector("#sourceEditor")?.value.includes("First page"));
    await page.locator("#sourceFileSelect").selectOption("parts/second.tex");
    await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("TARGETCELL"));
    const sourcePointForWord = () => page.locator("#sourceEditor").evaluate((editor) => {
      const offset = editor.value.indexOf("repeated") + 3;
      const walker = document.createTreeWalker(document.querySelector("#sourceHighlightLayer code"), NodeFilter.SHOW_TEXT);
      let node;
      let remaining = offset;
      while ((node = walker.nextNode())) { if (remaining < node.length) break; remaining -= node.length; }
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const sourcePoint = await sourcePointForWord();
    const forwardResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/synctex/forward");
    await page.mouse.dblclick(sourcePoint.x, sourcePoint.y);
    const forward = await (await forwardResponse).json();
    assert.equal(forward.page, 2);
    await page.waitForFunction(() => document.querySelector(".pdf-source-highlight") || document.querySelector("#sourceEditor").dataset.navigationState === "error");
    assert.notEqual(await page.locator("#sourceEditor").getAttribute("data-navigation-state"), "error", JSON.stringify(await page.evaluate(() => window.syncTeXToasts)));
    await page.waitForSelector(".pdf-source-highlight");
    const highlight = await page.locator(".pdf-source-highlight").boundingBox();
    const viewport = await page.locator("#pdfScroll").boundingBox();
    assert.ok(highlight.y >= viewport.y && highlight.y < viewport.y + viewport.height * 0.7, JSON.stringify({ highlight, viewport }));
    await page.screenshot({ path: path.join(output, "synctex-source-to-pdf.png") });
    for (let index = 0; index < 5; index++) await page.locator("#zoomInButton").click();
    await page.waitForFunction(() => document.querySelector('#pdfScroll .pdf-page[data-page="2"]')?.dataset.renderZoom === "150");
    assert.equal(await page.locator(".pdf-source-highlight").count(), 0, "Zooming should remove a highlight drawn at the old scale");
    await page.locator("#sourceFileSelect").selectOption("main.tex");
    await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("First page"));
    const mathRect = checks.find((check) => check.target.line === 5).rect;
    const inversePoint = { page: 2, x: Math.max(0, mathRect.x - 8), y: mathRect.y + mathRect.height / 2 };
    const expected = await request("/api/synctex/inverse", inversePoint);
    const pdfPoint = await page.locator('#pdfScroll .pdf-page[data-page="2"]').evaluate((canvas, point) => {
      const shell = canvas.closest(".pdf-page-shell");
      const scroll = document.querySelector("#pdfScroll");
      scroll.scrollTop += shell.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 80;
      const rect = canvas.getBoundingClientRect();
      const view = canvas._pdfPage.view;
      return { x: rect.left + point.x / (view[2] - view[0]) * rect.width,
        y: rect.top + point.y / (view[3] - view[1]) * rect.height };
    }, inversePoint);
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { tag: element?.tagName, classes: element?.className,
        page: element?.closest(".pdf-page-shell")?.dataset.page,
        textSpan: Boolean(element?.closest(".pdf-text-layer span")) };
    }, pdfPoint);
    assert.equal(hit.page, "2", JSON.stringify(hit));
    assert.equal(hit.textSpan, false, "Inverse navigation must also work outside text-layer spans");
    const inverseResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/synctex/inverse", { timeout: 5000 });
    await page.mouse.dblclick(pdfPoint.x, pdfPoint.y);
    const inverse = await (await inverseResponse).json();
    assert.equal(inverse.file, expected.file);
    assert.equal(inverse.line, expected.line);
    await page.waitForFunction(({ file, line }) => {
      const editor = document.querySelector("#sourceEditor");
      return document.querySelector("#sourceFileSelect").value === file
        && editor.value.slice(0, editor.selectionStart).split("\n").length === line
        && editor.classList.contains("source-located");
    }, inverse);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sourceSelection = await page.locator("#sourceEditor").evaluate((editor) => {
      const describe = (selector) => {
        const element = document.querySelector(selector);
        const style = getComputedStyle(element);
        return { font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
          padding: style.padding, scrollTop: element.scrollTop, width: element.getBoundingClientRect().width,
          clientWidth: element.clientWidth, top: element.getBoundingClientRect().top };
      };
      const line = editor.value.slice(0, editor.selectionStart).split("\n").length;
      const walker = document.createTreeWalker(document.querySelector("#sourceHighlightLayer code"), NodeFilter.SHOW_TEXT);
      let remaining = editor.selectionStart;
      let node;
      while ((node = walker.nextNode())) { if (remaining < node.length) break; remaining -= node.length; }
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      const selectionTop = range.getBoundingClientRect().top;
      const style = getComputedStyle(editor);
      return { line, selectionStart: editor.selectionStart, selectionEnd: editor.selectionEnd,
        selectedText: editor.value.slice(editor.selectionStart, editor.selectionEnd), sourceLine: editor.value.split("\n")[line - 1],
        visualRow: Math.round((selectionTop - editor.getBoundingClientRect().top + editor.scrollTop - parseFloat(style.paddingTop)) / parseFloat(style.lineHeight)) + 1,
        gutterText: document.querySelector("#sourceLineNumbers").textContent,
        editor: describe("#sourceEditor"), highlight: describe("#sourceHighlightLayer"), gutter: describe("#sourceLineNumbers") };
    });
    assert.equal(sourceSelection.line, inverse.line);
    assert.equal(sourceSelection.selectedText, second.split("\n")[inverse.line - 1]);
    await page.screenshot({ path: path.join(output, "synctex-pdf-to-source.png") });
    assert.equal(await page.locator("#sourceEditor").getAttribute("data-navigation-state"), "synctex");
    assert.equal(await page.locator("#pdfScroll").getAttribute("data-navigation-state"), "synctex");
    const afterValidNavigation = queries.length;
    await page.locator("#sourceEditor").fill(`${second}\n% Edited after the PDF was compiled\n`);
    const dirtyPoint = await sourcePointForWord();
    await page.mouse.dblclick(dirtyPoint.x, dirtyPoint.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(queries.length, afterValidNavigation, "Unsaved source must not use stale mapping");
    await page.waitForFunction(() => document.querySelector("#saveSourceButton").disabled && document.querySelector("#sourceStatus")?.textContent.includes("已自动保存"));
    const stale = await fetch(`${server.url}/api/synctex/forward`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "parts/second.tex", line: 2, column: 1 }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "SYNCTEX_STALE");
    const staleInverse = await fetch(`${server.url}/api/synctex/inverse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(inversePoint) });
    assert.equal(staleInverse.status, 409);
    assert.equal((await staleInverse.json()).code, "SYNCTEX_STALE");
    const staleUiResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/synctex/forward");
    const stalePoint = await sourcePointForWord();
    await page.mouse.dblclick(stalePoint.x, stalePoint.y);
    assert.equal((await (await staleUiResponse).json()).code, "SYNCTEX_STALE");
    await fs.unlink(path.join(projectRoot, "main.synctex.gz"));
    const missing = await fetch(`${server.url}/api/synctex/forward`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "parts/second.tex", line: 2, column: 1 }) });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "SYNCTEX_MISSING");
    await page.waitForFunction(() => document.querySelector("#sourceEditor").dataset.navigationState === "error");
    const missingUiResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/synctex/forward");
    await page.mouse.dblclick(stalePoint.x, stalePoint.y);
    assert.equal((await (await missingUiResponse).json()).code, "SYNCTEX_MISSING");
    assert.deepEqual(errors, []);
    assert.equal(queries.filter((entry) => entry.path.endsWith("/forward")).length, 3);
    assert.equal(queries.filter((entry) => entry.path.endsWith("/inverse")).length, 1);
    assert.equal(browserCompileCalls, 1, "Navigation never compiles automatically, including stale/missing map failures");
    await fs.writeFile(path.join(output, "synctex-navigation-browser.json"), JSON.stringify({ forward, inverse, sourceSelection, browserCompileCalls, nonTextHit: hit, queries, errors }, null, 2));
    console.log("PASS: source and non-text PDF double-clicks locate both directions at 150% zoom; modified or missing maps never fall back to fuzzy matching");
  }
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({ toasts: window.syncTeXToasts, doubleClicks: window.syncTeXDoubleClicks })));
  await page?.screenshot({ path: path.join(output, "synctex-navigation-failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-synctex-navigation-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

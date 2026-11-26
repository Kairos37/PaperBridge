import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";
import { getPdfInfo } from "../lib/project.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-tree-pages-"));
let browser;
function pdfFixture(pages) {
  const font = 3 + pages;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let index = 0; index < pages; index += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${font + 1 + index} 0 R >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let index = 0; index < pages; index += 1) {
    const stream = `BT /F1 18 Tf 40 750 Td (Page ${index + 1}) Tj ET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
try {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
  for (const directory of [".output/nested", ".tmp", "output"]) await fs.mkdir(path.join(projectRoot, directory), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n% 中文字体检查\n\\begin{document}\nMain manuscript has enough scientific words for the bilingual editor.\n\\input{chapters/method}\n\\bibliography{references}\n\\end{document}\n");
  await fs.writeFile(path.join(projectRoot, "chapters/method.tex"), "The method compares different network algorithms under repeatable testing conditions.\n");
  await fs.writeFile(path.join(projectRoot, "references.bib"), "@article{sample, title={Sample Manuscript}, author={A. Author}, year={2026}}\n");
  await fs.writeFile(path.join(projectRoot, "reference.bib"), "@misc{additional, title={Additional source}}\n");
  await fs.writeFile(path.join(projectRoot, "main.pdf"), pdfFixture(13));
  const auxiliaryFiles = ["main.aux", "main.bbl", "main.blg", "main.tmp", "main.output", "main.log", "main.out", "main.toc", "main.fls", "main.fdb_latexmk", "main.synctex.gz", "main.bcf", "main.run.xml", "chapters/method.aux", ".output/main.pdf", ".output/nested/main.log", ".tmp/result.dat"];
  await Promise.all(auxiliaryFiles.map((file) => fs.writeFile(path.join(projectRoot, file), "auxiliary fixture\n")));
  await fs.writeFile(path.join(projectRoot, "output/figure.pdf"), pdfFixture(1));
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot, mainTex: "main.tex" }) });
  assert.equal(opened.ok, true);
  const pdf = await getPdfInfo(projectRoot, "main.tex");
  assert.equal(pdf.pages, 13);
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Local discovery omits dot directories; connected project payloads may include them.
  await page.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    const project = await response.json();
    const hiddenEntries = [
      ...[".output", ".output/nested", ".tmp"].map((file) => ({ path: file, type: "directory" })),
      ...auxiliaryFiles.filter((file) => file.startsWith(".")).map((file) => ({ path: file, type: "file", extension: path.extname(file) }))
    ];
    await route.fulfill({ response, json: { ...project, projectFiles: [...project.projectFiles, ...hiddenEntries] } });
  });
  await page.route("**/api/compile", (route) => route.fulfill({ json: { success: true, previewAvailable: true, pdf, errors: [], warnings: [] } }));
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.treePagesTest = { refreshProject, movePdfPage };` });
  });
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#visiblePage")?.textContent === "1/13");
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('13px "JetBrains Mono"', "Main"), document.fonts.load('13px "Sarasa Mono SC"', "中文")]);
    await document.fonts.ready;
  });
  const typography = await page.evaluate(() => {
    const family = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily;
    const size = (selector) => getComputedStyle(document.querySelector(selector)).fontSize;
    return {
      fonts: [...document.fonts].filter((font) => /JetBrains Mono|Sarasa Mono SC/.test(font.family)).map((font) => ({ family: font.family, status: font.status })),
      editorFamily: family("#sourceEditor"), highlightFamily: family("#sourceHighlightLayer"),
      editorSize: size("#sourceEditor"), highlightSize: size("#sourceHighlightLayer"), lineNumbersSize: size("#sourceLineNumbers"),
      titleWeight: getComputedStyle(document.querySelector("#sidebarPanelTitle")).fontWeight,
      uiSizes: [...new Set([...document.querySelectorAll("body *")].filter((element) =>
        !element.closest(".pdf-page-shell, .katex, svg") && element.getClientRects().length && [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
      ).map((element) => getComputedStyle(element).fontSize))].sort()
    };
  });
  assert.ok(typography.fonts.length === 2 && typography.fonts.every((font) => font.status === "loaded"), JSON.stringify(typography.fonts));
  assert.match(typography.editorFamily, /JetBrains Mono.*Sarasa Mono SC/);
  assert.equal(typography.editorFamily, typography.highlightFamily);
  assert.equal(typography.editorSize, "13px");
  assert.equal(typography.editorSize, typography.highlightSize);
  assert.equal(typography.editorSize, typography.lineNumbersSize);
  assert.equal(typography.titleWeight, "400");
  assert.ok(typography.uiSizes.every((size) => ["12px", "13px", "14px"].includes(size)), `Unexpected UI font sizes: ${typography.uiSizes}`);
  assert.equal(await page.locator("#pageStatus").textContent(), "");
  const tree = page.locator("#documentList");
  assert.equal(await tree.locator(".document-button").count(), 1);
  const project = tree.locator(".folder").first();
  assert.equal(await project.getAttribute("aria-expanded"), "false");
  await project.click();
  const sidebarMeasurement = await tree.locator('[title="reference.bib"] .document-label').evaluate((label) => {
    const sidebar = document.querySelector("#workspaceSidebar").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = getComputedStyle(label).font;
    return { width: sidebar.width, textRight: text.right - sidebar.left, threeSpaces: context.measureText("   ").width };
  });
  assert.equal(sidebarMeasurement.width, 160);
  assert.ok(sidebarMeasurement.textRight + sidebarMeasurement.threeSpaces <= sidebarMeasurement.width - 5, JSON.stringify(sidebarMeasurement));
  assert.equal(await page.locator("#documentCount, #sectionCount, #documentList .document-progress").filter({ visible: true }).count(), 0);
  const group = tree.locator('[title="辅助文件"]');
  assert.equal(await group.getAttribute("aria-expanded"), "false");
  for (const file of auxiliaryFiles) assert.equal(await tree.locator(`[title="${file}"]`).count(), 0);
  for (const file of ["main.tex", "references.bib", "main.pdf"]) assert.equal(await tree.locator(`[title="${file}"]`).count(), 1);
  assert.equal(await tree.locator('[title="output"]').count(), 1);
  await tree.locator('[title="output"]').click();
  assert.equal(await tree.locator('[title="output/figure.pdf"]').count(), 1);
  for (const directory of [".output", ".output/nested", ".tmp"]) assert.equal(await tree.locator(`[title="${directory}"]`).count(), 0);
  const suffixes = await tree.locator(".file .document-progress").allTextContents();
  assert.ok(suffixes.every((text) => text === "" || /^\d+\/\d+$/.test(text)), `Unexpected file suffixes: ${suffixes}`);
  await group.click();
  for (const file of auxiliaryFiles) assert.equal(await tree.locator(`[title="${file}"]`).count(), 1);
  for (const directory of [".output", ".output/nested", ".tmp"]) assert.equal(await tree.locator(`[title="${directory}"]`).count(), 0);
  await page.evaluate(() => window.treePagesTest.refreshProject());
  assert.equal(await project.getAttribute("aria-expanded"), "true");
  assert.equal(await group.getAttribute("aria-expanded"), "true");
  assert.equal(await tree.locator('[title="main.aux"]').count(), 1);
  await group.click();
  await page.evaluate(() => window.treePagesTest.refreshProject());
  assert.equal(await group.getAttribute("aria-expanded"), "false");
  assert.equal(await tree.locator('[title="main.aux"]').count(), 0);
  console.log("PASS: root and auxiliary group start collapsed; auxiliary files appear only in the group; ordinary source/PDF files remain visible; refresh preserves expansion state");
  await page.evaluate(() => window.treePagesTest.movePdfPage(12));
  await page.waitForFunction(() => document.querySelector("#visiblePage")?.textContent === "13/13");
  assert.equal(await page.locator("#pageStatus").textContent(), "");
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#visiblePage").textContent(), "13/13");
  assert.deepEqual(errors, []);
  await fs.mkdir("release/verification", { recursive: true });
  await page.screenshot({ path: path.resolve("release/verification/project-tree-pages.png") });
  console.log("PASS: a 13-page PDF uses only compact 1/13 through 13/13 page status, with no duplicate total-page label or browser errors");
  const handle = await page.locator("#sidebarResizeHandle").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 150);
  await page.mouse.down();
  await page.mouse.move(handle.x + 92, handle.y + 150, { steps: 6 });
  await page.mouse.up();
  const widened = (await page.locator("#workspaceSidebar").boundingBox()).width;
  assert.ok(widened > 240 && widened < 260, `Unexpected dragged width: ${widened}`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#visiblePage")?.textContent === "1/13");
  assert.equal((await page.locator("#workspaceSidebar").boundingBox()).width, widened);
  await page.locator("#projectSwitcherButton").click();
  assert.equal(await page.locator("#projectSwitcherPopover").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.locator("#syncMenuButton").click();
  assert.equal(await page.locator("#syncPopover").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = await page.locator("#workspaceSidebar").boundingBox();
  assert.ok(drawer.width >= 230 && drawer.x + drawer.width <= 390);
  await page.locator("#closeSidebarButton").click();
  assert.equal(await page.locator("#workspaceSidebar").isVisible(), false);
  await page.locator('[data-sidebar-panel="files"]').click();
  assert.equal(await page.locator("#workspaceSidebar").isVisible(), true);
  await page.evaluate(() => localStorage.setItem("paperBridge.editorFontSize", "20"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#visiblePage")?.textContent === "1/13");
  assert.equal(await page.locator("#sourceEditor").evaluate((editor) => getComputedStyle(editor).fontSize), "14px");
  await page.locator('[data-sidebar-panel="translation"]').click();
  for (let step = 0; step < 4; step += 1) await page.locator("#decreaseFontButton").click();
  assert.equal(await page.locator("#editorFontSize").textContent(), "12");
  assert.equal(await page.locator(".segment-textarea").first().evaluate((editor) => getComputedStyle(editor).fontSize), "12px");
  for (let step = 0; step < 4; step += 1) await page.locator("#increaseFontButton").click();
  assert.equal(await page.locator("#editorFontSize").textContent(), "14");
  assert.equal(await page.locator("#sourceHighlightLayer").evaluate((layer) => getComputedStyle(layer).fontSize), "14px");
  await fs.writeFile(path.resolve("release/verification/project-tree-typography.json"), JSON.stringify({ typography, sidebarMeasurement, draggedWidth: widened, mobileDrawer: drawer }, null, 2));
  console.log("PASS: bundled editor fonts load; UI uses only 12/13/14px; 160px sidebar fits reference.bib plus spaces, resizes and persists, and project/sync menus and mobile drawer work");
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-tree-pages-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

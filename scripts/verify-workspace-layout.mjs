import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-layout-"));
const projectRoot = path.join(fixtureRoot, "project");
const output = path.resolve("release/verification");
const requestedWidths = process.argv.slice(2).map(Number).filter((width) => Number.isFinite(width) && width >= 320);
const widths = requestedWidths.length ? requestedWidths : [1280, 1440, 1920, 375, 320, 414, 768];
let browser;
let page;

function pdfFixture(pageCount = 13) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pages = [];
  for (let index = 0; index < pageCount; index++) {
    const number = objects.length + 1;
    pages.push(`${number} 0 R`);
    const stream = `BT /F1 18 Tf 40 750 Td (PaperBridge workspace page ${index + 1}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${number + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pageCount} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

try {
  await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "main.tex"), [
    "\\documentclass{article}", "\\title{Reliable Networks in Motion}", "\\author{Research Group}",
    "\\begin{document}", "\\maketitle", "\\section{Introduction}",
    "Reliable communication is essential for distributed systems. This paper studies how adaptive scheduling improves throughput across changing network conditions.",
    "", "We develop a practical framework that combines local observations with a coordinated allocation strategy. The evaluation covers several representative deployment scenarios.",
    "\\subsection{Contributions}", "Our approach reduces contention while maintaining predictable performance. Each component operates with limited information and bounded overhead.",
    ...Array.from({ length: 35 }, (_, index) => `\n\\subsection{Experiment ${index + 1}}\nExperiments measure network reliability under controlled conditions and compare the proposed method with established baselines. More observations establish repeatable scientific results.`),
    "\\input{chapters/evaluation}", "\\bibliographystyle{plain}", "\\bibliography{reference}", "\\end{document}"
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "chapters", "evaluation.tex"), "\\section{Evaluation}\nWe compare the proposed method with established baselines using consistent network traces and repeatable experimental conditions.\n");
  await fs.writeFile(path.join(projectRoot, "reference.bib"), "@article{adaptive2025, title={Adaptive Scheduling for Reliable Networks}, author={Chen, Wei}, year={2025}}\n");
  await fs.writeFile(path.join(projectRoot, "notes.md"), "# Research notes\n\nReliable communication across changing networks.\n");
  for (const file of ["main.aux", "main.log", "main.out", "main.synctex.gz"]) await fs.writeFile(path.join(projectRoot, file), "Fixture auxiliary build output.\n");
  await fs.writeFile(path.join(projectRoot, "main.pdf"), pdfFixture());
  const server = await startServer({ port: 0, dataRoot: path.join(fixtureRoot, "data"), projectsRoot: path.join(fixtureRoot, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot, mainTex: "main.tex" }) });
  assert.equal(opened.ok, true, await opened.text());
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  const issues = [];
  const metrics = [];
  let compileCalls = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/compile", async (route) => {
    compileCalls++;
    const project = await fetch(`${server.url}/api/bootstrap`).then((response) => response.json());
    await route.fulfill({ json: { success: true, previewAvailable: true, skipped: false, pdf: project.pdf, errors: [], warnings: [], log: "Fixture PDF available" } });
  });
  await fs.mkdir(output, { recursive: true });
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Reliable communication") && document.querySelector("#pdfScroll .pdf-page[data-rendered='true']"));
  assert.equal(compileCalls, 1);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.id).filter((id, index, ids) => ids.indexOf(id) !== index)), []);
  const tree = page.locator("#documentList");
  assert.equal(await tree.locator(".document-button").count(), 1);
  await tree.locator(".folder").first().click();
  assert.equal(await tree.locator('[title="main.tex"]').count(), 1);
  const auxiliary = tree.locator('[title="辅助文件"]');
  assert.equal(await auxiliary.count(), 1);
  assert.equal(await auxiliary.getAttribute("aria-expanded"), "false");
  assert.equal(await tree.locator('[title="main.aux"]').count(), 0);
  await auxiliary.click();
  assert.equal(await tree.locator('[title="main.aux"]').count(), 1);
  await auxiliary.click();
  await page.screenshot({ path: path.join(output, "workspace-1440-initial.png") });
  const openMenu = async (button, menu) => {
    await page.locator(button).click();
    assert.equal(await page.locator(menu).isVisible(), true, `${button} should open ${menu}`);
    const bounds = await page.locator(menu).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1, `${menu} should fit within the viewport`);
    await page.keyboard.press("Escape");
    if (await page.locator(menu).isVisible()) await page.locator(button).click();
    await page.locator(menu).waitFor({ state: "hidden" });
  };
  await openMenu("#syncMenuButton", "#syncPopover");
  await openMenu("#projectSwitcherButton", "#projectSwitcherPopover");
  await openMenu("#insertFigureSourceButton", "#sourceInsertMenu");
  await page.locator("#sourceCreateTexButton").click();
  await page.locator("#createTexDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#createTexDialog").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.locator("#createTexDialog").waitFor({ state: "hidden" });
  await page.locator("#toggleSourceSearchButton").click();
  assert.equal(await page.locator("#sourceSearchInput").isVisible(), true);
  await page.locator("#sourceSearchInput").fill("scheduling");
  await page.waitForFunction(() => document.querySelector("#sourceSearchResults")?.children.length > 0);
  await page.locator("#toggleSourceSearchButton").click();
  await page.locator("#zoomInButton").click();
  assert.equal(await page.locator("#pdfZoomValue").textContent(), "110%");
  await page.locator("#pdfZoomValue").click();
  assert.equal(await page.locator("#pdfZoomValue").textContent(), "100%");
  await page.locator("#warningsButton").click();
  assert.equal(await page.locator("#buildDrawer").isVisible(), true);
  await page.locator("#closeWarningsButton").click();
  for (let index = 0; index < 12; index++) await page.locator("#nextPageButton").click();
  assert.equal((await page.locator("#visiblePage").textContent()).replace(/\s/g, ""), "13/13");
  assert.equal(await page.locator("#pageStatus").isVisible(), false, "The page counter should not be duplicated by another page count");
  console.log("PASS: file/auxiliary groups, menus, new-file dialog, search, PDF zoom and page navigation respond to clicks");
  for (const width of widths) {
    await page.setViewportSize({ width, height: width >= 1024 ? 960 : 844 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await page.locator("#sourceEditor").evaluate((editor) => {
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const current = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      };
      const describe = (selector) => {
        const element = document.querySelector(selector);
        const style = getComputedStyle(element);
        return { bounds: element.getBoundingClientRect().toJSON(), fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), clientWidth: element.clientWidth,
          scrollbarWidth: getComputedStyle(element, "::-webkit-scrollbar").width, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
      };
      const topbar = document.querySelector(".topbar");
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
        topbar: topbar.getBoundingClientRect().toJSON(), topbarWidth: topbar.clientWidth, topbarScrollWidth: topbar.scrollWidth,
        controls: [...topbar.querySelectorAll("button, a, select")].filter(visible).map((element) => {
          const style = getComputedStyle(element);
          return { id: element.id, bounds: element.getBoundingClientRect().toJSON(), background: style.backgroundColor,
            borderWidth: style.borderWidth, borderColor: style.borderColor, borderStyle: style.borderStyle };
        }),
        source: describe("#sourceEditor"), highlight: describe("#sourceHighlightLayer"), pdf: describe("#pdfScroll"), gutter: describe("#sourceLineNumbers"),
        panels: ["#workspaceSidebar", "#sourceView", ".preview-panel"].map(describe),
        activityRight: document.querySelector(".activity-bar").getBoundingClientRect().right,
        treeRowHeights: [...document.querySelectorAll("#documentList .document-button")].filter(visible).map((element) => element.getBoundingClientRect().height),
        secondaryToolbars: [...document.querySelectorAll("#sourceView .source-commandbar, .preview-panel .preview-toolbar")].filter(visible).length,
        newFileIcon: document.querySelector("#sourceCreateTexButton svg")?.outerHTML,
        insertIcon: document.querySelector("#insertFigureSourceButton svg")?.outerHTML
      };
    });
    metrics.push(current);
    const check = (condition, message) => { if (!condition) issues.push(`${width}px: ${message}`); };
    check(current.pageWidth <= width + 1, `page overflow ${current.pageWidth}px`);
    check(current.topbarScrollWidth <= current.topbarWidth + 1, `toolbar overflow ${current.topbarScrollWidth}px > ${current.topbarWidth}px`);
    check(current.secondaryToolbars === 0, "A second toolbar remains inside the editor or PDF panel");
    check(current.topbar.height <= 56, `toolbar is more than one row (${current.topbar.height}px)`);
    for (const control of current.controls) {
      check(control.bounds.top >= current.topbar.top - 1 && control.bounds.bottom <= current.topbar.bottom + 1, `${control.id} wraps outside the global toolbar`);
      check(control.bounds.left >= -1 && control.bounds.right <= width + 1, `${control.id} overflows the global toolbar horizontally`);
      if (control.id === "compileButton") check(!["transparent", "rgba(0, 0, 0, 0)"].includes(control.background), "Compile should have a solid background");
      else {
        check(["transparent", "rgba(0, 0, 0, 0)"].includes(control.background), `${control.id} has a filled background: ${control.background}`);
        check(control.borderStyle === "none" || parseFloat(control.borderWidth) === 0 || control.borderColor === "rgba(0, 0, 0, 0)", `${control.id} has a visible outline`);
      }
    }
    check(current.newFileIcon !== current.insertIcon, "New-file and insert controls use the same icon");
    if (current.source.bounds.width > 0) {
      check(Math.abs(current.source.lineHeight - current.source.fontSize * 1.5) < 0.1, `Editor line height is ${current.source.lineHeight} / ${current.source.fontSize}`);
      check(current.source.lineHeight === current.highlight.lineHeight && current.source.lineHeight === current.gutter.lineHeight, "Editor/highlight/gutter line heights differ");
      check(current.source.bounds.width === current.highlight.bounds.width && current.source.clientWidth === current.highlight.clientWidth, "Editor and highlight widths differ");
      check(current.source.scrollbarWidth === "7px" && current.highlight.scrollbarWidth === "7px", `Source/highlight scrollbars are ${current.source.scrollbarWidth}/${current.highlight.scrollbarWidth}`);
    }
    if (current.pdf.bounds.width > 0) check(current.pdf.scrollbarWidth === "7px", `PDF scrollbar width is ${current.pdf.scrollbarWidth}`);
    check(current.treeRowHeights.every((height) => height >= 26 && height <= 28), `Tree rows are ${current.treeRowHeights.join(", ")}px high`);
    check(current.panels.every((panel) => panel.borders.every((border) => parseFloat(border) <= 1)), "A panel divider exceeds 1px");
    if (width <= 1040) check(Math.abs(current.panels[0].bounds.left - current.activityRight) <= 1, "Sidebar drawer does not align with the activity bar");
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`) });
    if (width <= 768) {
      await openMenu("#syncMenuButton", "#syncPopover");
      await openMenu("#projectSwitcherButton", "#projectSwitcherPopover");
      await openMenu("#insertFigureSourceButton", "#sourceInsertMenu");
      await page.locator("#closeSidebarButton").click();
      assert.equal(await page.locator("#workspaceSidebar").isVisible(), false);
      await page.screenshot({ path: path.join(output, `workspace-${width}-editor.png`) });
      await page.locator('[data-sidebar-panel="files"]').click();
    }
  }
  await fs.writeFile(path.join(output, "workspace-layout-results.json"), JSON.stringify({ compileCalls, errors, issues, metrics }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(issues, []);
  console.log(`PASS: single toolbar, borderless secondary controls, matching source layers, 1.5 line spacing, 7px scrollbars, 27px tree rows and no overflow at ${widths.join("/")}px`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "workspace-layout-failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(fixtureRoot), os.tmpdir());
  assert.ok(path.basename(fixtureRoot).startsWith("paperbridge-layout-"));
  await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

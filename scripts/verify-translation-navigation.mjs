import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-translation-ui-"));
const projectRoot = path.join(root, "project");
const output = path.resolve("release/verification");
let browser;
let desktop;
let page;
let releaseDocument;
try {
  await fs.mkdir(projectRoot);
  const introduction = Array.from({ length: 14 }, (_, index) =>
    "Introduction paragraph " + index + " describes reliable communication across changing network conditions with repeatable scientific experiments."
  );
  await fs.writeFile(path.join(projectRoot, "main.tex"), [
    "\\documentclass{article}", "\\begin{document}", "\\section{Introduction}",
    introduction.join("\n\n"), "", "\\section{Evaluation}",
    "Evaluation compares established baselines under consistent workloads and repeatable experimental conditions.",
    "\\input{chapter}", "\\end{document}"
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "chapter.tex"), [
    "\\section{Method}",
    "The proposed method coordinates independent participants using local observations and adaptive resource allocation."
  ].join("\n"));
  let server;
  if (process.env.PAPERBRIDGE_DESKTOP_PATH) {
    const storageRoot = path.join(root, "desktop");
    await fs.mkdir(path.join(storageRoot, "AppData"), { recursive: true });
    desktop = await electron.launch({
      executablePath: path.resolve(process.env.PAPERBRIDGE_DESKTOP_PATH),
      args: ["--disable-gpu"],
      env: { ...process.env, PAPERBRIDGE_STORAGE_ROOT: storageRoot,
        PAPERBRIDGE_DATA_ROOT: path.join(root, "data"), PAPERBRIDGE_PROJECTS_ROOT: path.join(root, "projects") }
    });
    page = await desktop.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
    await desktop.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
        window.hide();
      }
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    server = { url: new URL(page.url()).origin };
  } else {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    browser = await chromium.launch({
      executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  }
  const opened = await fetch(server.url + "/api/project/open", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true, await opened.text());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Introduction paragraph"));
  const menu = page.locator("#translationSectionSelect");
  const translation = page.locator('[data-sidebar-panel="translation"]');
  const source = page.locator('[data-mode="source"]');
  const waitDocument = (file) => page.waitForFunction((expected) => {
    const rows = [...document.querySelectorAll("#segmentList .segment-row")];
    return document.querySelector(".workspace")?.dataset.mode === "edit"
      && rows.length > 0 && rows.every((row) => row.dataset.file === expected);
  }, file);
  await translation.click();
  await waitDocument("main.tex");
  assert.equal(await menu.isEnabled(), true);
  assert.deepEqual(await menu.locator("optgroup").evaluateAll((groups) => groups.map((group) => group.label)), ["main.tex", "chapter.tex"]);
  await menu.selectOption("main.tex:section:2");
  await page.waitForFunction(() => {
    const row = document.querySelector('#segmentList .segment-row.pdf-located');
    if (!row) return false;
    const bounds = row.getBoundingClientRect();
    const viewport = document.querySelector("#segmentList").getBoundingClientRect();
    return bounds.top >= viewport.top && bounds.top < viewport.bottom;
  });
  await menu.selectOption("chapter.tex:section:1");
  await waitDocument("chapter.tex");
  const draft = "This translation draft must survive every file and chapter switch.";
  await page.locator(".segment-textarea.chinese").fill(draft);
  await page.waitForFunction(() => !document.querySelector(".segment-textarea.chinese")?.classList.contains("changed"));
  console.log("PASS: project chapter menu switches files and scrolls to the selected section");

  await source.click();
  await page.waitForFunction(() => document.querySelector("#sourceFileSelect")?.value === "chapter.tex");
  await page.locator("#sourceFileSelect").selectOption("main.tex");
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Introduction paragraph"));
  await translation.click();
  await waitDocument("main.tex");
  assert.match(await page.locator("#topCurrentFile").textContent(), /main\.tex/);
  await source.click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Introduction paragraph"));
  await page.locator("#sourceCreateTexButton").click();
  await page.locator("#newTexFileName").fill("blank.tex");
  await page.locator("#newTexInsertion").selectOption("none");
  await page.locator("#submitCreateTexButton").click();
  await page.waitForFunction(() => document.querySelector("#sourceFileSelect")?.value === "blank.tex"
    && document.querySelector("#sourceEditor")?.value === "" && !document.querySelector("#sourceEditor")?.disabled);
  await translation.click();
  await page.waitForFunction(() => document.querySelector("#currentFile")?.textContent === "blank"
    && document.querySelector("#segmentList .empty-state")?.textContent.includes("没有检测到"));
  assert.equal(await page.locator("#segmentList .segment-row").count(), 0);
  assert.equal(await page.locator("#translateFileButton").isDisabled(), true);
  assert.equal(await page.locator("#translateSectionButton").isDisabled(), true);
  assert.equal(await menu.isEnabled(), true);
  await menu.selectOption("chapter.tex:section:1");
  await waitDocument("chapter.tex");
  assert.equal(await page.locator(".segment-textarea.chinese").inputValue(), draft);
  await menu.selectOption("file:blank.tex");
  await page.waitForSelector("#segmentList .empty-state");
  console.log("PASS: newly created empty unreferenced TeX opens its own translation view and preserves existing drafts");

  await source.click();
  await page.waitForFunction(() => document.querySelector("#sourceFileSelect")?.value === "blank.tex"
    && document.querySelector("#sourceEditor")?.value === "" && !document.querySelector("#sourceEditor")?.disabled);
  const newContent = "\\section{New chapter}\nA newly written manuscript contains enough academic words to become a translatable paragraph.\n";
  await page.locator("#sourceEditor").fill(newContent);
  await translation.click();
  await waitDocument("blank.tex");
  assert.equal(await page.locator(".segment-textarea.english").inputValue(), newContent.split("\n")[1]);
  assert.equal(await menu.inputValue(), "blank.tex:section:1");
  assert.equal(await page.locator("#translateFileButton").isEnabled(), true);
  const saved = await fetch(server.url + "/api/source?file=blank.tex").then((response) => response.json());
  assert.equal(saved.content, newContent);
  await fs.mkdir(output, { recursive: true });
  if (!desktop) await page.screenshot({ path: path.join(output, "translation-navigation.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await menu.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  if (!desktop) await page.screenshot({ path: path.join(output, "translation-navigation-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  console.log("PASS: entering translation saves new source immediately and enables the current file's translation");

  const delayed = new Promise((resolve) => { releaseDocument = resolve; });
  let notifyRequest;
  const requested = new Promise((resolve) => { notifyRequest = resolve; });
  await page.route("**/api/document?file=main.tex", async (route) => {
    notifyRequest();
    await delayed;
    await route.continue();
  });
  await menu.selectOption("main.tex:section:1");
  await requested;
  await menu.selectOption("chapter.tex:section:1");
  await waitDocument("chapter.tex");
  const returned = page.waitForResponse((response) => response.url().endsWith("/api/document?file=main.tex"));
  releaseDocument();
  await (await returned).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await menu.inputValue(), "chapter.tex:section:1");
  assert.equal(await page.locator(".segment-textarea.chinese").inputValue(), draft);
  await page.unroute("**/api/document?file=main.tex");
  await page.locator('[data-sidebar-panel="files"]').click();
  await page.locator('.document-button[title="blank.tex"]').click();
  await waitDocument("blank.tex");
  assert.deepEqual(errors, []);
  console.log("PASS: rapid switching ignores late document responses, file tree navigation works, and no browser errors");
} catch (error) {
  if (page && !desktop) {
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "translation-navigation-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  releaseDocument?.();
  if (desktop) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await desktop.close();
  }
  await browser?.close();
  await stopServer();
  assert.ok(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("paperbridge-translation-ui-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

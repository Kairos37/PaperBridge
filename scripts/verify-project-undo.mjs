import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-project-undo-ui-"));
let browser;
let page;
try {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const original = ["\\documentclass{article}", "\\begin{document}",
    "The first academic paragraph contains enough English prose for editing.", "",
    "The second academic paragraph contains enough English prose for editing.", "\\end{document}"].join("\n");
  await fs.writeFile(path.join(projectRoot, "main.tex"), original);
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true);
  const configured = await fetch(`${server.url}/api/config`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoCompile: false })
  });
  assert.equal(configured.ok, true);
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.projectUndoVerificationState = state;` });
  });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) requests.push({ pathname, method: request.method(), body: request.postDataJSON() });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("first academic paragraph"));
  await page.locator('[data-sidebar-panel="translation"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#segmentList .segment-row").length === 2);
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  await page.locator("#segmentList .delete-paragraph-button").first().click();
  await page.waitForFunction(() => document.querySelectorAll("#segmentList .segment-row").length === 1 && !document.querySelector("#undoButton").disabled);
  const deleteRequest = requests.find((request) => request.pathname === "/api/segment/delete");
  assert.equal(deleteRequest.body.deferCompile, true);
  const undoResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/undo");
  await page.locator("#undoButton").click();
  const undo = await (await undoResponse).json();
  await page.waitForFunction(() => document.querySelectorAll("#segmentList .segment-row").length === 2);
  await page.waitForLoadState("networkidle");
  assert.equal(undo.document.segments.length, 2);
  assert.equal(requests.find((request) => request.pathname === "/api/undo").body.refreshProject, false);
  assert.equal(requests.filter((request) => request.pathname === "/api/bootstrap").length, 0);
  assert.equal(requests.filter((request) => request.pathname === "/api/document").length, 0);
  assert.ok(requests.filter((request) => request.pathname === "/api/source").length <= 2, "each operation may read source once for fast preview");
  console.log("PASS: paragraph deletion and toolbar undo restore content without bootstrap or redundant document/source loads");

  await page.locator('[data-mode="source"]').click();
  await page.waitForFunction((expected) => document.querySelector("#sourceEditor")?.value === expected, original);
  await page.waitForLoadState("networkidle");
  const changed = `${original}\n% Saved source change\n`;
  const savedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/source" && response.request().method() === "POST");
  await page.locator("#sourceEditor").fill(changed);
  assert.equal((await savedResponse).ok(), true);
  await page.waitForFunction(() => !window.projectUndoVerificationState.sourceDirty && !document.querySelector("#undoButton").disabled);
  requests.length = 0;
  const sourceUndoResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/undo");
  await page.locator("#undoButton").click();
  const sourceUndo = await (await sourceUndoResponse).json();
  await page.waitForFunction((expected) => document.querySelector("#sourceEditor")?.value === expected, original);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.evaluate(() => window.projectUndoVerificationState.sourceHash), sourceUndo.source.sourceHash);
  assert.equal(await page.evaluate(() => window.projectUndoVerificationState.sourceSavedContent), original);
  assert.equal(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), original);
  assert.equal(requests.filter((request) => ["/api/bootstrap", "/api/document", "/api/source/annotations"].includes(request.pathname)).length, 0);
  assert.ok(requests.filter((request) => request.pathname === "/api/source").length <= 1, "undo may read source once for fast preview");
  console.log("PASS: source toolbar undo restores saved content and source hash directly from its response");

  await page.locator("#sourceCreateTexButton").click();
  await page.locator("#newTexFileName").fill("empty.tex");
  await page.locator("#newTexInsertion").selectOption("none");
  await page.locator("#submitCreateTexButton").click();
  await page.waitForFunction(() => document.querySelector("#sourceFileSelect")?.value === "empty.tex"
    && document.querySelector("#sourceEditor")?.value === "" && !document.querySelector("#undoButton").disabled);
  requests.length = 0;
  const createUndoResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/undo");
  await page.locator("#undoButton").click();
  const createUndo = await (await createUndoResponse).json();
  assert.equal(createUndo.filesChanged, true);
  assert.equal(createUndo.source, null);
  await page.waitForFunction(() => document.querySelector("#sourceFileSelect")?.value === "main.tex"
    && document.querySelector("#sourceEditor")?.value.includes("first academic paragraph")
    && window.projectUndoVerificationState.sourceFile === "main.tex");
  await assert.rejects(fs.access(path.join(projectRoot, "empty.tex")));
  assert.ok(requests.some((request) => request.pathname === "/api/bootstrap"));
  assert.deepEqual(errors, []);
  console.log("PASS: undoing a newly created empty file refreshes the file list and returns to an existing source file");
} catch (error) {
  if (page) {
    await fs.mkdir(path.resolve("release/verification"), { recursive: true });
    await page.screenshot({ path: path.resolve("release/verification/project-undo-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-project-undo-ui-"));
  await fs.rm(root, { recursive: true, force: true });
}

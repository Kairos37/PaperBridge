import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";
import { getPdfInfo } from "../lib/project.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-manual-pdf-"));
const projectRoot = path.join(root, "project");
const otherProjectRoot = path.join(root, "other-project");
const output = path.resolve("release/verification");
let browser;
let page;
let releaseCompile;

function pdfFixture(text) {
  const stream = `BT /F1 18 Tf 40 750 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

try {
  for (const [directory, name] of [[projectRoot, "First"], [otherProjectRoot, "Other"]]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "main.tex"), [
      "\\documentclass{article}", "\\begin{document}", "\\section{Introduction}",
      `${name} project studies reliable communication and repeatable scientific experiments.`,
      "\\input{chapter}", "\\end{document}"
    ].join("\n"));
    await fs.writeFile(path.join(directory, "chapter.tex"), "\\section{Method}\nThe proposed method evaluates independent network observations and adaptive resource allocation.\n");
    await fs.writeFile(path.join(directory, "notes.md"), "# Research notes\n\nMarkdown editing must keep the formal paper PDF visible.\n");
    await fs.writeFile(path.join(directory, "main.pdf"), pdfFixture("Manual PDF fixture 0"));
  }
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const request = async (url, body) => {
    const response = await fetch(`${server.url}${url}`, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : undefined);
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  };
  await request("/api/project/open", { projectRoot: otherProjectRoot, mainTex: "main.tex" });
  await request("/api/project/open", { projectRoot, mainTex: "main.tex" });
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  const requests = [];
  const sourceSaves = [];
  const checkpoints = [];
  let compileCalls = 0;
  let pullCalls = 0;
  let diagnosisCalls = 0;
  let lastBuild;
  let compileHold;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (entry) => {
    const pathname = new URL(entry.url()).pathname;
    requests.push({ method: entry.method(), pathname });
    if (pathname === "/api/source" && entry.method() === "POST") sourceSaves.push(entry.postDataJSON());
  });
  await page.addInitScript(() => {
    window.manualPdfAudit = { modes: [], htmlPreviewSeen: false };
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "attributes" && change.target.classList.contains("preview-panel")) {
          window.manualPdfAudit.modes.push(change.target.dataset.previewMode);
          if (change.oldValue) window.manualPdfAudit.modes.push(change.oldValue);
        }
      }
      if (document.querySelector(".fast-preview-document, .markdown-preview-document")) window.manualPdfAudit.htmlPreviewSeen = true;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-preview-mode"] });
  });
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    const source = (await response.text()).replace("collaboration = mountCollaboration({", "collaboration = mountCollaboration(window.manualPdfCollaborationOptions = {");
    await route.fulfill({ response, body: `${source}\nwindow.manualPdfTest = { snapshot: () => ({ sourceFile: state.sourceFile, dirty: state.sourceDirty, saving: state.sourceSaveInFlight, pendingWrites: state.pendingWrites, compiling: state.compileInFlight }) };` });
  });
  const decorateProject = (project) => ({ ...project, config: { ...project.config, autoCompile: true },
    lastBuild: lastBuild || project.lastBuild,
    git: { ...project.git, available: true, dirty: false, overleaf: false, provider: "git", remoteName: "paperbridge",
      remoteLabel: "Fixture Remote", ahead: 0, behind: 0, changedFiles: [], remotes: [{ name: "paperbridge", label: "Fixture Remote", provider: "git" }] }
  });
  await page.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: decorateProject(await response.json()) });
  });
  await page.route("**/api/git/pull", async (route) => {
    pullCalls += 1;
    const project = decorateProject(await request("/api/bootstrap"));
    await route.fulfill({ json: { git: project.git, project } });
  });
  await page.route("**/api/compile/diagnose", async (route) => {
    diagnosisCalls += 1;
    await route.fulfill({ json: { summary: "Unexpected warning diagnosis", issues: [] } });
  });
  await page.route("**/api/compile", async (route) => {
    compileCalls += 1;
    const version = compileCalls;
    if (compileHold) await compileHold;
    const project = await request("/api/bootstrap");
    const activeRoot = project.config.projectRoot;
    await fs.writeFile(path.join(activeRoot, "main.pdf"), pdfFixture(`Manual PDF fixture ${version}`));
    const warning = "LaTeX Warning: Unicode en dash – (U+2013) in text; output PDF is available.";
    lastBuild = { success: version !== 2, skipped: false, previewAvailable: true, recoverable: version === 2,
      warnings: version === 2 ? [warning] : [], errors: version === 2 ? ["Unicode character – (U+2013) not set up for use with LaTeX."] : [], layoutChanges: [], locations: [],
      log: version === 2 ? `${warning}\nOutput written on main.pdf (1 page).` : "Output written on main.pdf (1 page).",
      pdf: await getPdfInfo(activeRoot, "main.tex"), engine: "fixture", mode: "full" };
    await route.fulfill({ json: lastBuild });
  });
  const idle = () => page.waitForFunction(() => {
    const state = window.manualPdfTest?.snapshot();
    return state && !state.dirty && !state.saving && !state.pendingWrites && !state.compiling;
  }, null, { timeout: 30000 });
  const waitPdf = (version) => page.waitForFunction((number) => document.querySelector(".preview-panel")?.dataset.previewMode === "pdf"
    && document.querySelector("#pdfScroll .pdf-page")
    && document.querySelector("#pdfScroll .pdf-text-layer")?.textContent.includes(`Manual PDF fixture ${number}`), version, { timeout: 30000 });
  const checkpoint = async (name, count) => {
    await idle();
    assert.equal(compileCalls, count, `${name}: unexpected automatic compilation`);
    assert.equal(await page.locator(".preview-panel").getAttribute("data-preview-mode"), "pdf");
    assert.equal(await page.locator("#pdfScroll .pdf-page").count(), 1, `${name}: formal PDF should remain visible`);
    assert.equal(await page.locator(".fast-preview-document, .markdown-preview-document").count(), 0);
    checkpoints.push({ name, compileCalls });
  };
  await page.goto(server.url);
  await waitPdf(1);
  await checkpoint("initial project open", 1);
  console.log("PASS: initialization compiles the opened project exactly once and shows its formal PDF");

  const editor = page.locator("#sourceEditor");
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("First project"));
  await editor.fill(`${await editor.inputValue()}\n% Edited without refreshing the PDF\n`);
  await checkpoint("automatic source save", 1);
  assert.ok(sourceSaves.length > 0);
  assert.ok(sourceSaves.every((save) => save.deferCompile === true));
  await page.locator("#sourceFileSelect").selectOption("chapter.tex");
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("proposed method"));
  await checkpoint("switch TeX file", 1);
  await page.locator("#sourceFileSelect").selectOption("notes.md");
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Markdown editing"));
  await checkpoint("switch Markdown file", 1);
  await page.locator("#sourceFileSelect").selectOption("main.tex");
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("First project"));
  await page.evaluate(async () => {
    const state = window.manualPdfTest.snapshot();
    window.manualPdfCollaborationOptions.onText(state.sourceFile, document.querySelector("#sourceEditor").value, [0, 0]);
    await window.manualPdfCollaborationOptions.onSaved([]);
    await window.manualPdfCollaborationOptions.onProject();
  });
  await checkpoint("collaboration callbacks and project refresh", 1);
  await page.locator("#syncMenuButton").click();
  await page.locator("#pullButton").click();
  await page.waitForFunction(() => !document.querySelector("#pullButton").disabled);
  assert.equal(pullCalls, 1);
  await checkpoint("pull remote changes", 1);
  console.log("PASS: editing, saving, TeX/Markdown switching, collaboration, and pull preserve the PDF without compiling");

  compileHold = new Promise((resolve) => { releaseCompile = resolve; });
  await page.locator("#compileButton").click();
  await page.waitForFunction(() => window.manualPdfTest.snapshot().compiling);
  assert.equal(compileCalls, 2);
  assert.equal(await page.locator("#pdfScroll .pdf-page").count(), 1, "Previous valid PDF remains visible while compiling");
  releaseCompile();
  compileHold = null;
  await waitPdf(2);
  await checkpoint("manual compile with a recoverable Unicode warning", 2);
  assert.equal(diagnosisCalls, 0);
  assert.equal(await page.locator("#buildDrawer").isVisible(), false);
  assert.equal(await page.locator("#compileDiagnosis").isVisible(), false);
  console.log("PASS: manual compile runs once, retains the old PDF while busy, and displays a warning-bearing new PDF without diagnosis");

  await page.locator("#projectSwitcherButton").click();
  await page.locator("#projectSwitcherList .project-switcher-item").filter({ hasText: "other-project" }).click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Other project"));
  await waitPdf(3);
  await checkpoint("explicitly open another project", 3);
  const audit = await page.evaluate(() => window.manualPdfAudit);
  assert.equal(audit.htmlPreviewSeen, false);
  assert.ok(audit.modes.every((mode) => mode === "pdf"), `Unexpected preview modes: ${audit.modes}`);
  assert.equal(diagnosisCalls, 0);
  assert.deepEqual(errors, []);
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "manual-pdf-preview.png") });
  await fs.writeFile(path.join(output, "manual-pdf-preview.json"), JSON.stringify({
    compileCalls, pullCalls, diagnosisCalls, sourceSaveCount: sourceSaves.length, checkpoints, audit, errors,
    previewRequests: requests.filter((entry) => /preview|compile|pdf/.test(entry.pathname))
  }, null, 2));
  console.log("PASS: opening a different project compiles exactly once; all preview modes stay PDF and no browser errors occur");
} catch (error) {
  if (page) {
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "manual-pdf-preview-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  releaseCompile?.();
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-manual-pdf-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

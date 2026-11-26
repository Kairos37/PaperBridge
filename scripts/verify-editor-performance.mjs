import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

// baseline serves the last packaged app.js so its input/undo paths are exact.
// No application files or real projects are modified by this comparison.
const mode = process.argv[2] || "fixed";
assert.ok(["baseline", "fixed"].includes(mode), "Usage: node scripts/verify-editor-performance.mjs [baseline|fixed] [--assert-native]");
const assertNative = process.argv.includes("--assert-native");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-editor-performance-"));
const reportPath = path.resolve(`release/verification/editor-performance-${mode}.json`);
let browser;

function installInstrumentation() {
  const perf = window.editorPerformance = {
    actions: [], checkpoints: new Map(), pending: new Map(), current: null, armed: "",
    snapshot() {
      const editor = elements.sourceEditor;
      return { length: editor.value.length, selectionStart: editor.selectionStart, selectionEnd: editor.selectionEnd,
        scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft, dirty: state.sourceDirty,
        sourceSaveInFlight: state.sourceSaveInFlight, undoCount: state.undoCount };
    },
    checkpoint(name) {
      this.checkpoints.set(name, { value: elements.sourceEditor.value, ...this.snapshot() });
    },
    arm(label, checkpoint) { this.armed = label; this.expectedCheckpoint = checkpoint; },
    compare(name) {
      const previous = this.checkpoints.get(name);
      const current = this.snapshot();
      return { ...current, contentRestored: elements.sourceEditor.value === previous.value,
        selectionRestored: current.selectionStart === previous.selectionStart && current.selectionEnd === previous.selectionEnd,
        scrollRestored: Math.abs(current.scrollTop - previous.scrollTop) <= 1 && Math.abs(current.scrollLeft - previous.scrollLeft) <= 1,
        scrollDelta: current.scrollTop - previous.scrollTop,
        expectedSelection: [previous.selectionStart, previous.selectionEnd], expectedScrollTop: previous.scrollTop };
    },
    idle() {
      return !state.sourceDirty && !state.sourceSaveInFlight && !state.pendingWrites
        && !state.fastPreviewTimer && !this.pending.size;
    },
    prepare() {
      const editor = elements.sourceEditor;
      const offset = editor.value.indexOf("EDITOR_PERFORMANCE_TARGET") + "EDITOR_PERFORMANCE_".length;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(offset, offset);
      scrollSourceOffsetIntoView(offset);
    }
  };
  const track = (name, original) => function (...args) {
    const action = perf.current;
    const record = { name, started: performance.now() };
    action?.calls.push(record);
    let result;
    try { result = original.apply(this, args); }
    finally { record.syncMs = performance.now() - record.started; }
    if (!result?.then) { record.totalMs = record.syncMs; return result; }
    perf.pending.set(name, (perf.pending.get(name) || 0) + 1);
    const done = () => {
      record.totalMs = performance.now() - record.started;
      const count = perf.pending.get(name) - 1;
      if (count) perf.pending.set(name, count); else perf.pending.delete(name);
    };
    return result.then((value) => { done(); return value; }, (error) => { done(); throw error; });
  };
  updateSourceLineNumbers = track("updateSourceLineNumbers", updateSourceLineNumbers);
  updateSourceSyntaxHighlight = track("updateSourceSyntaxHighlight", updateSourceSyntaxHighlight);
  refreshSourceSearch = track("refreshSourceSearch", refreshSourceSearch);
  renderSectionList = track("renderSectionList", renderSectionList);
  renderFastPreview = track("renderFastPreview", renderFastPreview);
  saveSourceFile = track("saveSourceFile", saveSourceFile);
  undoLastChange = track("undoLastChange", undoLastChange);
  document.addEventListener("keydown", (event) => {
    if (!perf.armed || event.target !== elements.sourceEditor || !["Backspace", "Delete", "z"].includes(event.key)) return;
    const action = { label: perf.armed, key: event.key, started: performance.now(), before: perf.snapshot(), calls: [], inputTypes: [] };
    const previousValue = elements.sourceEditor.value;
    const expected = perf.expectedCheckpoint ? perf.checkpoints.get(perf.expectedCheckpoint).value : null;
    perf.armed = "";
    perf.current = action;
    perf.actions.push(action);
    requestAnimationFrame(() => {
      action.nextFrameMs = performance.now() - action.started;
      requestAnimationFrame(() => { action.presentedMs = performance.now() - action.started; });
    });
    const checkEffect = () => {
      if (expected !== null ? elements.sourceEditor.value === expected : elements.sourceEditor.value !== previousValue) {
        requestAnimationFrame(() => { action.effectPresentedMs = performance.now() - action.started; });
      } else requestAnimationFrame(checkEffect);
    };
    requestAnimationFrame(checkEffect);
  }, true);
  elements.sourceEditor.addEventListener("input", (event) => {
    if (perf.current) perf.current.inputTypes.push(event.inputType || "synthetic");
  });
}

try {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const chunks = ["\\documentclass{article}", "\\begin{document}"];
  let section = 0;
  while (Buffer.byteLength(chunks.join("\n\n")) < 150 * 1024) {
    chunks.push(`\\section{Evaluation scenario ${++section}}`,
      ...Array.from({ length: 4 }, (_, index) => `Scenario ${section}.${index} evaluates \\textbf{adaptive network scheduling} with \\emph{independent measurements} and \\cite{baseline2024}. The experiments repeat across packet sizes, user populations, and propagation conditions to verify robust conclusions. The reference model uses $x_i + y_i = z_i$ and compares \\texttt{latency}, throughput, and reliability under carefully controlled workloads.`));
  }
  chunks.splice(Math.floor(chunks.length * 0.6), 0, "EDITOR_PERFORMANCE_TARGET marks the editable sentence for native undo testing.");
  chunks.push("\\end{document}");
  const content = chunks.join("\n\n");
  await fs.writeFile(path.join(projectRoot, "main.tex"), content);
  await fs.writeFile(path.join(projectRoot, "references.bib"), "@article{baseline2024, title={Baseline model}, author={Doe, Jane}, year={2024}}\n");
  let appSource = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  if (mode === "baseline") {
    const asar = createRequire(import.meta.url)("@electron/asar");
    const archive = path.resolve(process.env.PAPERBRIDGE_BASELINE_ASAR || "release/windows/win-unpacked/resources/app.asar");
    appSource = asar.extractFile(archive, path.join("public", "app.js")).toString("utf8");
  }
  const instrumentedSource = `${appSource}\n(${installInstrumentation.toString()})();`;
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true);
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/undo") requests.push(Date.now());
  });
  await page.route("**/app.js", (route) => route.fulfill({ contentType: "text/javascript", body: instrumentedSource }));
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("EDITOR_PERFORMANCE_TARGET"));
  await page.waitForFunction(() => window.editorPerformance?.idle(), null, { timeout: 90000 });
  const measurements = [];
  const editor = page.locator("#sourceEditor");
  const prepare = async (checkpoint) => {
    await page.evaluate(() => window.editorPerformance.prepare());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate((name) => window.editorPerformance.checkpoint(name), checkpoint);
  };
  const key = async (label, keyName, checkpoint, waitForSave = false) => {
    const requestCount = requests.length;
    await page.evaluate(({ label, checkpoint }) => window.editorPerformance.arm(label, checkpoint), { label, checkpoint });
    await editor.press(keyName);
    await page.waitForFunction((name) => window.editorPerformance.actions.some((action) => action.label === name && action.effectPresentedMs !== undefined), label, { timeout: 90000 });
    if (waitForSave) await page.waitForFunction(() => window.editorPerformance.idle(), null, { timeout: 90000 });
    else await page.waitForFunction(() => !window.editorPerformance.pending.has("undoLastChange"), null, { timeout: 90000 });
    measurements.push(await page.evaluate(({ label, checkpoint, undoRequests }) => {
      const action = window.editorPerformance.actions.find((item) => item.label === label);
      return { ...action, completedMs: performance.now() - action.started, undoRequests,
        highlightMatches: elementsSourceTextMatches(),
        after: checkpoint ? window.editorPerformance.compare(checkpoint) : window.editorPerformance.snapshot() };
      function elementsSourceTextMatches() {
        const editor = document.querySelector("#sourceEditor");
        return document.querySelector("#sourceHighlightLayer code")?.textContent === editor.value + "\u200b";
      }
    }, { label, checkpoint, undoRequests: requests.length - requestCount }));
  };
  await prepare("backspace");
  await key("Backspace", "Backspace");
  await key("Ctrl+Z before autosave", "Control+z", "backspace");
  await page.waitForFunction(() => window.editorPerformance.idle(), null, { timeout: 90000 });
  await prepare("delete");
  await key("Delete", "Delete");
  await key("Ctrl+Z after Delete", "Control+z", "delete");
  await page.waitForFunction(() => window.editorPerformance.idle(), null, { timeout: 90000 });
  await prepare("savedBackspace");
  await key("Backspace then autosave", "Backspace", null, true);
  await key("Ctrl+Z after autosave", "Control+z", "savedBackspace", true);
  await prepare("block");
  await page.evaluate(() => {
    const editor = document.querySelector("#sourceEditor");
    editor.setSelectionRange(editor.selectionStart - 1000, editor.selectionStart + 5000);
    window.editorPerformance.checkpoint("block");
  });
  await key("Delete selected block", "Delete");
  await key("Ctrl+Z after block delete", "Control+z", "block");
  const report = {
    mode, date: new Date().toISOString(), contentBytes: Buffer.byteLength(content), sourceLines: content.split("\n").length,
    sections: section, viewport: { width: 1440, height: 960 }, undoRequests: requests.length, errors,
    measurements: measurements.map(({ calls, ...measurement }) => ({ ...measurement,
      calls: calls.map(({ started, ...call }) => call).sort((a, b) => b.syncMs - a.syncMs) }))
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, mode, contentBytes: report.contentBytes, undoRequests: report.undoRequests,
    measurements: report.measurements.map((item) => ({ label: item.label,
      nextFrameMs: Math.round(item.nextFrameMs), presentedMs: Math.round(item.presentedMs), effectPresentedMs: Math.round(item.effectPresentedMs),
      completedMs: Math.round(item.completedMs), undoRequests: item.undoRequests,
      dirtyBefore: item.before.dirty, contentRestored: item.after.contentRestored, selectionRestored: item.after.selectionRestored,
      scrollRestored: item.after.scrollRestored, scrollDelta: item.after.scrollDelta,
      highlightMatches: item.highlightMatches,
      slowest: item.calls.slice(0, 3).map((call) => ({ name: call.name, syncMs: Math.round(call.syncMs), totalMs: Math.round(call.totalMs) })) }))
  }, null, 2));
  assert.deepEqual(errors, []);
  for (const measurement of measurements) {
    assert.equal(measurement.highlightMatches, true, `${measurement.label} should preserve the complete highlight text`);
  }
  if (assertNative) {
    for (const measurement of measurements.filter((item) => item.key === "z")) {
      assert.equal(measurement.undoRequests, 0, `${measurement.label} should use native undo`);
      assert.equal(measurement.after.contentRestored, true, `${measurement.label} should restore content`);
      assert.equal(measurement.after.selectionRestored, true, `${measurement.label} should restore caret/selection`);
      // Restoring a selection spanning several screens may natively reveal its
      // far end; collapsed-caret undo should preserve the existing viewport.
      if (measurement.after.expectedSelection[0] === measurement.after.expectedSelection[1]) {
        assert.equal(measurement.after.scrollRestored, true, `${measurement.label} should preserve scrolling`);
      }
    }
  }
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-editor-performance-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

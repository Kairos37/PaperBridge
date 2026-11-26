import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const temp = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temp, "paperbridge-folder-sync-"));
const first = path.join(root, "版本甲", "paper");
const second = path.join(root, "版本乙", "paper");
const foreign = path.join(root, "未登记");
const tex = (text, bibliography = "") => ["\\documentclass{article}", "\\begin{document}", text, bibliography, "\\end{document}"].join("\n");
let desktop;
try {
  for (const folder of [first, second, foreign]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(first, "main.tex"), tex("The first version describes a radio control experiment in the local laboratory."));
  await fs.writeFile(path.join(second, "main.tex"), tex(
    "The second version presents a revised control experiment under different conditions.", "\\bibliography{extra}"
  ));

  desktop = await electron.launch({
    args: [".", "--disable-gpu"],
    env: {
      ...process.env,
      PAPERBRIDGE_STORAGE_ROOT: path.join(root, "storage"),
      PAPERBRIDGE_DATA_ROOT: path.join(root, "data"),
      PAPERBRIDGE_PROJECTS_ROOT: path.join(root, "projects")
    }
  });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  page.setDefaultTimeout(15_000);
  const origin = new URL(page.url()).origin;
  const api = async (endpoint, body) => {
    const response = await fetch(origin + endpoint, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : {});
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    return response.json();
  };
  for (const localPath of [first, second]) {
    await api("/api/setup", { source: { mode: "local", localPath }, preserveProviders: true });
  }

  await desktop.evaluate(({ BrowserWindow, shell }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
    globalThis.testFoldersOpened = [];
    shell.openPath = async (folder) => {
      globalThis.testFoldersOpened.push(folder);
      return "";
    };
  });
  await page.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => false }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let compileRequests = 0;
  await page.route("**/api/compile", (route) => {
    compileRequests++;
    return route.fulfill({
      json: { success: true, previewAvailable: false, errors: [], warnings: [], pdf: { exists: false } }
    });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("The second version"));
  await page.waitForFunction(() => !document.querySelector("#compileButton").disabled);
  assert.match(await page.locator("#projectName").textContent(), /paper · 版本乙\/paper/);

  const switcher = page.locator("#projectSwitcherButton");
  const rows = page.locator("#projectSwitcherList .project-switcher-row");
  await switcher.click();
  assert.deepEqual(await rows.locator(".project-switcher-item-path").allTextContents(), [second, first]);
  assert.match(await rows.first().locator(".project-switcher-item-meta").textContent(), /当前项目 · main\.tex/);
  await rows.last().getByRole("button", { name: "打开项目文件夹" }).click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("The second version"));
  assert.deepEqual(await desktop.evaluate(() => globalThis.testFoldersOpened), [first]);
  await page.locator("#addProjectButton").click();
  assert.equal(await page.locator("#setupProjectName").inputValue(), "");
  await page.locator("#closeSetupButton").click();
  await page.locator("#openProjectFolderButton").click();
  assert.deepEqual(await desktop.evaluate(() => globalThis.testFoldersOpened), [first, second]);
  const acceptedForeign = await page.evaluate(async (folder) => {
    try { return await window.paperBridgeDesktop.openProjectFolder(folder); }
    catch { return false; }
  }, foreign);
  assert.equal(acceptedForeign, false);
  console.log("PASS same-named projects show their own folders, and Explorer receives only the chosen project folder");

  const tree = page.locator("#documentList");
  const file = (name) => tree.locator("button").filter({ has: page.locator(".document-label", { hasText: name }) });
  await tree.locator(".folder").first().click();
  const chapterDir = path.join(second, "chapters");
  await fs.mkdir(chapterDir);
  const chapter = path.join(chapterDir, "method.tex");
  const extraBib = path.join(second, "extra.bib");
  await fs.writeFile(chapter, "The new analysis explains a control variable and its proportional response in hardware.");
  await fs.writeFile(extraBib, "@misc{external,title={Externally added}}");
  await file("chapters").waitFor();
  await file("chapters").click();
  await file("method.tex").click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("The new analysis"));
  assert.equal(await tree.locator(".folder").first().getAttribute("aria-expanded"), "true");
  await fs.unlink(chapter);
  await file("method.tex").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("The second version"));

  await file("extra.bib").click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("Externally added"));
  const inMemoryDraft = "@misc{external,title={Unsaved BibTeX draft}}";
  await page.locator("#sourceEditor").fill(inMemoryDraft);
  await fs.unlink(extraBib);
  await file("extra.bib").waitFor({ state: "detached" });
  assert.equal(await page.locator("#sourceEditor").inputValue(), inMemoryDraft);
  assert.equal(await page.locator("#saveSourceButton").isDisabled(), true);
  assert.match(await page.locator("#sourceStatus").textContent(), /磁盘文件已移除/);
  await assert.rejects(fs.stat(extraBib), { code: "ENOENT" });
  console.log("PASS local file changes update the tree, clean deletions select a surviving file, and unsaved text remains available");

  page.once("dialog", (dialog) => dialog.accept());
  await file("main.tex").click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("The second version"));
  await fs.writeFile(chapter, "A surviving chapter can still be edited if the original main TeX file is removed.");
  await file("method.tex").waitFor();
  await fs.unlink(path.join(second, "main.tex"));
  await file("main.tex").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#sourceEditor").value.includes("A surviving chapter"));
  assert.equal(compileRequests, 1);
  assert.deepEqual(errors, []);
  console.log("PASS remaining files are usable after main.tex is removed, with no background compile");
} finally {
  if (desktop) {
    await desktop.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }).catch(() => {});
    await desktop.close();
  }
  const relative = path.relative(temp, await fs.realpath(root));
  if (relative && /^paperbridge-folder-sync-[^\\/]+$/.test(relative)) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

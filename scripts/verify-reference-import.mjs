import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-reference-ui-"));
const projectRoot = path.join(root, "project");
const output = path.resolve("release/verification");
const originalFetch = globalThis.fetch;
const publisherRequests = [];
let browser;
let page;

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname === "api.crossref.org") return new Response("Unavailable", { status: 503 });
  if (url.hostname !== "ieeexplore.ieee.org") return originalFetch(input, options);
  publisherRequests.push(url.toString());
  if (url.pathname === "/document/9900001") {
    return new Response('<script>xplGlobal.document.metadata = ' + JSON.stringify({
      articleNumber: "9900001", title: "Adaptive Satellite Routing", contentType: "Conferences",
      authors: [{ firstName: "Wei", lastName: "Wang" }], publicationTitle: "IEEE INFOCOM",
      publicationYear: "2025", startPage: "11", endPage: "20", doi: "10.1109/fixture.2025.9900001"
    }) + ';</script>');
  }
  if (url.pathname === "/rest/search/citation/format" && url.searchParams.get("recordIds") === "9919149") {
    return Response.json({ data: "@ARTICLE{9919149, title={Reliable Satellite Links}, author={Doe, Jane}, journal={IEEE Access}, year={2025}, volume={13}, pages={1-10}, doi={10.1109/fixture.2025.9919149}}" });
  }
  return new Response("<title>Access Denied</title>", { status: 403 });
};

try {
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, "main.tex"), [
    "\\documentclass{article}", "\\begin{document}", "\\section{Introduction}",
    "Reliable communication is essential for distributed systems.",
    "\\bibliographystyle{plain}", "\\bibliography{references}", "\\end{document}"
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "references.bib"),
    "@article{existing2024, title={Existing Network Research}, author={Chen, Lin}, journal={Network Journal}, year={2024}}\n");
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const response = await originalFetch(server.url + "/api/project/open", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(response.ok, true, await response.text());
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.invalidateReferencesForTest = invalidateReferences;` });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Reliable communication"));
  await page.locator('[data-mode="references"]').click();
  await page.waitForSelector('#referencesList [data-reference-key="existing2024"]');
  const alerts = page.locator("#referencesAlerts");
  assert.match(await alerts.textContent(), /暂未被正文引用/);
  const listBounds = await page.locator("#referencesList").boundingBox();
  const alertBounds = await alerts.boundingBox();
  assert.ok(alertBounds.y >= listBounds.y + listBounds.height);
  await alerts.locator("button").click();
  assert.equal(await alerts.locator(".references-alert").count(), 0);
  await page.locator("#closeReferencesButton").click();
  await page.locator('[data-mode="references"]').click();
  assert.equal(await alerts.locator(".references-alert").count(), 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("Reliable communication"));
  await page.locator('[data-mode="references"]').click();
  await page.waitForSelector('#referencesList [data-reference-key="existing2024"]');
  assert.equal(await alerts.locator(".references-alert").count(), 0);
  console.log("PASS: reference alerts appear below the list and dismissal survives reopening and reload");
  const sourceBefore = await page.locator("#sourceEditor").inputValue();
  await page.locator("#referencesSearch").fill("not-in-this-library");
  await page.waitForTimeout(650);
  assert.equal(await page.locator("#referenceAddDialog").isVisible(), false);
  // A background save can invalidate the library while the workbench stays open.
  await page.evaluate(() => window.invalidateReferencesForTest());
  await page.locator("#referencesSearch").fill("");
  await page.waitForSelector('#referencesList [data-reference-key="existing2024"]');
  assert.doesNotMatch(await page.locator("#referencesList").textContent(), /正在读取参考文献/);
  await page.locator("#referencesSearch").fill("Existing");
  await page.waitForSelector('#referencesList [data-reference-key="existing2024"]');
  await page.locator("#referencesSearch").fill("not-in-this-library");
  await page.waitForFunction(() => document.querySelector("#referencesList")?.textContent.includes("没有匹配的文献"));
  await page.locator("#referencesSearch").fill("");
  await page.waitForSelector('#referencesList [data-reference-key="existing2024"]');
  const searchBox = await page.locator("#referencesSearch").locator("..").boundingBox();
  const addButton = await page.locator("#referenceAddButton").boundingBox();
  assert.ok(addButton.x >= searchBox.x + searchBox.width);
  assert.equal(await page.locator("#referencesSearch").locator("..").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)");
  await page.locator("#referenceAddButton").click();
  await page.waitForFunction(() => document.activeElement?.id === "referenceAddUrl");
  await page.locator("#referenceAddUrl").fill("https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9919149");
  await page.locator("#referenceAddUrl").press("Enter");
  await page.waitForFunction(() => document.querySelector("#referenceAddBib")?.value.includes("Reliable Satellite Links"));
  assert.match(await page.locator("#referenceAddBib").inputValue(), /doi=\{10\.1109\/fixture\.2025\.9919149\}/);
  await page.locator("#referenceAddKey").fill("doe2025satellite");
  assert.match(await page.locator("#referenceAddBib").inputValue(), /@article\{doe2025satellite,/);
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "reference-add-desktop.png") });
  await page.locator("#addReferenceButtonSubmit").click();
  await page.waitForSelector('#referencesList [data-reference-key="doe2025satellite"]');
  assert.equal(await page.locator("#referenceAddDialog").isVisible(), false);
  assert.equal(await page.locator("#referencesSearch").inputValue(), "");
  assert.equal(await page.locator("#sourceEditor").inputValue(), sourceBefore);
  assert.match(await fs.readFile(path.join(projectRoot, "references.bib"), "utf8"), /@article\{doe2025satellite,/);
  assert.ok(publisherRequests.some((url) => url.includes("/rest/search/citation/format")));
  await page.screenshot({ path: path.join(output, "reference-search-desktop.png") });
  console.log("PASS: search stays a filter; independent add button opens import dialog; IEEE URL resolves and BibTeX is saved");

  await page.locator("#referenceAddButton").click();
  await page.locator("#referenceAddUrl").fill("https://ieeexplore.ieee.org/document/9919149");
  await page.locator("#referenceAddUrl").press("Enter");
  await page.waitForFunction(() => document.querySelector(".reference-duplicate-line")?.textContent.includes("已存在于 #"));
  assert.equal(await page.locator("#addReferenceButtonSubmit").isDisabled(), true);
  await page.locator("#referenceAddUrl").fill("https://ieeexplore.ieee.org/document/1111111");
  await page.locator("#referenceAddUrl").press("Enter");
  await page.waitForFunction(() => document.querySelector("#referenceAddStatus")?.classList.contains("error"));
  assert.match(await page.locator("#referenceAddStatus").textContent(), /IEEE.*访问验证/);
  assert.equal(await page.locator("#referenceAddBib").inputValue(), "");
  await page.keyboard.press("Escape");
  console.log("PASS: duplicate detection and blocked IEEE response do not leave stale BibTeX");

  await page.locator("#sourceEditor").evaluate((editor) => {
    const offset = editor.value.indexOf("systems.") + "systems.".length;
    editor.focus();
    editor.setSelectionRange(offset, offset);
  });
  await page.locator("#sourceEditor").evaluate((editor) => editor.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 500, clientY: 300, button: 2
  })));
  await page.locator('.citation-context-menu button').filter({ hasText: "插入文献" }).click();
  await page.waitForSelector("#referenceInsertDialog[open]");
  await page.locator("#referenceInsertSearch").fill("new-reference");
  await page.locator("#referenceInsertAddButton").click();
  await page.waitForSelector("#referenceAddDialog[open]");
  await page.locator("#cancelReferenceAddButton").click();
  assert.equal(await page.locator("#referenceInsertDialog").isVisible(), true);
  assert.equal(await page.locator("#referenceInsertSearch").inputValue(), "new-reference");
  await page.locator("#referenceInsertAddButton").click();
  await page.locator('[data-import-mode="doi"]').click();
  await page.locator("#referenceAddUrl").fill("https://ieeexplore.ieee.org/abstract/document/9900001");
  await page.locator("#referenceAddUrl").press("Enter");
  await page.waitForFunction(() => document.querySelector("#referenceAddBib")?.value.includes("Adaptive Satellite Routing"));
  assert.match(await page.locator("#referenceAddBib").inputValue(), /@inproceedings\{wang2025adaptive,/);
  await page.locator("#addReferenceButtonSubmit").click();
  await page.waitForSelector('#referenceInsertList [data-reference-key="wang2025adaptive"]');
  const sourceSaved = page.waitForResponse((result) => result.url().endsWith("/api/source")
    && result.request().method() === "POST"
    && result.request().postDataJSON().content.includes("\\cite{wang2025adaptive}"));
  await page.locator('#referenceInsertList [data-reference-key="wang2025adaptive"]').click();
  assert.equal(await page.locator("#referenceInsertDialog").isVisible(), false);
  assert.match(await page.locator("#sourceEditor").inputValue(), /systems\.~\\cite\{wang2025adaptive\}/);
  const savedResponse = await sourceSaved;
  assert.equal(savedResponse.ok(), true);
  await savedResponse.finished();
  assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /\\cite\{wang2025adaptive\}/);
  console.log("PASS: nested add dialog restores citation picker and inserts the new reference at the original cursor");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#referenceAddButton").click();
  const geometry = await page.locator("#referenceAddDialog").evaluate((element) => ({
    width: innerWidth, pageWidth: document.documentElement.scrollWidth,
    box: element.getBoundingClientRect().toJSON(), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth
  }));
  assert.ok(geometry.box.x >= 0 && geometry.box.right <= geometry.width, JSON.stringify(geometry));
  assert.ok(geometry.pageWidth <= geometry.width && geometry.scrollWidth <= geometry.clientWidth, JSON.stringify(geometry));
  assert.equal(await page.locator("#referenceAddStatus").isVisible(), false);
  await page.screenshot({ path: path.join(output, "reference-add-mobile.png") });
  await page.locator("#cancelReferenceAddButton").click();
  assert.deepEqual(errors, []);
  console.log("PASS: mobile add dialog fits the viewport; no browser errors");
} catch (error) {
  if (page) {
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "reference-add-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  globalThis.fetch = originalFetch;
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative.startsWith("paperbridge-reference-ui-") && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}

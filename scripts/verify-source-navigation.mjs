import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-source-navigation-"));
let browser;
try {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const longText = "Long paragraphs wrap across many visual lines in the editor. ".repeat(30);
  const content = ["\\documentclass{article}", "\\begin{document}",
    ...Array.from({ length: 24 }, () => longText),
    `${longText}NAVIGATIONTARGET ${longText}`,
    ...Array.from({ length: 24 }, () => longText), "\\end{document}"].join("\n");
  await fs.writeFile(path.join(projectRoot, "main.tex"), content);
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true);
  browser = await chromium.launch({ executablePath: process.env.PAPERBRIDGE_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.navigationTest = { openSourceLocation, refreshSourceSearch, selectSourceSearchMatch };` });
  });
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("NAVIGATIONTARGET"));
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 960 });
    for (const mode of ["source", "search"]) {
      const ratio = await page.evaluate(async (mode) => {
        const editor = document.querySelector("#sourceEditor");
        if (mode === "source") {
          const line = editor.value.slice(0, editor.value.indexOf("NAVIGATIONTARGET")).split("\n").length;
          await window.navigationTest.openSourceLocation("main.tex", line);
        } else {
          document.querySelector("#sourceSearchInput").value = "NAVIGATIONTARGET";
          await window.navigationTest.refreshSourceSearch();
          await window.navigationTest.selectSourceSearchMatch(0);
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const layer = document.querySelector("#sourceHighlightLayer");
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let remaining = editor.selectionStart;
        let node;
        while ((node = walker.nextNode())) {
          if (remaining <= node.length) break;
          remaining -= node.length;
        }
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(node.length, remaining + 1));
        return (range.getBoundingClientRect().top - editor.getBoundingClientRect().top) / editor.clientHeight;
      }, mode);
      assert.ok(ratio >= 0.15 && ratio <= 0.4, `${mode} at ${width}px: target height ratio ${ratio}`);
    }
  }
  console.log("PASS: source navigation and search place wrapped text in the upper viewport at two editor widths");
} finally {
  await browser?.close();
  await stopServer();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("paperbridge-source-navigation-"));
  await fs.rm(root, { recursive: true, force: true });
}

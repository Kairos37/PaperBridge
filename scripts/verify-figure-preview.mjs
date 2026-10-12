import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer, stopServer } from "../server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-preview-images-"));
const projectRoot = path.join(root, "project");
let browser;
try {
  const executablePath = process.env.PAPERBRIDGE_BROWSER_PATH
    || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = await chromium.launch({ executablePath, headless: true });
  await fs.mkdir(path.join(projectRoot, "figures"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "chapters", "images"), { recursive: true });
  await fs.copyFile("resources/icon.png", path.join(projectRoot, "figures", "panel one.png"));
  await fs.copyFile("resources/icon.png", path.join(projectRoot, "chapters", "images", "local.png"));
  await fs.writeFile(path.join(projectRoot, "figures", "diagram.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#168269"/><text x="30" y="58" fill="white" font-size="24">SVG Preview</text></svg>');
  const fixture = await browser.newPage();
  await fixture.setContent('<main style="background:#168269;color:white;padding:30px;font-size:28px">PDF Image Preview</main>');
  await fixture.pdf({ path: path.join(projectRoot, "figures", "plot.v2.PDF"), width: "320px", height: "160px", printBackground: true });
  await fixture.close();
  await fs.writeFile(path.join(projectRoot, "main.tex"), String.raw`\documentclass{article}
\usepackage{graphicx}
\graphicspath { {figures/} }
\begin{document}
Image preview regression fixture.
\input{chapters/results}
\end{document}`);
  await fs.writeFile(path.join(projectRoot, "chapters", "results.tex"), String.raw`\section{Image previews}
The preview should resolve figures from both the project and chapter directories.
\begin{table}
\caption{Table preview}
\begin{tabular}{lcr}
Name & $x^2$ & Score \\
A & 1 & 2 \\
B & 3 & 4 \\
\end{tabular}
\end{table}
\begin{figure}
\includegraphics* [width=0.5\linewidth]
  {\detokenize{panel one.png}}
\caption{PNG with a spaced name and nested argument.}
\end{figure}
\begin{figure}
\includegraphics
  [width=\linewidth] % Comment between options and path
  {plot.v2}
\caption{PDF through graphicspath and an omitted extension.}
\end{figure}
\begin{figure}
\includesvg [width=\linewidth] {diagram}
\caption{SVG through graphicspath.}
\end{figure}
\begin{figure}
\includegraphics {images/local}
\caption{A chapter-relative image.}
\end{figure}`);
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
  const opened = await fetch(`${server.url}/api/project/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot, mainTex: "main.tex" })
  });
  assert.equal(opened.ok, true, await opened.text());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);

  async function checkImages() {
    await page.waitForFunction(() => document.querySelectorAll(".fast-preview-figure").length === 4);
    await page.waitForSelector(".fast-preview-table");
    assert.ok(await page.locator(".fast-preview-table table").count() > 0);
    for (const image of await page.locator(".fast-preview-figure img").all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((element) => element.decode());
      assert.equal(await image.evaluate((element) => element.naturalWidth > 0 && element.naturalHeight > 0), true);
    }
    await page.locator(".fast-preview-pdf").scrollIntoViewIfNeeded();
    await page.waitForSelector(".fast-preview-figure-cell.pdf.rendered");
    const colored = await page.locator(".fast-preview-pdf").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0 && pixels[index + 1] > pixels[index] + 30) count += 1;
      }
      return count;
    });
    assert.ok(colored > 100, `PDF contains only ${colored} colored pixels`);
    assert.equal(await page.locator(".fast-preview-figure-cell.empty").count(), 0);
  }

  await checkImages();
  await page.locator("#insertFigureSourceButton").click();
  await page.locator('[data-insert-kind="table"]').click();
  await page.locator("#insertTableRows").fill("2");
  await page.locator("#insertTableColumns").fill("2");
  const tableInputs = page.locator("#insertTableGrid input");
  await tableInputs.nth(0).fill("Method");
  await tableInputs.nth(1).fill("Score");
  await tableInputs.nth(2).fill("CEDAR");
  await tableInputs.nth(3).fill("98");
  await page.locator("#insertFigureSubmitButton").click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("\\begin{table}"));
  await page.waitForSelector(".fast-preview-table");
  await page.locator("#insertFigureSourceButton").click();
  await page.locator('[data-insert-kind="formula"]').click();
  await page.locator("#insertFormulaLatex").fill("\\frac{a}{b}");
  await page.locator("#insertFigureSubmitButton").click();
  await page.waitForFunction(() => document.querySelector("#sourceEditor")?.value.includes("\\begin{equation}"));
  await page.locator("#sourceFileSelect").selectOption("chapters/results.tex");
  await page.waitForFunction(() => document.querySelector(".fast-preview-meta")?.textContent.startsWith("chapters/results.tex"));
  await checkImages();
  assert.deepEqual(errors, []);
  await fs.mkdir("release/verification", { recursive: true });
  await page.screenshot({ path: "release/verification/figure-preview-fixed.png" });
  console.log("PASS: PNG, SVG and PDF pixels render in the main document and a standalone chapter.");
} finally {
  await browser?.close();
  await stopServer();
  assert.ok(path.relative(os.tmpdir(), root).startsWith("paperbridge-preview-images-"));
  await fs.rm(root, { recursive: true, force: true });
}

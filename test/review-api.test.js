import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractReviewQuote, readReviewPdf, reviewHash } from "../lib/pdf-review.js";
import { startServer, stopServer } from "../server.js";

function annotate(pdf, page, values) {
  const result = pdf.context.register(pdf.context.obj({ Type: PDFName.of("Annot"), ...values }));
  page.node.addAnnot(result);
  return result;
}

const str = PDFHexString.fromText;
const name = PDFName.of;

async function textRun(bytes, text) {
  const loading = getDocument({ data: Uint8Array.from(bytes), verbosity: 0 });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    return content.items.find((item) => item.str?.includes(text));
  } finally { await loading.destroy(); }
}

test("review PDF parsing reads columns in order and ignores links", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("The right column gives the result", { x: 355, y: 715, font, size: 10 });
  page.drawText("The left column introduces the experiment", { x: 45, y: 715, font, size: 10 });
  annotate(document, page, {
    Subtype: name("Highlight"), Rect: [44, 712, 530, 726],
    QuadPoints: [354, 726, 530, 726, 354, 712, 530, 712, 44, 726, 251, 726, 44, 712, 251, 712],
    NM: str("two-columns"), T: str("Admin"), Contents: str("Compare the two columns")
  });
  annotate(document, page, { Subtype: name("Link"), Rect: [35, 40, 60, 50], Contents: str("Generated citation link") });
  const result = await readReviewPdf(Buffer.from(await document.save()));
  assert.equal(result.annotations.length, 1);
  const [highlight] = result.annotations;
  assert.equal(highlight.name, "two-columns");
  assert.match(highlight.quote, /^The left column.*The right column/s);
  assert.equal(highlight.author, "Admin");
  assert.equal(highlight.regions.length, 2);
  assert.equal(extractReviewQuote([
    { str: "uncited empty rest", width: 110, height: 10, transform: [10, 0, 0, 10, 30, 80] }
  ], [[30, 78, 65, 86]], [0, 0, 100, 100]), "uncited");
});

test("review export and import preserve a real SyncTeX round after source changes", { timeout: 90_000 }, async (t) => {
  const available = await promisify(execFile)("latexmk", ["-v"], { windowsHide: true }).then(() => true).catch(() => false);
  if (!available) { t.skip("latexmk is unavailable"); return; }
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "paperbridge-review-api-"));
  const projectRoot = path.join(root, "paper");
  const method = path.join(projectRoot, "chapters", "method.tex");
  const source = "\\subsection{Timing}\n\nThe satellite link preserves timing across both channels. This baseline provides a useful comparison for our experiments.\n";
  const main = [
    "\\documentclass{article}", "\\usepackage{hyperref}", "\\begin{document}", "\\section{Method}",
    "\\input{chapters/method}", "\\end{document}"
  ].join("\n");
  try {
    await fs.mkdir(path.dirname(method), { recursive: true });
    await fs.writeFile(method, source);
    await fs.writeFile(path.join(projectRoot, "main.tex"), main);
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    async function request(url, options, expected = 200) {
      const response = await fetch(server.url + url, options);
      assert.equal(response.status, expected, response.ok ? "" : await response.text());
      return response;
    }
    const post = (url, body) => request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
    const preview = (bytes) => request("/api/reviews/import-preview", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: bytes }).then((response) => response.json());
    await post("/api/project/open", { projectRoot, mainTex: "main.tex" });
    const build = await post("/api/compile", {});
    assert.equal(build.success, true, JSON.stringify(build.errors));
    const artifact = await request("/api/reviews/export-pdf", { method: "POST" });
    const exportId = artifact.headers.get("x-paperbridge-review");
    const bytes = Buffer.from(await artifact.arrayBuffer());
    assert.equal((await readReviewPdf(bytes)).exportId, exportId);

    const run = await textRun(bytes, "satellite link preserves timing");
    assert.ok(run?.str, "A real PDF text run is available");
    const [, , , , x, y] = run.transform;
    const rectangle = [x, y - 2, x + run.width, y + run.height];
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = pdf.getPages()[0];
    const parentAnnotation = annotate(pdf, page, {
      Subtype: name("Highlight"), Rect: rectangle,
      QuadPoints: [rectangle[0], rectangle[3], rectangle[2], rectangle[3], rectangle[0], rectangle[1], rectangle[2], rectangle[1]],
      NM: str("timing-check"), M: str("D:20260101130000Z"), T: str("Admin"), Contents: str("Explain the timing reference.")
    });
    annotate(pdf, page, { Subtype: name("Text"), Rect: rectangle, NM: str("timing-reply"), T: str("Student"), IRT: parentAnnotation, Contents: str("I will clarify.") });
    annotate(pdf, page, { Subtype: name("Link"), Rect: rectangle, NM: str("hyperref"), Contents: str("Citation link") });
    const reviewed = Buffer.from(await pdf.save());
    const reviewedPath = path.join(root, "received.pdf");
    await fs.writeFile(reviewedPath, reviewed);
    const newSource = source.replace("\n\n", "\n\nWe added a different paragraph about experimental methodology.\n\n");
    await fs.writeFile(method, newSource);
    const input = await fs.readFile(reviewedPath);
    const first = await preview(input);
    assert.equal(first.match, "id");
    assert.equal(first.total, 2);
    const highlight = first.items.find((item) => item.subtype === "Highlight");
    assert.match(highlight.quote, /satellite link preserves timing/i);
    assert.equal(highlight.confidence, "high");
    assert.equal(highlight.historical.file, "chapters/method.tex");
    assert.equal(highlight.historical.line, 3);
    assert.equal(highlight.anchor.line, 5);
    assert.equal(highlight.anchor.section, "Timing");

    const merged = await post("/api/reviews/import", { token: first.token, aliases: { Admin: "王老师" } });
    assert.equal(merged.imported, 2);
    assert.equal(merged.threads.length, 1);
    const [thread] = merged.threads;
    assert.equal(thread.displayAuthor, "王老师");
    assert.equal(thread.replies[0].text, "I will clarify.");
    assert.equal(thread.at, "2026-01-01T13:00:00.000Z");
    assert.equal(thread.round, exportId);
    assert.equal(reviewHash(await fs.readFile(reviewedPath)), reviewHash(reviewed));
    const pdfCopy = await request("/api/reviews/attachment/" + thread.pdf.attachment);
    assert.equal(reviewHash(Buffer.from(await pdfCopy.arrayBuffer())), reviewHash(reviewed));

    const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
    info.delete(name("PaperBridgeReviewId"));
    info.delete(name("Keywords"));
    const second = await preview(Buffer.from(await pdf.save()));
    assert.equal(second.match, "text");
    assert.equal(second.added, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(second.authors.find((item) => item.name === "Admin").alias, "王老师");

    await post("/api/reviews/events", { kind: "reply", id: thread.id, author: "学生", text: "已澄清时间参考。" });
    await post("/api/reviews/events", { kind: "status", id: thread.id, status: "resolved" });
    const logPath = path.join(projectRoot, ".paperbridge", "comments.jsonl");
    const events = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.kind), ["author", "create", "reply", "reply", "status"]);
    const checklist = await request("/api/reviews/replies").then((response) => response.text());
    assert.match(checklist, /王老师/);
    assert.match(checklist, /已处理/);
    assert.match(checklist, /chapters\/method\.tex:5/);
    assert.match(checklist, /已澄清时间参考/);
    assert.equal(await fs.readFile(method, "utf8"), newSource);
  } finally {
    await stopServer();
    const relative = path.relative(parent, await fs.realpath(root));
    assert.ok(!path.isAbsolute(relative) && /^paperbridge-review-api-[^/\\]+$/.test(relative));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

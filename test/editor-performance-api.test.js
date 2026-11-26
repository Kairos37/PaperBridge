import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("editor deletion defers compilation and targeted undo avoids reading unrelated documents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-editor-performance-"));
  const projectRoot = path.join(root, "project");
  const originalReadFile = fs.readFile;
  try {
    await fs.mkdir(projectRoot);
    const original = [
      "\\documentclass{article}", "\\begin{document}",
      "The first academic paragraph contains enough English prose for editing.", "",
      "The second academic paragraph contains enough English prose for editing.",
      "\\end{document}"
    ].join("\n");
    await fs.writeFile(path.join(projectRoot, "main.tex"), original);
    const unrelatedFiles = new Set();
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(projectRoot, `unrelated-${index}.tex`);
      unrelatedFiles.add(file);
      await fs.writeFile(file, `\\section{Unrelated ${index}}\nAn unrelated academic paragraph remains untouched by the current file's edits.\n`);
    }
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    const request = async (url, body) => {
      const response = await fetch(server.url + url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = { type: "openai-compatible", baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "test-model" };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot }, translation: provider, diagnosis: provider,
      autoCompile: true
    });
    const document = await request("/api/document?file=main.tex");
    await request("/api/segment/chinese", {
      file: "main.tex", index: document.segments[0].index,
      sourceHash: document.segments[0].sourceHash, chinese: "Preserved translation draft"
    });
    const removed = await request("/api/segment/delete", {
      file: "main.tex", index: document.segments[0].index,
      sourceHash: document.segments[0].sourceHash, deferCompile: true
    });
    assert.equal(removed.build, null);
    assert.equal(removed.document.segments.length, 1);
    assert.equal((await request("/api/bootstrap")).lastBuild, null);

    let unrelatedReads = 0;
    fs.readFile = async (file, ...options) => {
      if (typeof file === "string" && unrelatedFiles.has(path.resolve(file))) unrelatedReads += 1;
      return originalReadFile(file, ...options);
    };
    const fastStart = performance.now();
    const undone = await request("/api/undo", { refreshProject: false, file: "main.tex" });
    const fastMs = performance.now() - fastStart;
    assert.equal(undone.changed, true);
    assert.equal(undone.label, "删除段落");
    assert.deepEqual(undone.changedFiles, ["main.tex"]);
    assert.equal(undone.filesChanged, false);
    assert.equal(undone.project, undefined);
    assert.equal(undone.source.content, original);
    assert.equal(undone.document.segments.length, 2);
    assert.equal(undone.document.segments[0].chinese, "Preserved translation draft");
    assert.equal(unrelatedReads, 0, "targeted undo must not parse unrelated project documents");

    await request("/api/config", { autoCompile: false });
    await request("/api/source", {
      file: "main.tex", sourceHash: undone.source.sourceHash,
      content: `${original}\n% Changed source\n`, deferCompile: true
    });
    unrelatedReads = 0;
    const fullStart = performance.now();
    const fullUndo = await request("/api/undo", {});
    const fullMs = performance.now() - fullStart;
    assert.equal(fullUndo.project.setupRequired, false, "default undo retains its full project response");
    assert.ok(unrelatedReads > 0, "full project refresh parses the unrelated documents");
    t.diagnostic(`targeted undo: ${fastMs.toFixed(1)} ms; full-project undo: ${fullMs.toFixed(1)} ms (${unrelatedReads} unrelated file reads)`);

    await request("/api/source/create", { file: "new.tex", insertion: { mode: "none" } });
    const undoCreatedFile = await request("/api/undo", { refreshProject: false, file: "new.tex" });
    assert.equal(undoCreatedFile.filesChanged, true);
    assert.deepEqual(undoCreatedFile.changedFiles, ["new.tex"]);
    assert.equal(undoCreatedFile.source, null);
    assert.equal(undoCreatedFile.document, null);
    await assert.rejects(fs.access(path.join(projectRoot, "new.tex")));

    const noHistory = await request("/api/undo", { refreshProject: false, file: "main.tex" });
    assert.equal(noHistory.changed, false);
    assert.equal(noHistory.filesChanged, false);
    assert.deepEqual(noHistory.changedFiles, []);
    assert.equal(noHistory.document.segments.length, 2);

    const annotation = { id: "test-annotation", start: original.indexOf("first academic"), end: original.indexOf("first academic") + 5, text: "Original comment" };
    await request("/api/source/annotations", { file: "main.tex", annotations: [annotation] });
    await request("/api/source/annotations", { file: "main.tex", annotations: [{ ...annotation, text: "Changed comment" }] });
    const restoredAnnotation = await request("/api/undo", { refreshProject: false, file: "main.tex" });
    assert.equal(restoredAnnotation.annotations.length, 1);
    assert.equal(restoredAnnotation.annotations[0].text, "Original comment");
    const removedAnnotation = await request("/api/undo", { refreshProject: false, file: "main.tex" });
    assert.deepEqual(removedAnnotation.annotations, []);
  } finally {
    fs.readFile = originalReadFile;
    await stopServer();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-editor-performance-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

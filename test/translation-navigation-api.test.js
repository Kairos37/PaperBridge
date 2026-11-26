import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("translation navigation includes empty and unreferenced TeX files with project sections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-translation-navigation-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}", "\\begin{document}", "\\section{Introduction}",
      "Reliable communication requires a coordinated strategy across multiple independent network participants.",
      "", "\\section{Evaluation}",
      "Our evaluation compares several approaches under consistent and repeatable experimental conditions.",
      "\\end{document}"
    ].join("\n"));
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    const request = async (url, body) => {
      const response = await fetch(server.url + url, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    await request("/api/project/open", { projectRoot, mainTex: "main.tex" });
    const created = await request("/api/source/create", { file: "blank.tex", insertion: { mode: "none" } });
    assert.deepEqual(created.project.documents.find((item) => item.file === "blank.tex"), {
      file: "blank.tex", sections: [], segments: 0, translated: 0, stale: 0
    });
    assert.deepEqual(created.project.documents.find((item) => item.file === "main.tex").sections.map((item) => item.title), ["Introduction", "Evaluation"]);
    assert.equal((await request("/api/document?file=blank.tex")).segments.length, 0);
    const content = "\\section{New chapter}\nA newly created manuscript contains sufficient academic words to become a translatable paragraph.\n";
    const saved = await request("/api/source", {
      file: "blank.tex", content, sourceHash: created.source.sourceHash, refreshDocument: true, deferCompile: true
    });
    assert.equal(saved.document.file, "blank.tex");
    assert.equal(saved.document.segments.length, 1);
    assert.equal(saved.document.segments[0].sectionTitle, "New chapter");
    await request("/api/segment/chinese", { file: "blank.tex", index: 0, chinese: "Retained translation draft" });
    await request("/api/document?file=main.tex");
    assert.equal((await request("/api/document?file=blank.tex")).segments[0].chinese, "Retained translation draft");
    const refreshed = await request("/api/bootstrap");
    assert.equal(refreshed.documents.find((item) => item.file === "blank.tex").sections[0].title, "New chapter");
    const rejected = await fetch(server.url + "/api/document?file=../outside.tex");
    assert.equal(rejected.ok, false);
  } finally {
    await stopServer();
    await fs.rm(root, { recursive: true, force: true });
  }
});

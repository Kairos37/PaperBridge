import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDependencyStatus } from "../lib/project.js";
import { startServer, stopServer } from "../server.js";

test("legacy autoCompile settings cannot compile edits and explicit compilation always uses the full PDF build", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-manual-compile-"));
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "data");
  try {
    await fs.mkdir(projectRoot);
    await fs.mkdir(dataRoot);
    const original = ["\\documentclass{article}", "\\begin{document}",
      "The first academic paragraph contains enough English prose for editing.", "",
      "The second academic paragraph contains enough English prose for editing.", "\\end{document}"].join("\n");
    await fs.writeFile(path.join(projectRoot, "main.tex"), original);
    await fs.writeFile(path.join(dataRoot, "config.local.json"), JSON.stringify({ projectRoot, mainTex: "main.tex", autoCompile: true }));
    const server = await startServer({ port: 0, dataRoot, projectsRoot: path.join(root, "projects") });
    const request = async (url, body) => {
      const response = await fetch(server.url + url, {
        method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.config.autoCompile, false);
    assert.equal((await request("/api/config", { autoCompile: true })).autoCompile, false);
    const source = await request("/api/source?file=main.tex");
    const saved = await request("/api/source", {
      file: "main.tex", content: `${original}\n% Source save\n`, sourceHash: source.sourceHash,
      deferCompile: false
    });
    assert.equal(saved.build, null);
    const document = await request("/api/document?file=main.tex");
    const edited = await request("/api/segment/english", {
      file: "main.tex", index: document.segments[0].index, sourceHash: document.segments[0].sourceHash,
      english: "The edited academic paragraph remains valid English prose for the paper.", deferCompile: false
    });
    assert.equal(edited.build, null);
    const deleted = await request("/api/segment/delete", {
      file: "main.tex", index: edited.document.segments[0].index, sourceHash: edited.document.segments[0].sourceHash
    });
    assert.equal(deleted.build, null);
    assert.equal(deleted.document.segments.length, 1);
    await assert.rejects(fs.access(path.join(projectRoot, "main.pdf")));
    await assert.rejects(fs.access(path.join(projectRoot, "main.log")));
    assert.equal((await request("/api/bootstrap")).lastBuild, null);

    const dependencies = await getDependencyStatus();
    if (dependencies.compiler === "missing") {
      t.diagnostic("Edit policy verified; explicit PDF build skipped because no compiler is available.");
      return;
    }
    const build = await request("/api/compile", { fast: true });
    assert.equal(build.success, true);
    assert.equal(build.mode, "full");
    const compiledPdf = await fs.stat(path.join(projectRoot, "main.pdf"));
    const compiledState = (await request("/api/bootstrap")).lastBuild;
    const compiledSource = await request("/api/source?file=main.tex");
    const resaved = await request("/api/source", {
      file: "main.tex", sourceHash: compiledSource.sourceHash,
      content: `${compiledSource.content}\n% Subsequent edit waits for a manual compile\n`, deferCompile: false
    });
    assert.equal(resaved.build, null);
    assert.equal((await fs.stat(path.join(projectRoot, "main.pdf"))).mtimeMs, compiledPdf.mtimeMs);
    assert.equal((await request("/api/bootstrap")).lastBuild.updatedAt, compiledState.updatedAt);
  } finally {
    await stopServer();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-manual-compile-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

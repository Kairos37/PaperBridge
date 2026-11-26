import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSyncTeXOutput } from "../lib/synctex.js";
import { getDependencyStatus } from "../lib/project.js";
import { startServer, stopServer } from "../server.js";

test("SyncTeX output keeps Windows drive letters, spaces and multiple native results intact", () => {
  const records = parseSyncTeXOutput("SyncTeX result begin\nOutput:C:/paper/main.pdf\nInput:C:/paper/chapter one.tex\nLine:12\nColumn:-1\nOutput:C:/paper/main.pdf\nInput:C:/paper/second.tex\nLine:24\nColumn:1\nSyncTeX result end\n");
  assert.equal(records.length, 2);
  assert.equal(records[0].Input, "C:/paper/chapter one.tex");
  assert.equal(records[1].Line, "24");
  assert.deepEqual(parseSyncTeXOutput("No tag for this input"), []);
});

test("SyncTeX API maps a real included source file both ways and rejects stale or external source paths", async (t) => {
  if ((await getDependencyStatus()).compiler === "missing") return t.skip("No LaTeX compiler available");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-synctex-api-"));
  const projectRoot = path.join(root, "paper");
  try {
    await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nFirst page text.\n\\newpage\n\\input{chapters/method}\n\\end{document}\n");
    const chapter = path.join(projectRoot, "chapters", "method.tex");
    await fs.writeFile(chapter, "\\section{Method}\nSecond page repeated text and a formula $x+y=z$ used for source synchronization.\n");
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    const post = async (url, body) => {
      const response = await fetch(server.url + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post("/api/project/open", { projectRoot, mainTex: "main.tex" })).status, 200);
    const missing = await post("/api/synctex/forward", { file: "chapters/method.tex", line: 2 });
    assert.equal(missing.body.code, "SYNCTEX_MISSING");
    const compiled = await post("/api/compile", {});
    assert.equal(compiled.body.success, true, JSON.stringify(compiled.body.errors));
    const forward = await post("/api/synctex/forward", { file: "chapters/method.tex", line: 2, column: 1 });
    assert.equal(forward.status, 200, JSON.stringify(forward.body));
    assert.equal(forward.body.page, 2);
    assert.ok(forward.body.width > 0 && forward.body.height > 0);
    const inverse = await post("/api/synctex/inverse", {
      page: forward.body.page, x: forward.body.x + forward.body.width / 2, y: forward.body.y + forward.body.height / 2
    });
    assert.equal(inverse.status, 200, JSON.stringify(inverse.body));
    assert.equal(inverse.body.file, "chapters/method.tex");
    assert.equal(inverse.body.line, 2);
    const external = await post("/api/synctex/forward", { file: "../outside.tex", line: 1 });
    assert.equal(external.status, 400);
    const map = await fs.stat(path.join(projectRoot, "main.synctex.gz"));
    await fs.utimes(chapter, new Date(), new Date(map.mtimeMs + 1000));
    const stale = await post("/api/synctex/forward", { file: "chapters/method.tex", line: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "SYNCTEX_STALE");
  } finally {
    await stopServer();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-synctex-api-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

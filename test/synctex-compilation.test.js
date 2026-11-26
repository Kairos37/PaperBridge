import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { compileProject, getDependencyStatus } from "../lib/project.js";

const run = promisify(execFile);

test("formal compilation produces compressed SyncTeX data for real forward and inverse navigation", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-synctex-build-"));
  try {
    await fs.mkdir(path.join(root, "chapters"));
    await fs.writeFile(path.join(root, "main.tex"), [
      "\\documentclass{article}", "\\begin{document}",
      "\\input{chapters/method}", "\\end{document}"
    ].join("\n"));
    await fs.writeFile(path.join(root, "chapters", "method.tex"), [
      "\\section{Method}",
      "An exact synchronization paragraph appears here with a known source line.", "",
      "A second paragraph has a distinct source line for reverse mapping."
    ].join("\n"));
    const build = await compileProject(root, "main.tex");
    assert.equal(build.success, true);
    const compressed = await fs.readFile(path.join(root, "main.synctex.gz"));
    assert.equal(compressed.readUInt16BE(0), 0x1f8b);
    const records = gunzipSync(compressed).toString("utf8");
    assert.match(records, /^SyncTeX Version:1/m);
    const sourceName = records.split(/\r?\n/).find((line) => /^Input:\d+:/.test(line) && line.endsWith("chapters/method.tex"))?.replace(/^Input:\d+:/, "");
    assert.ok(sourceName, "SyncTeX must map the included source file");
    assert.match(records, /^\{1$/m);
    assert.match(records, /^Postamble:/m);
    const hasCli = await run("synctex", ["help"], { windowsHide: true }).then(() => true).catch(() => false);
    if (!hasCli) {
      t.diagnostic("SyncTeX artifact verified; CLI round trip skipped because synctex is unavailable.");
      return;
    }
    const forward = await run("synctex", ["view", "-i", `2:0:${sourceName}`, "-o", "main.pdf"], { cwd: root, windowsHide: true });
    const page = forward.stdout.match(/^Page:(\d+)/m)?.[1];
    const x = forward.stdout.match(/^x:([\d.-]+)/m)?.[1];
    const y = forward.stdout.match(/^y:([\d.-]+)/m)?.[1];
    assert.equal(page, "1");
    assert.ok(x && y);
    const inverse = await run("synctex", ["edit", "-o", `${page}:${x}:${y}:main.pdf`], { cwd: root, windowsHide: true });
    assert.match(inverse.stdout.replaceAll("\\", "/"), /^Input:.+chapters\/method\.tex\r?$/m);
    assert.match(inverse.stdout, /^Line:2\r?$/m);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-synctex-build-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("nested main files keep SyncTeX alongside their PDF and clean both compressed and plain indices", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-synctex-nested-"));
  try {
    await fs.mkdir(path.join(root, "paper"));
    await fs.writeFile(path.join(root, "paper", "main.tex"), [
      "\\documentclass{article}", "\\begin{document}",
      "A nested manuscript has its PDF and synchronization data in the same folder.",
      "\\end{document}"
    ].join("\n"));
    await fs.writeFile(path.join(root, "paper", "main.synctex"), "Obsolete plain synchronization data.");
    await fs.writeFile(path.join(root, "paper", "main.synctex.gz"), "Obsolete compressed synchronization data.");
    const build = await compileProject(root, "paper/main.tex", { clean: true });
    assert.equal(build.success, true);
    assert.equal(build.pdf.path, path.join(root, "paper", "main.pdf"));
    const records = gunzipSync(await fs.readFile(path.join(root, "paper", "main.synctex.gz"))).toString("utf8");
    assert.match(records, /^SyncTeX Version:1/m);
    assert.match(records, /main\.tex/);
    await assert.rejects(fs.access(path.join(root, "paper", "main.synctex")));
    await assert.rejects(fs.access(path.join(root, "main.synctex.gz")));
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-synctex-nested-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

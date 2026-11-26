import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { exec as execGit } from "dugite";
import { configureProjectRuntime, pullProject } from "../lib/project.js";

async function git(args, cwd) {
  const result = await execGit(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], cwd,
    { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  return String(result.stdout || "").trim();
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-file-lock-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  let tokenRequests = 0;
  const cleanup = async () => {
    configureProjectRuntime({ getOverleafToken: () => "" });
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-git-file-lock-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init", "--initial-branch=main"], seedRoot);
    await git(["config", "user.name", "PaperBridge Lock Test"], seedRoot);
    await git(["config", "user.email", "lock-test@example.invalid"], seedRoot);
    await git(["config", "core.autocrlf", "false"], seedRoot);
    await fs.writeFile(path.join(seedRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nBase paper.\n\\input{Method}\n\\end{document}\n");
    await fs.writeFile(path.join(seedRoot, "Method.tex"), "\\section{Method}\nBase method.\n");
    await git(["add", "."], seedRoot);
    await git(["commit", "-m", "Base paper"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Lock Test"], projectRoot);
    await git(["config", "user.email", "lock-test@example.invalid"], projectRoot);
    await git(["config", "core.autocrlf", "false"], projectRoot);
    await fs.writeFile(path.join(projectRoot, "local.tex"), "Independent local paragraph must survive synchronization.\n");
    await git(["add", "local.tex"], projectRoot);
    await git(["commit", "-m", "Local independent commit"], projectRoot);
    await fs.appendFile(path.join(seedRoot, "main.tex"), "% Remote main change\n");
    await fs.appendFile(path.join(seedRoot, "Method.tex"), "% Remote method change\n");
    await git(["add", "main.tex", "Method.tex"], seedRoot);
    await git(["commit", "-m", "Remote changes both TeX files"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);
    configureProjectRuntime({ askPassPath: "", getOverleafToken: (cwd, remoteName) => {
      assert.equal(cwd, projectRoot);
      assert.equal(remoteName, "overleaf");
      tokenRequests += 1;
      return "paperbridge-isolated-file-lock-test-token";
    } });
    return { projectRoot, cleanup, tokenRequests: () => tokenRequests };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function holdFile(file) {
  const script = "$stream = [System.IO.FileStream]::new($env:PAPERBRIDGE_LOCK_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PAPERBRIDGE_LOCK_TEST_FILE: file }
  });
  let output = "";
  let errors = "";
  let releasePromise;
  const release = () => {
    if (releasePromise) return releasePromise;
    releasePromise = new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", resolve);
      child.stdin.end("release\n");
    });
    return releasePromise;
  };
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Windows file lock startup timed out: ${errors}`)), 15000);
      child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("LOCKED")) { clearTimeout(timeout); resolve(); }
      });
      child.stderr.on("data", (data) => { errors += data; });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => {
        if (!output.includes("LOCKED")) { clearTimeout(timeout); reject(new Error(`Windows file lock exited ${code}: ${errors}`)); }
      });
    });
    return { release };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function snapshot(projectRoot) {
  return {
    head: await git(["rev-parse", "HEAD"], projectRoot),
    index: await git(["ls-files", "-s"], projectRoot),
    status: await git(["status", "--porcelain=v1"], projectRoot),
    main: await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"),
    method: await fs.readFile(path.join(projectRoot, "Method.tex"), "utf8"),
    local: await fs.readFile(path.join(projectRoot, "local.tex"), "utf8")
  };
}

test("Overleaf pull retries a Windows file lock until the external reader releases it", {
  skip: process.platform !== "win32", timeout: 60000
}, async () => {
  const fixture = await createFixture();
  let lock;
  let watcher;
  let releaseTimer;
  let sawMerge = false;
  let released = false;
  let releaseError;
  try {
    lock = await holdFile(path.join(fixture.projectRoot, "main.tex"));
    watcher = watch(path.join(fixture.projectRoot, ".git"), (_event, filename) => {
      // ORIG_HEAD is first written when Git attempts the merge. Hold the lock
      // through the first retries instead of guessing how long fetch will take.
      if (String(filename) !== "ORIG_HEAD" || sawMerge) return;
      sawMerge = true;
      releaseTimer = setTimeout(() => {
        lock.release().then(() => { released = true; }).catch((error) => { releaseError = error; });
      }, 1000);
    });
    const status = await pullProject(fixture.projectRoot);
    assert.equal(sawMerge, true, "The first locked merge must be observed");
    assert.equal(released, true, "The lock must be released before synchronization succeeds");
    assert.equal(releaseError, undefined);
    assert.ok(fixture.tokenRequests() > 0);
    assert.equal(status.overleaf, true);
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
    assert.match(await fs.readFile(path.join(fixture.projectRoot, "main.tex"), "utf8"), /Remote main change/);
    assert.match(await fs.readFile(path.join(fixture.projectRoot, "Method.tex"), "utf8"), /Remote method change/);
    assert.match(await fs.readFile(path.join(fixture.projectRoot, "local.tex"), "utf8"), /must survive synchronization/);
    await assert.rejects(fs.access(path.join(fixture.projectRoot, ".git", "MERGE_HEAD")), { code: "ENOENT" });
  } finally {
    watcher?.close();
    clearTimeout(releaseTimer);
    await lock?.release();
    await fixture.cleanup();
  }
});

test("Overleaf pull reports persistent Windows file locks without changing local files or HEAD", {
  skip: process.platform !== "win32", timeout: 60000
}, async () => {
  const fixture = await createFixture();
  let lock;
  try {
    const before = await snapshot(fixture.projectRoot);
    lock = await holdFile(path.join(fixture.projectRoot, "main.tex"));
    await assert.rejects(pullProject(fixture.projectRoot), (error) => {
      assert.equal(error.code, "GIT_FILE_BUSY");
      assert.equal(error.status, 409);
      assert.match(error.message, /main\.tex/);
      assert.match(error.message, /被占用/);
      assert.deepEqual(error.details.files, ["main.tex"]);
      assert.match(error.details.originalError, /unable to unlink old 'main\.tex': Invalid argument/);
      return true;
    });
    assert.ok(fixture.tokenRequests() > 0);
    assert.deepEqual(await snapshot(fixture.projectRoot), before);
    await assert.rejects(fs.access(path.join(fixture.projectRoot, ".git", "MERGE_HEAD")), { code: "ENOENT" });
    await lock.release();
    const status = await pullProject(fixture.projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
    assert.match(await fs.readFile(path.join(fixture.projectRoot, "main.tex"), "utf8"), /Remote main change/);
    assert.match(await fs.readFile(path.join(fixture.projectRoot, "Method.tex"), "utf8"), /Remote method change/);
    assert.equal(await fs.readFile(path.join(fixture.projectRoot, "local.tex"), "utf8"), before.local);
  } finally {
    await lock?.release();
    await fixture.cleanup();
  }
});

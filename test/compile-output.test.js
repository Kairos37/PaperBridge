import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

function pdfFixture(text) {
  const stream = `BT /F1 18 Tf 40 750 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("compiler output ignores stale logs but requires a fresh valid PDF after recoverable errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-compile-output-"));
  const originalExecFile = childProcess.execFile;
  let scenario = "stale-log";
  const unicodeError = "! LaTeX Error: Unicode character dash (U+2011)";
  const fatalError = "! Undefined control sequence.\nl.3 \\unknownCommand";
  const fakeExecFile = () => { throw new Error("Only the promisified compiler is expected in this fixture."); };
  fakeExecFile[promisify.custom] = async (command, args, options) => {
    assert.equal(command, "latexmk");
    if (args.includes("--version")) return { stdout: "Latexmk fixture", stderr: "" };
    assert.ok(args.includes("-g"));
    if (scenario !== "stale-pdf") {
      await fs.writeFile(path.join(options.cwd, "main.pdf"), pdfFixture(scenario));
    }
    if (scenario === "stale-log") return { stdout: "Output written on main.pdf.", stderr: "" };
    const log = scenario === "fatal" ? fatalError : unicodeError;
    if (scenario !== "stale-pdf") await fs.writeFile(path.join(options.cwd, "main.log"), log);
    throw Object.assign(new Error("Compiler exited with status 1"), { code: 1, stdout: log, stderr: "" });
  };
  try {
    await fs.writeFile(path.join(root, "main.tex"), "\\documentclass{article}\n\\begin{document}\nA valid document.\n\\end{document}\n");
    await fs.writeFile(path.join(root, "main.log"), fatalError);
    childProcess.execFile = fakeExecFile;
    syncBuiltinESMExports();
    // A separate module instance captures the fixture command; other imports
    // and the real compiler tests retain their original process runner.
    const { compileProject } = await import("../lib/project.js?compile-output-fixture");
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();

    const fixed = await compileProject(root, "main.tex");
    assert.equal(fixed.success, true);
    assert.equal(fixed.previewAvailable, true);
    assert.deepEqual(fixed.errors, []);
    assert.doesNotMatch(fixed.log, /Undefined control sequence/);

    scenario = "unicode";
    const recoverable = await compileProject(root, "main.tex");
    assert.equal(recoverable.success, true);
    assert.equal(recoverable.previewAvailable, true);
    assert.deepEqual(recoverable.errors, []);
    assert.ok(recoverable.warnings.some((warning) => /Unicode character dash \(U\+2011\)/.test(warning)));

    scenario = "stale-pdf";
    const stale = await compileProject(root, "main.tex");
    assert.equal(stale.success, false);
    assert.equal(stale.previewAvailable, false);
    assert.equal(stale.recoverable, true);
    assert.equal(stale.pdf.updatedAt, recoverable.pdf.updatedAt);

    scenario = "fatal";
    const fatal = await compileProject(root, "main.tex");
    assert.equal(fatal.pdf.exists, true);
    assert.equal(fatal.success, false);
    assert.equal(fatal.previewAvailable, false);
    assert.ok(fatal.errors.some((error) => error.includes("Undefined control sequence")));
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("paperbridge-compile-output-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

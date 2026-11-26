import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("reference workbench opens on the left without replacing the editor or PDF and supports citation drag-and-drop", async () => {
  const appSource = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const workspaceStyles = await fs.readFile(new URL("../public/review.css", import.meta.url), "utf8");

  assert.match(html, /class="activity-bar"[^>]*aria-label="工作区面板"/);
  assert.match(html, /data-mode="source"[^>]*aria-pressed="true">源码<\/button>/);
  assert.match(html, /data-mode="edit"[^>]*>中英对照<\/button>/);
  assert.match(html, /class="sidebar-reference-button mode-button"[^>]*data-mode="references"/);
  assert.doesNotMatch(html, /data-mode="format"/);
  assert.match(html, /class="editor-panel hidden" id="editView"/);
  assert.match(html, /class="editor-panel source-panel" id="sourceView"/);
  assert.match(appSource, /mode:\s*"source",\s*referencesOpen:\s*false/);
  assert.match(appSource, /if \(mode === "references"\) return setReferencesOpen\(!state\.referencesOpen\)/);
  assert.match(appSource, /function setReferencesOpen\(open\)[\s\S]*state\.referencesOpen = Boolean\(open\)/);
  const referenceToggle = appSource.slice(
    appSource.indexOf("function setReferencesOpen(open)"),
    appSource.indexOf("function setSourceFocus", appSource.indexOf("function setReferencesOpen(open)"))
  );
  assert.doesNotMatch(referenceToggle, /state\.mode\s*=/);
  assert.match(appSource, /elements\.editView\.classList\.toggle\("hidden", mode !== "edit"\)/);
  assert.doesNotMatch(referenceToggle, /elements\.previewPanel\.classList\.toggle\("hidden"/);
  assert.match(html, /id="closeReferencesButton"[^>]*aria-label="关闭参考文献工作台"/);
  assert.doesNotMatch(html, /id="refreshReferencesButton"|id="addReferenceButton"|id="insertSelectedReferenceButton"/);
  assert.match(html, /id="referencesSearch"[^>]*placeholder="搜索 DOI、标题、作者、年份"/);
  assert.match(html, /id="referenceAddDialog"/);
  assert.match(html, /id="referenceAddUrl"[^>]*type="text"/);
  assert.match(html, /id="referenceAddForm"[^>]*novalidate/);
  assert.match(html, /id="referenceAddBib"/);
  const workbenchUi = await fs.readFile(new URL("../public/reference-workbench.js", import.meta.url), "utf8");
  const importer = await fs.readFile(new URL("../public/reference-import-dialog.js", import.meta.url), "utf8");
  assert.match(importer, /"\/api\/references\/lookup"/);
  assert.match(importer, /api\("\/api\/references\/add"/);
  assert.match(html, /id="referencesSearch"[\s\S]{0,320}id="referenceAddButton"[^>]*aria-label="新增参考文献"/);
  assert.match(html, /id="referenceInsertSearch"[\s\S]{0,360}id="referenceInsertAddButton"[^>]*aria-label="新增参考文献"/);
  assert.match(workbenchUi, /byId\("referenceAddButton"\)\.addEventListener\("click", \(\) => importer\.open\(search\.value\)\)/);
  assert.match(workbenchUi, /byId\("referenceInsertAddButton"\)\.addEventListener\("click", \(\) => importer\.open\(insertSearch\.value\)\)/);
  assert.match(workbenchUi, /search\.addEventListener\("input", refilter\)/);
  assert.match(appSource, /elements\.closeReferencesButton\.addEventListener\("click", \(\) => setReferencesOpen\(false\)\)/);
  assert.match(workbenchUi, /row\.draggable = true/);
  assert.match(workbenchUi, /event\.dataTransfer\.setData\(dragType, entry\.key\)/);
  assert.match(workbenchUi, /event\.dataTransfer\.setData\("text\/plain", "\\\\cite\{" \+ entry\.key \+ "\}"\)/);
  assert.match(appSource, /textarea\.addEventListener\("dragover"/);
  assert.match(appSource, /textarea\.addEventListener\("drop"/);
  assert.match(appSource, /function textareaCaretOffsetFromPoint/);
  assert.match(appSource, /event\.preventDefault\(\);[\s\S]{0,180}textareaCaretOffsetFromPoint\(textarea, event\.clientX, event\.clientY\)/);
  assert.match(appSource, /insertCitationIntoTarget\(textarea, key, offset\)/);
  assert.match(appSource, /textarea\.addEventListener\("contextmenu", \(event\) => openCitationContextMenu/);
  assert.match(workspaceStyles, /\.workspace\.references-open > #referencesView\s*\{[^}]*grid-column: 2;[^}]*grid-row: 1;/);
  assert.match(styles, /textarea\.citation-drop-target/);
});

test("reference workbench lists Bib entries by first citation order and reports issues", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-reference-workbench-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "This paper first cites the beacon method \\cite{beacon_scheduling_2024,missing_2026}.",
      "Later it cites adaptive scheduling \\citep{adaptive_links_2025}.",
      "\\bibliographystyle{plain}",
      "\\bibliography{references}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "references.bib"), [
      "@inproceedings{adaptive_links_2025,",
      "  author = {Ada Author and Bob Builder},",
      "  title = {Adaptive Link Scheduling for Satellite Networks},",
      "  booktitle = {IEEE INFOCOM},",
      "  year = {2025}",
      "}",
      "",
      "@article{beacon_scheduling_2024,",
      "  author = {Chen Researcher},",
      "  title = {BEACON: Reliable Satellite Access},",
      "  journal = {ACM Transactions on Networking},",
      "  pages = {1--12},",
      "  doi = {10.1145/example},",
      "  year = {2024}",
      "}",
      "",
      "@article{beacon_duplicate_2024,",
      "  author = {Chen Researcher},",
      "  title = {BEACON: Reliable Satellite Access},",
      "  journal = {ACM Transactions on Networking},",
      "  doi = {10.1145/example},",
      "  year = {2024}",
      "}"
    ].join("\n"), "utf8");

    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        source: { mode: "local", localPath: projectRoot },
        translation: provider,
        review: provider,
        autoCompile: false
      })
    });

    const workbench = await request("/api/references");
    assert.deepEqual(workbench.bibliographyFiles, ["references.bib"]);
    assert.deepEqual(workbench.entries.map((entry) => entry.key), [
      "beacon_scheduling_2024",
      "adaptive_links_2025",
      "beacon_duplicate_2024"
    ]);
    assert.equal(workbench.entries[0].authors[0].family, "Researcher");
    assert.equal(workbench.entries[0].locations[0].line, 4);
    assert.match(workbench.entries[0].locations[0].context, /beacon method/);
    assert.equal(workbench.entries[0].venue, "ACM Transactions on Networking");
    assert.deepEqual(workbench.missing.map((item) => item.key), ["missing_2026"]);
    assert.deepEqual(workbench.unused, ["beacon_duplicate_2024"]);
    assert.deepEqual(workbench.duplicates, [["beacon_scheduling_2024", "beacon_duplicate_2024"]]);
    assert.equal(workbench.fieldLabels.title, "论文标题");
    assert.match(workbench.entries[0].raw, /@article\{beacon_scheduling_2024/);

    const document = await request("/api/document?file=main.tex");
    const citedSegment = document.segments.find((segment) => segment.english.includes("\\cite{beacon_scheduling_2024,missing_2026}"));
    assert.ok(citedSegment);
    const edited = await request("/api/segment/english", {
      method: "POST",
      body: JSON.stringify({
        file: "main.tex",
        index: citedSegment.index,
        sourceHash: citedSegment.sourceHash,
        english: citedSegment.english.replace(/\s*\\cite\{beacon_scheduling_2024,missing_2026\}/, ""),
        chinese: citedSegment.chinese,
        deferCompile: true
      })
    });
    assert.ok(edited.document);
    assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /\\cite\{beacon_scheduling_2024,missing_2026\}/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

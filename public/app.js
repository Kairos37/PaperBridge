import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import { marked } from "/vendor/marked/marked.esm.js";
import { graphicsCommands, graphicsSearchPaths, resolveGraphicPath } from "./latex-graphics.js";
import { createFormulaLatex, createTableLatex, parseLatexTable } from "./latex-structures.js";
import { mountReviewCenter } from "./review-center.js";
import { selectedPdfReview } from "./review-preview.js";
import { CITE_OPEN_PATTERN } from "./reference-data.js";
import { mountReferenceWorkbench } from "./reference-workbench.js";
import { createCitationTools } from "./citation-tools.js";

let reviewCenter;
let referenceWorkbench;
let citationTools;

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const MAX_TERMINOLOGY_ENTRIES = 48;
const MAX_FIGURE_IMAGE_COUNT = 24;
const MAX_PARALLEL_SEGMENT_TRANSLATIONS = 6;
const CITATION_DRAG_TYPE = "application/x-paperbridge-citation";
const CITATION_SOURCE_TOKEN = new RegExp("^" + CITE_OPEN_PATTERN + "[^{}]*\\}", "i");
const UNDO_TRACKED_URLS = new Set([
  "/api/project/bibliography/migrate",
  "/api/references/add",
  "/api/references/change",
  "/api/project/modularize/apply",
  "/api/source/create",
  "/api/source",
  "/api/math-block",
  "/api/math-block/move",
  "/api/table-block",
  "/api/figure/insert",
  "/api/structure/insert",
  "/api/segment/chinese",
  "/api/segment/translate",
  "/api/segment/add",
  "/api/segment/delete",
  "/api/segment/comment",
  "/api/segment/english",
  "/api/file/terminology",
  "/api/file/translate-to-chinese",
  "/api/file/terminology/apply"
]);
const FAST_PREVIEW_SECTION_PATTERN = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/;
const FAST_PREVIEW_BEGIN_END_PATTERN = /^\\(begin|end)\{/;
const FAST_PREVIEW_GROUPED_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "alignat", "alignat*", "flalign", "flalign*",
  "figure", "figure*", "table", "table*", "tabular", "tabular*",
  "tikzpicture", "pgfpicture", "verbatim", "lstlisting", "minted",
  "theorem", "lemma", "proposition", "corollary", "definition",
  "example", "remark", "proof", "abstract",
  "itemize", "enumerate", "description",
  "minipage", "center", "flushleft", "flushright",
  "thebibliography"
]);
const FAST_PREVIEW_PROSE_ENVS = new Set([
  "proof", "theorem", "lemma", "proposition", "corollary", "definition", "example", "remark", "abstract"
]);

import { describeDraftDiff, readingFragment, readingSource, renderDisplayFormula } from "./translation-reading.js";
import { belongsToTranslationSection, summarizeTranslationSections } from "./translation-outline.js";

const state = {
  translationLayout: localStorage.getItem("paperBridge.translationLayout") === "wide" ? "wide" : "compare",
  translationExpanded: false,
  translationDirection: localStorage.getItem("paperBridge.translationDirection") === "en" ? "en" : "zh",
  project: null,
  currentFile: null,
  currentDocument: null,
  documentLoadToken: 0,
  warnings: [],
  mode: "source",
  referencesOpen: false,
  sidebarPanel: localStorage.getItem("paperBridge.sidebarPanel") ?? "files",
  sidebarWidth: Math.min(480, Math.max(120, Number(localStorage.getItem("paperBridge.sidebarWidth")) || 160)),
  bilingualLayout: localStorage.getItem("paperBridge.bilingualLayout") === "vertical" ? "vertical" : "horizontal",
  reviewSelection: null,
  reviewPdfVersion: "",
  saveTimers: new Map(),
  pendingWrites: 0,
  undoCount: 0,
  undoLabel: "",
  previewMode: "pdf",
  compileOnOpenPending: true,
  pdfRenderKey: "",
  fastPreviewFile: "",
  fastPreviewCache: [],
  fastPreviewTimer: 0,
  fastPreviewToken: 0,
  fastPreviewMathObserver: null,
  fastPreviewFigureObserver: null,
  fastPreviewGraphicsPaths: [],
  markdownScrollSync: {
    origin: "",
    lockUntil: 0
  },
  pdfRenderToken: 0,
  pdfDocument: null,
  pdfObserver: null,
  pdfPageRenderTasks: new Map(),
  pdfTextLayers: new Map(),
  visiblePdfPage: 1,
  pdfZoom: Math.min(300, Math.max(50, Number(localStorage.getItem("paperBridge.pdfZoom") || 100))),
  pdfPan: null,
  pdfRenderTimer: 0,
  pdfResizeFrame: 0,
  pendingPdfResizeAnchor: null,
  pdfParagraphIndex: null,
  pdfParagraphIndexPromise: null,
  pdfCaptionIndex: null,
  pdfCaptionIndexPromise: null,
  pdfSourceIndex: null,
  pdfSourceIndexPromise: null,
  pdfNavigationToken: 0,
  pdfNavigationBusy: false,
  pdfExportToken: 0,
  buildPreviewAvailable: null,
  compileInFlight: false,
  editorFontSize: Math.min(14, Math.max(12, Math.round(Number(localStorage.getItem("paperBridge.editorFontSize")) || 13))),
  bilingualSplit: Math.min(70, Math.max(30, Number(localStorage.getItem("paperBridge.bilingualSplit") || 50))),
  workspaceSplit: Math.min(72, Math.max(32, Number(localStorage.getItem("paperBridge.workspaceSplit") || 54))),
  resizeFrame: 0,
  segmentResizeObserver: null,
  projectRefreshTimer: 0,
  projectFileCheck: false,
  setupMode: "initial",
  storageRootSelected: false,
  paragraphAnchor: null,
  figureAnchor: null,
  gitPushResolver: null,
  gitConflictResolver: null,
  gitManagement: null,
  gitManagementProject: null,
  gitManagementToken: 0,
  gitRemoteName: "",
  currentSectionId: null,
  fileTranslationJobs: new Map(),
  segmentTranslationJobs: new Map(),
  segmentTranslationQueue: [],
  activeSegmentTranslations: 0,
  lastFileTranslationProgress: null,
  visibleTranslationJobFile: "",
  mainTexResolver: null,
  sourceFile: null,
  sourceHash: "",
  sourceEol: "\n",
  sourceSavedContent: "",
  sourceDirty: false,
  sourceMissing: false,
  sourceAutosaveTimer: 0,
  sourceEditorRefreshFrame: 0,
  sourceSaveInFlight: false,
  sourceSavePending: false,
  sourceSearchQuery: "",
  sourceSearchMatches: [],
  sourceSearchIndex: -1,
  sourceSearchRequest: 0,
  sourceSearchContents: new Map(),
  expandedProjectFolders: new Set(),
  projectTreeInitialized: false,
  sourceHighlightTimer: 0,
  figureSelectedSlot: 0,
  figureSlots: [],
  figureNumberInputChanged: false,
  structureType: "figure",
  formulaMathfield: null,
  citationTarget: null,
  structurePreview: null,
  compileDiagnosisToken: 0,
  compileDiagnosisFingerprint: "",
  dismissedBuildDrawerFingerprint: "",
  terminologyFile: null,
  terminologyEntries: [],
  terminologyDirty: false,
  draggingMathBlock: null
};

const elements = {
  workspace: document.querySelector(".workspace"),
  sidebar: document.querySelector(".sidebar"),
  sidebarPanelTitle: document.querySelector("#sidebarPanelTitle"),
  sidebarResizeHandle: document.querySelector("#sidebarResizeHandle"),
  reviewSourceGutter: document.querySelector("#reviewSourceGutter"),
  projectName: document.querySelector("#projectName"),
  topCurrentFile: document.querySelector("#topCurrentFile"),
  headerSaveState: document.querySelector("#headerSaveState"),
  syncState: document.querySelector("#syncState"),
  undoButton: document.querySelector("#undoButton"),
  undoCount: document.querySelector("#undoCount"),
  gitRemoteTarget: document.querySelector("#gitRemoteTarget"),
  gitRemoteSelect: document.querySelector("#gitRemoteSelect"),
  sidebarProjectList: document.querySelector("#sidebarProjectList"),
  projectSwitcherButton: document.querySelector("#projectSwitcherButton"),
  projectSwitcherPopover: document.querySelector("#projectSwitcherPopover"),
  projectSwitcherList: document.querySelector("#projectSwitcherList"),
  openProjectFolderButton: document.querySelector("#openProjectFolderButton"),
  documentCount: document.querySelector("#documentCount"),
  documentList: document.querySelector("#documentList"),
  sectionCount: document.querySelector("#sectionCount"),
  sectionList: document.querySelector("#sectionList"),
  translationProgress: document.querySelector("#translationProgress"),
  translationProgressCount: document.querySelector("#translationProgressCount"),
  translationProgressPercent: document.querySelector("#translationProgressPercent"),
  translationProgressBar: document.querySelector("#translationProgressBar"),
  terminologyButton: document.querySelector("#terminologyButton"),
  fileTranslationProgress: document.querySelector("#fileTranslationProgress"),
  fileTranslationProgressLabel: document.querySelector("#fileTranslationProgressLabel"),
  fileTranslationProgressCount: document.querySelector("#fileTranslationProgressCount"),
  fileTranslationProgressTrack: document.querySelector("#fileTranslationProgressTrack"),
  fileTranslationProgressBar: document.querySelector("#fileTranslationProgressBar"),
  currentFile: document.querySelector("#currentFile"),
  fileMeta: document.querySelector("#fileMeta"),
  editorFontSize: document.querySelector("#editorFontSize"),
  translateSectionButton: document.querySelector("#translateSectionButton"),
  bilingualHeadings: document.querySelector("#bilingualHeadings"),
  splitHandle: document.querySelector("#splitHandle"),
  workspaceSplitHandle: document.querySelector("#workspaceSplitHandle"),
  segmentList: document.querySelector("#segmentList"),
  pageStatus: document.querySelector("#pageStatus"),
  pdfScroll: document.querySelector("#pdfScroll"),
  previewPanel: document.querySelector(".preview-panel"),
  previewTitle: document.querySelector("#previewTitle"),
  previewModeLabel: document.querySelector("#previewModeLabel"),
  previewCompileButton: document.querySelector("#previewCompileButton"),
  exportPdfButton: document.querySelector("#exportPdfButton"),
  visiblePage: document.querySelector("#visiblePage"),
  pdfZoomValue: document.querySelector("#pdfZoomValue"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  warningCount: document.querySelector("#warningCount"),
  warningList: document.querySelector("#warningList"),
  buildDrawer: document.querySelector("#buildDrawer"),
  compileDiagnosis: document.querySelector("#compileDiagnosis"),
  compileDiagnosisStatus: document.querySelector("#compileDiagnosisStatus"),
  compileDiagnosisSummary: document.querySelector("#compileDiagnosisSummary"),
  compileDiagnosisList: document.querySelector("#compileDiagnosisList"),
  editView: document.querySelector("#editView"),
  sourceView: document.querySelector("#sourceView"),
  sourceViewTitle: document.querySelector("#sourceViewTitle"),
  sourceFileControl: document.querySelector("#sourceFileControl"),
  sourceFocusButton: document.querySelector("#sourceFocusButton"),
  sourceCreateTexButton: document.querySelector("#sourceCreateTexButton"),
  sourceFileSelect: document.querySelector("#sourceFileSelect"),
  sourceEditorShell: document.querySelector(".source-editor-shell"),
  projectFilePreview: document.querySelector("#projectFilePreview"),
  projectFilePreviewTitle: document.querySelector("#projectFilePreviewTitle"),
  projectFilePreviewMeta: document.querySelector("#projectFilePreviewMeta"),
  projectFilePreviewBody: document.querySelector("#projectFilePreviewBody"),
  closeProjectFilePreviewButton: document.querySelector("#closeProjectFilePreviewButton"),
  sourceEditor: document.querySelector("#sourceEditor"),
  sourceHighlightLayer: document.querySelector("#sourceHighlightLayer"),
  sourceLineNumbers: document.querySelector("#sourceLineNumbers"),
  sourceStatus: document.querySelector("#sourceStatus"),
  saveSourceButton: document.querySelector("#saveSourceButton"),
  createTexFileButton: document.querySelector("#createTexFileButton"),
  createTexDialog: document.querySelector("#createTexDialog"),
  createTexForm: document.querySelector("#createTexForm"),
  newTexFileName: document.querySelector("#newTexFileName"),
  newTexInsertion: document.querySelector("#newTexInsertion"),
  newTexInsertionNote: document.querySelector("#newTexInsertionNote"),
  submitCreateTexButton: document.querySelector("#submitCreateTexButton"),
  insertFigureSourceButton: document.querySelector("#insertFigureSourceButton"),
  sourceInsertMenu: document.querySelector("#sourceInsertMenu"),
  modularizeButton: document.querySelector("#modularizeButton"),
  sourceSearchInput: null,
  sourceReplaceInput: null,
  sourceReplacePanel: null,
  sourceSearchResults: null,
  sourceSearchReplaceButton: null,
  sourceSearchReplaceAllButton: null,
  sourceSearchCount: null,
  sourceSearchPreviousButton: null,
  sourceSearchNextButton: null,
  referencesView: document.querySelector("#referencesView"),
  referencesSearch: document.querySelector("#referencesSearch"),
  closeReferencesButton: document.querySelector("#closeReferencesButton"),
  setupDialog: document.querySelector("#setupDialog"),
  setupForm: document.querySelector("#setupForm"),
  setupMessage: document.querySelector("#setupMessage"),
  recentProjectList: document.querySelector("#recentProjectList"),
  dependencyStatus: document.querySelector("#dependencyStatus"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  mainTexDialog: document.querySelector("#mainTexDialog"),
  mainTexForm: document.querySelector("#mainTexForm"),
  mainTexSelect: document.querySelector("#mainTexSelect"),
  paragraphDialog: document.querySelector("#paragraphDialog"),
  paragraphForm: document.querySelector("#paragraphForm"),
  newParagraphChinese: document.querySelector("#newParagraphChinese"),
  figureDialog: document.querySelector("#figureDialog"),
  figureForm: document.querySelector("#figureForm"),
  figureAnchorMeta: document.querySelector("#figureAnchorMeta"),
  figureImagesInput: document.querySelector("#figureImagesInput"),
  figurePlacementInput: document.querySelector("#figurePlacementInput"),
  figureLayoutSummary: document.querySelector("#figureLayoutSummary"),
  figureSpanInput: document.querySelector("#figureSpanInput"),
  figureAlignmentInput: document.querySelector("#figureAlignmentInput"),
  figureArrangementInput: document.querySelector("#figureArrangementInput"),
  figureImageCountInput: document.querySelector("#figureImageCountInput"),
  figureColumnsInput: document.querySelector("#figureColumnsInput"),
  figurePositionInput: document.querySelector("#figurePositionInput"),
  figureGrid: document.querySelector("#figureGrid"),
  chooseExternalFigureButton: document.querySelector("#chooseExternalFigureButton"),
  figureExternalInput: document.querySelector("#figureExternalInput"),
  figureCaptionInput: document.querySelector("#figureCaptionInput"),
  figureLabelInput: document.querySelector("#figureLabelInput"),
  insertFigureSubmitButton: document.querySelector("#insertFigureSubmitButton"),
  structureDialogTitle: document.querySelector("#structureDialogTitle"),
  structureTypeInput: document.querySelector("#structureTypeInput"),
  figureOptions: document.querySelector("#figureOptions"),
  tableOptions: document.querySelector("#tableOptions"),
  formulaOptions: document.querySelector("#formulaOptions"),
  insertTableRows: document.querySelector("#insertTableRows"),
  insertTableColumns: document.querySelector("#insertTableColumns"),
  insertTableSpan: document.querySelector("#insertTableSpan"),
  insertTableBorder: document.querySelector("#insertTableBorder"),
  insertTableGrid: document.querySelector("#insertTableGrid"),
  insertTableCaption: document.querySelector("#insertTableCaption"),
  insertTableLabel: document.querySelector("#insertTableLabel"),
  formulaPalette: document.querySelector("#formulaPalette"),
  formulaMathfieldShell: document.querySelector("#formulaMathfieldShell"),
  formulaKeyboard: document.querySelector("#formulaKeyboard"),
  insertFormulaNumbered: document.querySelector("#insertFormulaNumbered"),
  insertFormulaLabel: document.querySelector("#insertFormulaLabel"),
  insertFormulaLatex: document.querySelector("#insertFormulaLatex"),
  gitManagerDialog: document.querySelector("#gitManagerDialog"),
  gitManagerProjectMeta: document.querySelector("#gitManagerProjectMeta"),
  gitRemoteList: document.querySelector("#gitRemoteList"),
  gitRemoteForm: document.querySelector("#gitRemoteForm"),
  gitRemoteOriginalName: document.querySelector("#gitRemoteOriginalName"),
  gitRemoteProvider: document.querySelector("#gitRemoteProvider"),
  gitRemoteName: document.querySelector("#gitRemoteName"),
  gitRemoteUrl: document.querySelector("#gitRemoteUrl"),
  gitRemoteCredential: document.querySelector("#gitRemoteCredential"),
  gitRemoteDefault: document.querySelector("#gitRemoteDefault"),
  gitCredentialList: document.querySelector("#gitCredentialList"),
  gitCredentialForm: document.querySelector("#gitCredentialForm"),
  gitCredentialId: document.querySelector("#gitCredentialId"),
  gitCredentialName: document.querySelector("#gitCredentialName"),
  gitCredentialProvider: document.querySelector("#gitCredentialProvider"),
  gitCredentialUsernameField: document.querySelector("#gitCredentialUsernameField"),
  gitCredentialUsername: document.querySelector("#gitCredentialUsername"),
  gitCredentialToken: document.querySelector("#gitCredentialToken"),
  gitCredentialScope: document.querySelector("#gitCredentialScope"),
  gitManagerStatus: document.querySelector("#gitManagerStatus"),
  gitPushDialog: document.querySelector("#gitPushDialog"),
  gitPushForm: document.querySelector("#gitPushForm"),
  gitPushList: document.querySelector("#gitPushList"),
  gitConflictDialog: document.querySelector("#gitConflictDialog"),
  gitConflictForm: document.querySelector("#gitConflictForm"),
  gitConflictMeta: document.querySelector("#gitConflictMeta"),
  gitConflictList: document.querySelector("#gitConflictList"),
  structureDialog: document.querySelector("#structureDialog"),
  structureForm: document.querySelector("#structureForm"),
  structureSummary: document.querySelector("#structureSummary"),
  structureFlow: document.querySelector("#structureFlow"),
  structureFileList: document.querySelector("#structureFileList"),
  structureWarning: document.querySelector("#structureWarning"),
  applyStructureButton: document.querySelector("#applyStructureButton"),
  migrateBibliographyButton: document.querySelector("#migrateBibliographyButton"),
  terminologyDialog: document.querySelector("#terminologyDialog"),
  terminologyMeta: document.querySelector("#terminologyMeta"),
  terminologySearch: document.querySelector("#terminologySearch"),
  terminologyList: document.querySelector("#terminologyList"),
  terminologyEmpty: document.querySelector("#terminologyEmpty"),
  terminologyStatus: document.querySelector("#terminologyStatus"),
  regenerateTerminologyButton: document.querySelector("#regenerateTerminologyButton"),
  applyTerminologyDefinitionsButton: document.querySelector("#applyTerminologyDefinitionsButton"),
  addTerminologyButton: document.querySelector("#addTerminologyButton"),
  saveTerminologyButton: document.querySelector("#saveTerminologyButton"),
  referenceInsertDialog: document.querySelector("#referenceInsertDialog"),
  referenceInsertForm: document.querySelector("#referenceInsertForm"),
  referenceInsertMeta: document.querySelector("#referenceInsertMeta"),
  referenceInsertSearch: document.querySelector("#referenceInsertSearch"),
  toastRegion: document.querySelector("#toastRegion")
};

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function fitSegmentRow(row) {
  for (const editor of row.querySelectorAll(".segment-edit-surface:not([hidden]) textarea")) {
    editor.style.height = "auto";
    editor.style.height = Math.ceil(editor.scrollHeight) + "px";
  }
}

function fitAllSegmentRows() {
  window.cancelAnimationFrame(state.resizeFrame);
  state.resizeFrame = window.requestAnimationFrame(() => {
    elements.segmentList.querySelectorAll(".segment-row").forEach(fitSegmentRow);
  });
}

function observeSegmentEditorSize() {
  if (state.segmentResizeObserver || typeof ResizeObserver === "undefined") return;
  state.segmentResizeObserver = new ResizeObserver(() => fitAllSegmentRows());
  state.segmentResizeObserver.observe(elements.segmentList);
}

function applyEditorPreferences(persist = true) {
  document.documentElement.style.setProperty("--editor-font-size", `${state.editorFontSize}px`);
  document.documentElement.style.setProperty("--bilingual-split", `${state.bilingualSplit}%`);
  if (elements.editorFontSize) elements.editorFontSize.textContent = String(state.editorFontSize);
  if (persist) {
    localStorage.setItem("paperBridge.editorFontSize", String(state.editorFontSize));
    localStorage.setItem("paperBridge.bilingualSplit", String(state.bilingualSplit));
  }
  fitAllSegmentRows();
}

function setSidebarPanel(panel, { persist = true } = {}) {
  const labels = { files: "资源管理器", comments: "批注" };
  const selected = Object.hasOwn(labels, panel) ? panel : "";
  const anchor = state.pdfDocument ? capturePdfViewportAnchor() : null;
  state.sidebarPanel = selected;
  if (state.referencesOpen) setReferencesOpen(false);
  elements.workspace.classList.toggle("sidebar-collapsed", !selected);
  elements.sidebar.classList.toggle("hidden", !selected);
  elements.sidebar.dataset.panel = selected;
  elements.sidebarPanelTitle.textContent = labels[selected] || "文件与工具";
  document.querySelectorAll("[data-sidebar-content]").forEach((section) => {
    section.classList.toggle("hidden", !section.dataset.sidebarContent.split(" ").includes(selected));
  });
  document.querySelectorAll("[data-sidebar-panel]").forEach((button) => {
    const expanded = button.dataset.sidebarPanel === selected;
    button.classList.toggle("panel-active", expanded);
    button.classList.toggle("active", expanded || button.dataset.mode === state.mode);
    button.setAttribute("aria-expanded", String(expanded));
  });
  if (persist) localStorage.setItem("paperBridge.sidebarPanel", selected);
  if (selected === "comments") void reviewCenter?.load();
  fitAllSegmentRows();
  schedulePdfPanelResize(anchor);
  if (state.previewMode === "markdown") requestAnimationFrame(syncMarkdownPreviewToSource);
}

function setBilingualLayout(layout, { persist = true } = {}) {
  state.bilingualLayout = layout === "vertical" ? "vertical" : "horizontal";
  elements.workspace.dataset.bilingualLayout = state.bilingualLayout;
  document.querySelectorAll('input[name="bilingualLayout"]').forEach((input) => {
    input.checked = input.value === state.bilingualLayout;
  });
  const label = state.bilingualLayout === "vertical" ? "上下预览" : "左右对比";
  document.querySelector("#bilingualLayoutLabel").textContent = label;
  if (persist) localStorage.setItem("paperBridge.bilingualLayout", state.bilingualLayout);
  fitAllSegmentRows();
  refreshIcons();
}

function applySidebarWidth(persist = true) {
  document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  elements.sidebarResizeHandle.setAttribute("aria-valuenow", String(state.sidebarWidth));
  if (persist) localStorage.setItem("paperBridge.sidebarWidth", String(state.sidebarWidth));
  fitAllSegmentRows();
  schedulePdfPanelResize();
}

function resizeSidebar(clientX) {
  const bounds = elements.sidebar.getBoundingClientRect();
  const maximum = Math.min(480, window.innerWidth - bounds.left - 24);
  state.sidebarWidth = Math.round(Math.min(maximum, Math.max(120, clientX - bounds.left)));
  applySidebarWidth(false);
}

function setBilingualSplit(clientX) {
  const bounds = elements.bilingualHeadings.getBoundingClientRect();
  const percent = ((clientX - bounds.left) / bounds.width) * 100;
  state.bilingualSplit = Math.min(70, Math.max(30, Math.round(percent * 10) / 10));
  applyEditorPreferences(false);
}

function applyWorkspaceSplit(persist = true) {
  const anchor = state.pdfDocument ? capturePdfViewportAnchor() : null;
  document.documentElement.style.setProperty("--workspace-editor-share", `${state.workspaceSplit}fr`);
  document.documentElement.style.setProperty("--workspace-preview-share", `${100 - state.workspaceSplit}fr`);
  elements.workspaceSplitHandle.setAttribute("aria-valuenow", String(Math.round(state.workspaceSplit)));
  if (persist) localStorage.setItem("paperBridge.workspaceSplit", String(state.workspaceSplit));
  fitAllSegmentRows();
  schedulePdfPanelResize(anchor);
}

function setWorkspaceSplit(clientX) {
  const workspaceBounds = elements.workspace.getBoundingClientRect();
  const editorBounds = (state.mode === "source" ? elements.sourceView : elements.editView).getBoundingClientRect();
  const dividerWidth = elements.workspaceSplitHandle.offsetWidth || 12;
  const availableWidth = Math.max(1, workspaceBounds.right - editorBounds.left - dividerWidth);
  const compact = window.innerWidth <= 1220;
  const minimumEditor = compact ? 360 : 400;
  const minimumPreview = compact ? 320 : 340;
  const lower = Math.max(32, minimumEditor / availableWidth * 100);
  const upper = Math.min(72, 100 - minimumPreview / availableWidth * 100);
  const requested = (clientX - editorBounds.left - dividerWidth / 2) / availableWidth * 100;
  state.workspaceSplit = Math.round(Math.min(Math.max(lower, requested), Math.max(lower, upper)) * 10) / 10;
  applyWorkspaceSplit(false);
}

function setupProviderProfile() {
  const selectedModel = document.querySelector("#setupModel").value;
  return {
    type: document.querySelector("#setupProviderType").value,
    model: selectedModel === "__custom__"
      ? document.querySelector("#setupCustomModel").value.trim()
      : selectedModel,
    baseUrl: document.querySelector("#setupBaseUrl").value.trim(),
    apiKey: document.querySelector("#setupApiKey").value.trim(),
    apiPath: "",
    jsonMode: true,
    extraHeaders: ""
  };
}

function updateSetupCustomModel() {
  const custom = document.querySelector("#setupModel").value === "__custom__";
  document.querySelector("#setupCustomModelField").classList.toggle("hidden", !custom);
  document.querySelector("#setupCustomModel").required = false;
}

function updateSetupModelOptions(type) {
  const model = document.querySelector("#setupModel");
  const previous = model.value;
  const options = type === "openai-compatible"
    ? [
        ["deepseek-v4-flash", "DeepSeek V4 Flash（推荐）"],
        ["deepseek-v4-pro", "DeepSeek V4 Pro"],
        ["__custom__", "其他 / 自定义模型"]
      ]
    : [["__custom__", "自定义模型"]];
  model.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  model.value = options.some(([value]) => value === previous) ? previous : options[0][0];
  updateSetupCustomModel();
}

function setSetupMessage(message = "", type = "") {
  elements.setupMessage.textContent = message;
  elements.setupMessage.className = `setup-message ${type}`.trim();
}

function updateSetupSource() {
  const mode = document.querySelector('input[name="setupSource"]:checked').value;
  document.querySelectorAll("[data-source-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.sourcePanel !== mode);
  });
  const canConnectGit = ["zip", "local"].includes(mode);
  document.querySelector("#setupOptionalGit").classList.toggle("hidden", !canConnectGit);
  if (!canConnectGit) document.querySelector("#setupConnectGit").checked = false;
  updateOptionalGitFields();
}

function updateOptionalGitFields() {
  const enabled = document.querySelector("#setupConnectGit").checked;
  document.querySelector("#setupOptionalGitFields").classList.toggle("hidden", !enabled);
}

function updateSetupProviderDefaults() {
  const type = document.querySelector("#setupProviderType").value;
  updateSetupModelOptions(type);
  const baseUrl = document.querySelector("#setupBaseUrl");
  const knownDefaults = ["", "https://api.deepseek.com", "https://api.anthropic.com", "https://generativelanguage.googleapis.com/v1beta"];
  if (!knownDefaults.includes(baseUrl.value.trim())) return;
  baseUrl.value = type === "anthropic"
    ? "https://api.anthropic.com"
    : type === "gemini"
      ? "https://generativelanguage.googleapis.com/v1beta"
      : "https://api.deepseek.com";
}

function recentProjectTimeLabel(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString();
}

function projectGitServices(project) {
  return [...new Set((project?.git?.remotes || [])
    .map((remote) => String(remote.label || "").trim())
    .filter(Boolean))];
}

function projectGitServiceText(project) {
  const services = projectGitServices(project);
  return services.length ? services.join(" + ") : "未连接 Git";
}

function projectIdentityMatches(item, config) {
  return String(item.projectRoot || "").toLowerCase() === String(config.projectRoot || "").toLowerCase()
    && String(item.mainTex || "").toLowerCase() === String(config.mainTex || "").toLowerCase();
}

function projectDisplayTitle(config) {
  const name = config.projectName || config.projectRoot?.split(/[\\/]/).filter(Boolean).at(-1) || "论文项目";
  const duplicates = (config.recentProjects || []).filter((item) => (
    !projectIdentityMatches(item, config) && item.name?.toLowerCase() === name.toLowerCase()
  ));
  if (!config.projectRoot || !duplicates.length) return name;
  const folderTail = (folder) => folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  const directory = config.projectRoot.toLowerCase();
  const shortened = folderTail(config.projectRoot);
  const sameFolder = duplicates.some((item) => item.projectRoot.toLowerCase() === directory);
  const similarFolder = duplicates.some((item) => item.projectRoot.toLowerCase() !== directory
    && folderTail(item.projectRoot).toLowerCase() === shortened.toLowerCase());
  return [name, similarFolder ? config.projectRoot : shortened, sameFolder ? config.mainTex : ""].filter(Boolean).join(" · ");
}

function projectFolderActionLabel() {
  return window.paperBridgeDesktop?.openProjectFolder ? "打开项目文件夹" : "复制项目路径";
}

async function openProjectFolder(projectRoot) {
  if (!projectRoot) return;
  try {
    if (window.paperBridgeDesktop?.openProjectFolder) {
      await window.paperBridgeDesktop.openProjectFolder(projectRoot);
      return;
    }
    await navigator.clipboard.writeText(projectRoot);
    toast("已复制项目路径。");
  } catch (error) {
    toast(error.message, "error", 5200);
  }
}

function renderRecentProjects(project) {
  const section = document.querySelector("#recentProjectsSection");
  const list = elements.recentProjectList;
  const projects = project.config?.recentProjects || [];
  section.classList.toggle("hidden", projects.length === 0);
  list.replaceChildren();
  for (const item of projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-project-button";
    button.innerHTML = `
      <i data-lucide="folder"></i>
      <div>
        <div class="recent-project-main"></div>
        <div class="recent-project-path"></div>
      </div>
      <div class="recent-project-meta"></div>
    `;
    const isCurrent = projectIdentityMatches(item, project.config || {});
    button.title = item.projectRoot;
    button.querySelector(".recent-project-main").textContent = `${item.name || "论文项目"} · ${item.mainTex}`;
    button.querySelector(".recent-project-path").textContent = item.projectRoot;
    button.querySelector(".recent-project-meta").textContent = [
      isCurrent ? "当前项目" : recentProjectTimeLabel(item.updatedAt),
      projectGitServiceText(item)
    ].filter(Boolean).join(" · ");
    button.addEventListener("click", () => openRecentProject(item, button));
    list.append(button);
  }
}

function renderSidebarProjectList(project = state.project) {
  const list = elements.sidebarProjectList;
  if (!list) return;
  const config = project?.config || {};
  const projects = config.recentProjects || [];
  list.replaceChildren();
  if (!project) {
    const empty = document.createElement("div");
    empty.className = "project-switch-empty";
    empty.textContent = "尚未打开项目";
    list.append(empty);
    return;
  }
  const recentCurrent = projects.find((item) => projectIdentityMatches(item, config));
  const current = {
    ...(recentCurrent || {}),
    name: config.projectName || recentCurrent?.name || fileLabel(config.projectRoot || "论文项目"),
    projectRoot: config.projectRoot,
    mainTex: config.mainTex,
    git: project.git
  };
  const row = document.createElement("div");
  const button = document.createElement("button");
  const manageButton = document.createElement("button");
  row.className = "project-switch-row current-project-card";
  button.type = "button";
  button.className = "project-switch-button active";
  button.title = current.projectRoot || "";
  button.innerHTML = `
    <i data-lucide="folder"></i>
    <span class="project-switch-copy">
      <span class="project-switch-name"></span>
      <span class="project-git-services"></span>
      <span class="project-connection-state"><span class="status-dot"></span><span></span></span>
    </span>
  `;
  button.querySelector(".project-switch-name").textContent = projectDisplayTitle(config);
  button.querySelector(".project-git-services").textContent = projectGitServiceText(project);
  button.querySelector(".project-connection-state span:last-child").textContent = project.git?.remoteName ? "已连接" : "未连接远端";
  manageButton.type = "button";
  manageButton.className = "project-git-manage-button";
  manageButton.title = projectGitServices(project).length ? "管理 Git 远端" : "连接远端";
  manageButton.setAttribute("aria-label", `${current.name}：${manageButton.title}`);
  manageButton.innerHTML = `<i data-lucide="arrow-up-right"></i>`;
  manageButton.addEventListener("click", () => void openGitManager(current));
  row.append(button, manageButton);
  list.append(row);
  renderProjectSwitcherMenu(project);
  refreshIcons();
}

function renderProjectSwitcherMenu(project = state.project) {
  const list = elements.projectSwitcherList;
  if (!list || !project) return;
  const config = project.config || {};
  const recent = config.recentProjects || [];
  const current = recent.find((item) => projectIdentityMatches(item, config))
    || (config.projectRoot && config.mainTex ? { projectRoot: config.projectRoot, mainTex: config.mainTex, name: config.projectName, git: project.git } : null);
  const projects = current ? [current, ...recent.filter((item) => !projectIdentityMatches(item, config))] : recent;
  list.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "project-switcher-empty";
    empty.innerHTML = '<i data-lucide="folder-clock"></i><span>还没有最近项目</span>';
    list.append(empty);
    return;
  }
  for (const item of projects) {
    const isCurrent = item === current;
    const row = document.createElement("div");
    row.className = "project-switcher-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-switcher-item";
    button.title = item.projectRoot || "";
    if (isCurrent) button.setAttribute("aria-current", "true");
    button.innerHTML = `
      <i data-lucide="folder"></i>
      <span class="project-switcher-item-copy">
        <strong></strong>
        <span class="project-switcher-item-path"></span>
        <span class="project-switcher-item-meta"></span>
      </span>
    `;
    button.querySelector("strong").textContent = item.name || projectDisplayTitle({ projectRoot: item.projectRoot });
    button.querySelector(".project-switcher-item-path").textContent = item.projectRoot;
    button.querySelector(".project-switcher-item-meta").textContent = [
      isCurrent ? "当前项目" : "",
      item.mainTex,
      projectGitServiceText(item),
      isCurrent ? "" : recentProjectTimeLabel(item.updatedAt)
    ].filter(Boolean).join(" · ");
    button.addEventListener("click", () => {
      elements.projectSwitcherPopover?.hidePopover?.();
      if (!isCurrent) void openRecentProject(item, button);
    });
    const folder = document.createElement("button");
    folder.type = "button";
    folder.className = "icon-button project-folder-action";
    folder.title = projectFolderActionLabel();
    folder.setAttribute("aria-label", folder.title);
    folder.innerHTML = '<i data-lucide="folder-open"></i>';
    folder.addEventListener("click", () => void openProjectFolder(item.projectRoot));
    row.append(button, folder);
    list.append(row);
  }
  refreshIcons();
}

async function openRecentProject(project, button) {
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return;
    state.sourceDirty = false;
  }
  setBusy(button, true);
  elements.projectSwitcherPopover?.hidePopover?.();
  if (elements.setupDialog.open) setSetupMessage("正在打开历史项目...");
  try {
    await api("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ projectRoot: project.projectRoot, mainTex: project.mainTex })
    });
    if (elements.setupDialog.open) elements.setupDialog.close();
    const ready = await refreshProject({ preserveDocument: false });
    if (ready) toast("已切换到历史项目。", "success");
  } catch (error) {
    if (elements.setupDialog.open) setSetupMessage(`无法打开历史项目：${error.message}`, "error");
    toast(`无法打开历史项目：${error.message}`, "error", 6200);
  } finally {
    setBusy(button, false);
  }
}

function setGitManagerStatus(message = "", type = "") {
  elements.gitManagerStatus.textContent = message;
  elements.gitManagerStatus.className = `setup-message ${type}`.trim();
}

function gitManagerActionButton(icon, title, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button small ${className}`.trim();
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i data-lucide="${icon}"></i>`;
  button.addEventListener("click", handler);
  return button;
}

function gitServiceClass(label = "") {
  const normalized = String(label).toLowerCase();
  if (normalized.includes("overleaf")) return "overleaf";
  if (normalized.includes("github")) return "github";
  if (normalized.includes("gitlab")) return "gitlab";
  return "git";
}

function renderGitCredentialOptions(provider = elements.gitRemoteProvider.value, selectedId = "") {
  const profiles = (state.gitManagement?.credentialProfiles || [])
    .filter((profile) => profile.provider === provider);
  const options = [new Option("自动选择兼容凭据", "")];
  for (const profile of profiles) {
    const scope = profile.scope === "project" ? "当前项目" : "共享";
    const token = profile.hasToken ? "已保存 Token" : "未保存 Token";
    options.push(new Option(`${profile.name} · ${scope} · ${token}`, profile.id));
  }
  elements.gitRemoteCredential.replaceChildren(...options);
  elements.gitRemoteCredential.value = profiles.some((profile) => profile.id === selectedId) ? selectedId : "";
}

function updateGitRemoteProviderForm({ preserveCredential = true } = {}) {
  const provider = elements.gitRemoteProvider.value;
  const currentCredential = preserveCredential ? elements.gitRemoteCredential.value : "";
  if (provider === "overleaf") {
    elements.gitRemoteName.value = "overleaf";
    elements.gitRemoteName.readOnly = true;
    elements.gitRemoteUrl.placeholder = "https://cn.overleaf.com/project/...";
  } else {
    if (!elements.gitRemoteName.value || elements.gitRemoteName.value === "overleaf") {
      elements.gitRemoteName.value = "paperbridge";
    }
    elements.gitRemoteName.readOnly = false;
    elements.gitRemoteUrl.placeholder = "https://github.com/owner/repository.git";
  }
  renderGitCredentialOptions(provider, currentCredential);
}

function updateGitCredentialProviderForm() {
  const overleaf = elements.gitCredentialProvider.value === "overleaf";
  elements.gitCredentialUsernameField.classList.toggle("hidden", overleaf);
  elements.gitCredentialUsername.disabled = overleaf;
  if (overleaf) elements.gitCredentialUsername.value = "git";
}

function hideGitRemoteForm() {
  elements.gitRemoteForm.classList.add("hidden");
  elements.gitRemoteForm.reset();
  elements.gitRemoteOriginalName.value = "";
}

function showGitRemoteForm(remote = null) {
  hideGitCredentialForm();
  const provider = remote?.provider === "overleaf" ? "overleaf" : "git";
  elements.gitRemoteForm.reset();
  elements.gitRemoteOriginalName.value = remote?.name || "";
  elements.gitRemoteProvider.value = provider;
  elements.gitRemoteName.value = remote?.name || (provider === "overleaf" ? "overleaf" : "paperbridge");
  elements.gitRemoteUrl.value = remote?.url || "";
  elements.gitRemoteDefault.checked = remote ? remote.default === true : !(state.gitManagement?.remotes || []).length;
  elements.gitRemoteForm.classList.remove("hidden");
  updateGitRemoteProviderForm({ preserveCredential: false });
  elements.gitRemoteCredential.value = remote?.credentialProfileId || "";
  elements.gitRemoteUrl.focus();
  elements.gitRemoteForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideGitCredentialForm() {
  elements.gitCredentialForm.classList.add("hidden");
  elements.gitCredentialForm.reset();
  elements.gitCredentialId.value = "";
  elements.gitCredentialProvider.disabled = false;
  elements.gitCredentialScope.disabled = false;
}

function showGitCredentialForm(profile = null) {
  hideGitRemoteForm();
  elements.gitCredentialForm.reset();
  elements.gitCredentialId.value = profile?.id || "";
  elements.gitCredentialName.value = profile?.name || "";
  elements.gitCredentialProvider.value = profile?.provider === "overleaf" ? "overleaf" : "git";
  elements.gitCredentialUsername.value = profile?.username || "";
  elements.gitCredentialScope.value = profile?.scope === "project" ? "project" : "shared";
  elements.gitCredentialToken.value = "";
  elements.gitCredentialToken.placeholder = profile?.hasToken ? "已保存，留空保持不变" : "输入访问 Token";
  const legacy = ["saved-overleaf", "saved-git"].includes(profile?.id);
  elements.gitCredentialProvider.disabled = legacy;
  elements.gitCredentialScope.disabled = legacy;
  elements.gitCredentialForm.classList.remove("hidden");
  updateGitCredentialProviderForm();
  elements.gitCredentialName.focus();
  elements.gitCredentialForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderGitManager() {
  const management = state.gitManagement;
  elements.gitRemoteList.replaceChildren();
  elements.gitCredentialList.replaceChildren();
  if (!management) {
    const loading = document.createElement("div");
    loading.className = "git-manager-empty";
    loading.textContent = "正在读取项目 Git 配置...";
    elements.gitRemoteList.append(loading);
    return;
  }

  if (!management.remotes.length) {
    const empty = document.createElement("div");
    empty.className = "git-manager-empty";
    empty.textContent = "该项目尚未连接远端。点击“连接远端”即可为现有项目添加 GitHub、GitLab 或 Overleaf。";
    elements.gitRemoteList.append(empty);
  }
  for (const remote of management.remotes) {
    const row = document.createElement("div");
    row.className = "git-manager-row git-remote-row";
    const badge = document.createElement("span");
    badge.className = `git-service-badge ${gitServiceClass(remote.label)}`;
    badge.textContent = remote.label || "Git 远端";
    const copy = document.createElement("div");
    copy.className = "git-manager-row-copy";
    const title = document.createElement("div");
    title.className = "git-manager-row-title";
    title.textContent = `${remote.repository || remote.name} · ${remote.name}`;
    const meta = document.createElement("div");
    meta.className = "git-manager-row-meta";
    meta.textContent = `${remote.url} · 凭据：${remote.credentialName || "自动选择"}`;
    copy.append(title, meta);
    const stateNode = document.createElement("span");
    stateNode.className = `git-default-state ${remote.default ? "active" : ""}`;
    stateNode.textContent = remote.default ? "默认同步" : "非默认";
    const actions = document.createElement("div");
    actions.className = "git-manager-row-actions";
    if (!remote.default) {
      actions.append(gitManagerActionButton("star", "设为默认同步目标", (event) => void setDefaultGitRemote(remote, event.currentTarget)));
    }
    actions.append(
      gitManagerActionButton("plug-zap", "测试连接", (event) => void testSavedGitRemote(remote, event.currentTarget)),
      gitManagerActionButton("pencil", "修改远端", () => showGitRemoteForm(remote)),
      gitManagerActionButton("trash-2", "删除远端", (event) => void deleteGitRemote(remote, event.currentTarget), "danger")
    );
    row.append(badge, copy, stateNode, actions);
    elements.gitRemoteList.append(row);
  }

  if (!management.credentialProfiles.length) {
    const empty = document.createElement("div");
    empty.className = "git-manager-empty";
    empty.textContent = "尚未保存凭据配置。公开仓库可不使用 Token；私有仓库和 Overleaf 需要凭据。";
    elements.gitCredentialList.append(empty);
  }
  for (const profile of management.credentialProfiles) {
    const row = document.createElement("div");
    row.className = "git-manager-row git-credential-row";
    const badge = document.createElement("span");
    badge.className = `git-service-badge ${profile.provider === "overleaf" ? "overleaf" : "git"}`;
    badge.textContent = profile.provider === "overleaf" ? "Overleaf" : "Git";
    const copy = document.createElement("div");
    copy.className = "git-manager-row-copy";
    const title = document.createElement("div");
    title.className = "git-manager-row-title";
    title.textContent = profile.name;
    const meta = document.createElement("div");
    meta.className = "git-manager-row-meta";
    const scope = profile.scope === "project" ? "仅当前项目" : "多个项目共用";
    const token = profile.hasToken ? "Token 已保存" : "未保存 Token";
    meta.textContent = [scope, profile.username ? `用户：${profile.username}` : "", token].filter(Boolean).join(" · ");
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "git-manager-row-actions";
    actions.append(
      gitManagerActionButton("pencil", "修改凭据", () => showGitCredentialForm(profile)),
      gitManagerActionButton("trash-2", "删除凭据", (event) => void deleteGitCredential(profile, event.currentTarget), "danger")
    );
    row.append(badge, copy, actions);
    elements.gitCredentialList.append(row);
  }
  refreshIcons();
}

async function openGitManager(project) {
  const addRemoteButton = document.querySelector("#addGitRemoteButton");
  const addCredentialButton = document.querySelector("#addGitCredentialButton");
  const token = ++state.gitManagementToken;
  state.gitManagementProject = project;
  state.gitManagement = null;
  elements.gitManagerProjectMeta.textContent = `${project.name || fileLabel(project.projectRoot || "论文项目")} · ${project.projectRoot}`;
  hideGitRemoteForm();
  hideGitCredentialForm();
  setGitManagerStatus();
  renderGitManager();
  setBusy(addRemoteButton, true);
  setBusy(addCredentialButton, true);
  if (!elements.gitManagerDialog.open) elements.gitManagerDialog.showModal();
  try {
    const management = await api(`/api/projects/git?projectRoot=${encodeURIComponent(project.projectRoot)}`);
    if (token !== state.gitManagementToken || !elements.gitManagerDialog.open) return;
    state.gitManagement = management;
    renderGitManager();
    setBusy(addRemoteButton, false);
    setBusy(addCredentialButton, false);
  } catch (error) {
    if (token !== state.gitManagementToken || !elements.gitManagerDialog.open) return;
    setGitManagerStatus(`读取 Git 配置失败：${error.message}`, "error");
  }
}

function closeGitManager() {
  state.gitManagementToken += 1;
  hideGitRemoteForm();
  hideGitCredentialForm();
  state.gitManagement = null;
  state.gitManagementProject = null;
  if (elements.gitManagerDialog.open) elements.gitManagerDialog.close();
}

function gitRemoteFormPayload() {
  return {
    projectRoot: state.gitManagement?.project?.projectRoot || state.gitManagementProject?.projectRoot || "",
    originalName: elements.gitRemoteOriginalName.value,
    provider: elements.gitRemoteProvider.value,
    name: elements.gitRemoteName.value.trim(),
    url: elements.gitRemoteUrl.value.trim(),
    credentialProfileId: elements.gitRemoteCredential.value,
    makeDefault: elements.gitRemoteDefault.checked
  };
}

async function refreshAfterGitManagement(management, message) {
  state.gitManagement = management;
  hideGitRemoteForm();
  hideGitCredentialForm();
  renderGitManager();
  setGitManagerStatus(message, "success");
  try {
    await refreshProject({ preserveDocument: true });
  } catch (error) {
    toast(`Git 配置已保存，但项目状态刷新失败：${error.message}`, "error", 5600);
  }
}

async function testGitRemotePayload(payload, button) {
  setBusy(button, true);
  setGitManagerStatus("正在测试远端连接...");
  try {
    const result = await api("/api/projects/git/test", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setGitManagerStatus(result.message || "远端连接成功。", "success");
  } catch (error) {
    setGitManagerStatus(`连接失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function testGitRemoteForm(event) {
  if (!elements.gitRemoteForm.reportValidity()) return;
  await testGitRemotePayload(gitRemoteFormPayload(), event.currentTarget);
}

async function testSavedGitRemote(remote, button) {
  await testGitRemotePayload({
    projectRoot: state.gitManagement.project.projectRoot,
    provider: remote.provider,
    name: remote.name,
    url: remote.url,
    credentialProfileId: remote.credentialProfileId || ""
  }, button);
}

async function saveGitRemote(event) {
  event.preventDefault();
  if (!elements.gitRemoteForm.reportValidity()) return;
  const button = document.querySelector("#saveGitRemoteButton");
  setBusy(button, true);
  setGitManagerStatus("正在测试并保存远端...");
  try {
    const management = await api("/api/projects/git/remote", {
      method: "POST",
      body: JSON.stringify(gitRemoteFormPayload())
    });
    await refreshAfterGitManagement(management, "远端已保存并通过连接测试。");
  } catch (error) {
    setGitManagerStatus(`远端保存失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function setDefaultGitRemote(remote, button) {
  setBusy(button, true);
  try {
    const management = await api("/api/projects/git/default", {
      method: "POST",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, remoteName: remote.name })
    });
    await refreshAfterGitManagement(management, `${remote.label} 已设为默认同步目标。`);
  } catch (error) {
    setGitManagerStatus(`设置默认远端失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteGitRemote(remote, button) {
  if (!window.confirm(`确定从该项目删除远端“${remote.name}”吗？\n\n不会删除远端仓库中的文件。`)) return;
  setBusy(button, true);
  try {
    const management = await api("/api/projects/git/remote", {
      method: "DELETE",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, remoteName: remote.name })
    });
    await refreshAfterGitManagement(management, `远端“${remote.name}”已删除。`);
  } catch (error) {
    setGitManagerStatus(`删除远端失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function saveGitCredential(event) {
  event.preventDefault();
  if (!elements.gitCredentialForm.reportValidity()) return;
  const button = document.querySelector("#saveGitCredentialButton");
  setBusy(button, true);
  try {
    const management = await api("/api/git/credentials", {
      method: "POST",
      body: JSON.stringify({
        projectRoot: state.gitManagement.project.projectRoot,
        id: elements.gitCredentialId.value,
        name: elements.gitCredentialName.value.trim(),
        provider: elements.gitCredentialProvider.value,
        username: elements.gitCredentialUsername.value.trim(),
        token: elements.gitCredentialToken.value.trim(),
        scope: elements.gitCredentialScope.value
      })
    });
    await refreshAfterGitManagement(management, "凭据配置已保存。Token 不会显示在页面中。");
  } catch (error) {
    setGitManagerStatus(`凭据保存失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteGitCredential(profile, button) {
  if (!window.confirm(`确定删除凭据“${profile.name}”吗？\n\n使用它的项目远端会改为自动选择其他可用凭据。`)) return;
  setBusy(button, true);
  try {
    const management = await api("/api/git/credentials", {
      method: "DELETE",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, id: profile.id })
    });
    await refreshAfterGitManagement(management, `凭据“${profile.name}”已删除。`);
  } catch (error) {
    setGitManagerStatus(`删除凭据失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

function openSetup(project, { switching = false } = {}) {
  state.setupMode = switching ? "switch" : "initial";
  document.querySelector("#setupTitle").textContent = switching ? "添加或切换论文" : "开始使用 PaperBridge";
  document.querySelector("#setupSubtitle").textContent = switching
    ? "新建项目，或打开另一个 Overleaf、Git、ZIP、本地 LaTeX 项目"
    : "新建或选择论文项目；AI 和远端连接可以稍后配置";
  document.querySelector("#setupSubmitLabel").textContent = switching ? "打开论文" : "进入 PaperBridge";
  document.querySelector("#closeSetupButton").classList.toggle("hidden", !switching);
  document.querySelector("#setupStorageSection").classList.toggle("hidden", switching);
  document.querySelector("#setupAiSection").classList.toggle("hidden", switching);
  document.querySelector("#setupTestButton").classList.toggle("hidden", switching);
  document.querySelector("#setupSourceStep").textContent = switching ? "1" : "2";
  document.querySelector("#setupTypesetStep").textContent = switching ? "2" : "4";
  document.querySelector("#setupStorageRoot").value = project.config?.storageRoot
    || project.config?.suggestedStorageRoot
    || "";
  document.querySelector("#setupProjectUrl").value = "";
  document.querySelector("#setupProjectName").value = "";
  document.querySelector("#setupGitUrl").value = "";
  document.querySelector("#setupZipPath").value = "";
  document.querySelector("#setupLocalPath").value = "";
  document.querySelector("#setupLinkedGitUrl").value = "";
  document.querySelector("#setupConnectGit").checked = false;
  const tokenInput = document.querySelector("#setupOverleafToken");
  tokenInput.value = "";
  tokenInput.placeholder = project.config?.hasOverleafToken ? "已保存，留空继续使用" : "";
  for (const prefix of ["setupGit", "setupLinkedGit"]) {
    document.querySelector(`#${prefix}Username`).value = project.config?.gitUsername || "";
    const gitToken = document.querySelector(`#${prefix}Token`);
    gitToken.value = "";
    gitToken.placeholder = project.config?.hasGitToken ? "已保存，留空继续使用" : "公开仓库可以留空";
  }
  renderRecentProjects(project);
  setSetupMessage();
  const compiler = project.dependencies?.compiler;
  elements.dependencyStatus.textContent = compiler === "latexmk"
    ? "排版：本机 LaTeX"
    : compiler === "tectonic"
      ? "排版：内置 Tectonic"
      : "排版组件不可用";
  elements.dependencyStatus.className = `dependency-status ${compiler === "missing" ? "error" : "ready"}`;
  updateSetupSource();
  updateSetupProviderDefaults();
  if (!elements.setupDialog.open) elements.setupDialog.showModal();
}

async function chooseDesktopPath(kind, input) {
  const bridge = window.paperBridgeDesktop;
  if (!bridge) {
    input.readOnly = false;
    input.focus();
    setSetupMessage("请直接输入完整路径。", "");
    return;
  }
  const selected = kind === "zip" ? await bridge.chooseZip() : await bridge.chooseFolder();
  if (selected) input.value = selected;
}

async function chooseStoragePath(input) {
  const bridge = window.paperBridgeDesktop;
  if (!bridge?.chooseDataFolder) {
    input.readOnly = false;
    input.focus();
    setSetupMessage("请直接输入完整路径。", "");
    return false;
  }
  const selected = await bridge.chooseDataFolder(input.value);
  if (selected) input.value = selected;
  return Boolean(selected);
}

async function testSetupProvider() {
  const button = document.querySelector("#setupTestButton");
  setBusy(button, true);
  setSetupMessage("正在连接 AI 接口...");
  try {
    const result = await api("/api/provider/test-inline", {
      method: "POST",
      body: JSON.stringify({ profile: setupProviderProfile() })
    });
    setSetupMessage(result.ok ? "AI 接口连接成功。" : `接口已响应：${result.response}`, result.ok ? "success" : "error");
  } catch (error) {
    setSetupMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function chooseMainTex(candidates, current) {
  elements.mainTexSelect.replaceChildren();
  for (const file of candidates) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    elements.mainTexSelect.append(option);
  }
  elements.mainTexSelect.value = candidates.includes(current) ? current : candidates[0];
  elements.mainTexDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.mainTexResolver = resolve;
  });
}

function finishMainTexSelection() {
  const resolve = state.mainTexResolver;
  state.mainTexResolver = null;
  elements.mainTexDialog.close();
  resolve?.(elements.mainTexSelect.value);
}

async function submitSetup(event) {
  event.preventDefault();
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return;
    state.sourceDirty = false;
  }
  const button = document.querySelector("#setupSubmitButton");
  const mode = document.querySelector('input[name="setupSource"]:checked').value;
  const translation = setupProviderProfile();
  const source = {
    mode,
    name: document.querySelector("#setupProjectName").value.trim(),
    projectUrl: document.querySelector("#setupProjectUrl").value.trim(),
    token: document.querySelector("#setupOverleafToken").value.trim(),
    zipPath: document.querySelector("#setupZipPath").value.trim(),
    localPath: document.querySelector("#setupLocalPath").value.trim(),
    connectGit: ["zip", "local"].includes(mode) && document.querySelector("#setupConnectGit").checked,
    gitUrl: mode === "git"
      ? document.querySelector("#setupGitUrl").value.trim()
      : document.querySelector("#setupLinkedGitUrl").value.trim(),
    gitUsername: mode === "git"
      ? document.querySelector("#setupGitUsername").value.trim()
      : document.querySelector("#setupLinkedGitUsername").value.trim(),
    gitToken: mode === "git"
      ? document.querySelector("#setupGitToken").value.trim()
      : document.querySelector("#setupLinkedGitToken").value.trim()
  };
  setBusy(button, true);
  setSetupMessage(mode === "new"
    ? "正在创建空白项目..."
    : mode === "overleaf"
      ? "正在从 Overleaf 获取论文..."
      : mode === "git"
        ? "正在克隆 Git 仓库..."
        : source.connectGit
          ? "正在导入论文并连接 Git 仓库..."
          : "正在导入论文...");
  try {
    if (mode === "zip" && !source.zipPath) {
      throw new Error("请选择 ZIP 文件，或在桌面版中选择本地 ZIP 路径。");
    }
    state.project = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        source,
        storageRoot: state.setupMode === "initial"
          ? document.querySelector("#setupStorageRoot").value.trim()
          : "",
        preserveProviders: state.setupMode === "switch",
        translation,
        diagnosis: { ...translation }
      })
    });
    elements.setupDialog.close();
    const mainTexCandidates = state.project.mainTexCandidates || [];
    if (mainTexCandidates.length > 1) {
      const mainTex = await chooseMainTex(mainTexCandidates, state.project.config.mainTex);
      if (mainTex !== state.project.config.mainTex) {
        state.project = await api("/api/project/open", {
          method: "POST",
          body: JSON.stringify({ projectRoot: state.project.config.projectRoot, mainTex })
        });
      }
    }
    updateProjectHeader();
    renderDocumentList();
    updateWarnings([]);
    if (state.project.documents.length) await loadDocument(state.project.documents[0].file);
    await compileOpenedProject();
    toast("项目已打开。", "success");
  } catch (error) {
    setSetupMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function resizePdfPages() {
  elements.pdfScroll.querySelectorAll(".pdf-source-highlight").forEach((node) => node.remove());
  const scale = state.pdfZoom / 100;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    const cssWidth = Number(canvas.dataset.baseWidth) * scale;
    const cssHeight = Number(canvas.dataset.baseHeight) * scale;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const shell = canvas.closest(".pdf-page-shell");
    if (shell) {
      shell.style.width = `${cssWidth}px`;
      shell.style.height = `${cssHeight}px`;
    }
    const textLayer = state.pdfTextLayers.get(canvas);
    if (textLayer?.task && canvas._pdfPage) {
      const baseViewport = canvas._pdfPage.getViewport({ scale: 1 });
      textLayer.task.update({
        viewport: canvas._pdfPage.getViewport({ scale: cssWidth / baseViewport.width })
      });
      textLayer.zoom = state.pdfZoom;
    }
  });
}

function pdfOutputScale(cssWidth, cssHeight) {
  const preferred = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
  const maxPixels = 12_000_000;
  const pixels = cssWidth * cssHeight * preferred * preferred;
  return pixels > maxPixels ? preferred * Math.sqrt(maxPixels / pixels) : preferred;
}

async function renderPdfCanvas(canvas) {
  const pdf = state.pdfDocument;
  const documentToken = state.pdfRenderToken;
  if (!pdf || !canvas.isConnected) return;
  const zoom = state.pdfZoom;
  const canvasReady = canvas.dataset.rendered === "true" && Number(canvas.dataset.renderZoom) === zoom;
  const existingTextLayer = state.pdfTextLayers.get(canvas);
  if (canvasReady && existingTextLayer?.ready && existingTextLayer.zoom === zoom) return;
  const version = String(Number(canvas.dataset.renderVersion || 0) + 1);
  canvas.dataset.renderVersion = version;
  if (!canvasReady) {
    const previousTask = state.pdfPageRenderTasks.get(canvas);
    if (previousTask) {
      previousTask.cancel();
      await previousTask.promise.catch(() => {});
    }
  }
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version) return;
  const page = await pdf.getPage(Number(canvas.dataset.page));
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version) return;
  canvas._pdfPage = page;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssWidth = Number(canvas.dataset.baseWidth) * zoom / 100;
  const cssHeight = Number(canvas.dataset.baseHeight) * zoom / 100;
  const textLayerPromise = renderPdfTextLayer(canvas, page, baseViewport, cssWidth, documentToken, version);
  if (canvasReady) {
    await textLayerPromise;
    return;
  }
  const outputScale = pdfOutputScale(cssWidth, cssHeight);
  const viewport = page.getViewport({ scale: (cssWidth / baseViewport.width) * outputScale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
  state.pdfPageRenderTasks.set(canvas, task);
  try {
    await Promise.all([task.promise, textLayerPromise]);
    if (documentToken === state.pdfRenderToken && canvas.dataset.renderVersion === version) {
      canvas.dataset.rendered = "true";
      canvas.dataset.renderZoom = String(zoom);
      canvas.dataset.outputScale = outputScale.toFixed(2);
    }
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
  } finally {
    if (state.pdfPageRenderTasks.get(canvas) === task) state.pdfPageRenderTasks.delete(canvas);
  }
}

async function renderPdfTextLayer(canvas, page, baseViewport, cssWidth, documentToken, version) {
  const viewport = page.getViewport({ scale: cssWidth / baseViewport.width });
  const existing = state.pdfTextLayers.get(canvas);
  if (existing) {
    existing.task.update({ viewport });
    existing.zoom = state.pdfZoom;
    return existing.renderPromise;
  }
  const textContent = await page.getTextContent();
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version || !canvas.isConnected) return;
  const container = canvas.closest(".pdf-page-shell")?.querySelector(".pdf-text-layer");
  if (!container) return;
  const task = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
  const entry = { task, ready: false, zoom: state.pdfZoom, renderPromise: null };
  state.pdfTextLayers.set(canvas, entry);
  entry.renderPromise = task.render().then(() => {
    task.textDivs.forEach((textDiv, index) => {
      textDiv.dataset.pdfTextIndex = String(index);
    });
    entry.ready = true;
    container.dataset.ready = "true";
  }).catch((error) => {
    if (error?.name !== "AbortException") throw error;
  });
  return entry.renderPromise;
}

function renderVisiblePdfPages() {
  const scrollRect = elements.pdfScroll.getBoundingClientRect();
  const margin = 700;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.bottom >= scrollRect.top - margin && rect.top <= scrollRect.bottom + margin) {
      void renderPdfCanvas(canvas).catch((error) => toast(`PDF 页面渲染失败：${error.message}`, "error"));
    }
  });
}

function capturePdfViewportAnchor(clientX = null, clientY = null) {
  const scroll = elements.pdfScroll;
  const scrollRect = scroll.getBoundingClientRect();
  const fixedPoint = Number.isFinite(clientX) && Number.isFinite(clientY);
  const targetX = fixedPoint ? clientX : scrollRect.left + scroll.clientWidth / 2;
  const targetY = fixedPoint ? clientY : scrollRect.top + scroll.clientHeight / 2;
  const pages = [...scroll.querySelectorAll(".pdf-page")];
  let page = pages.find((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom;
  });
  if (!page && pages.length) {
    page = pages.reduce((closest, canvas) => {
      const rect = canvas.getBoundingClientRect();
      const distance = Math.abs(targetY - Math.min(Math.max(targetY, rect.top), rect.bottom));
      return !closest || distance < closest.distance ? { canvas, distance } : closest;
    }, null)?.canvas;
  }
  if (page) {
    const rect = page.getBoundingClientRect();
    return {
      page,
      ratioX: Math.min(1, Math.max(0, (targetX - rect.left) / Math.max(rect.width, 1))),
      ratioY: Math.min(1, Math.max(0, (targetY - rect.top) / Math.max(rect.height, 1))),
      clientX: targetX,
      clientY: targetY,
      fixedPoint
    };
  }
  return {
    centerX: (scroll.scrollLeft + scroll.clientWidth / 2) / Math.max(scroll.scrollWidth, 1),
    centerY: (scroll.scrollTop + scroll.clientHeight / 2) / Math.max(scroll.scrollHeight, 1),
    clientX: targetX,
    clientY: targetY,
    fixedPoint
  };
}

function restorePdfViewportAnchor(anchor) {
  if (!anchor) return;
  const scroll = elements.pdfScroll;
  const scrollRect = scroll.getBoundingClientRect();
  const targetX = anchor.fixedPoint ? anchor.clientX : scrollRect.left + scroll.clientWidth / 2;
  const targetY = anchor.fixedPoint ? anchor.clientY : scrollRect.top + scroll.clientHeight / 2;
  if (anchor.page?.isConnected) {
    const rect = anchor.page.getBoundingClientRect();
    const contentX = rect.left + anchor.ratioX * rect.width;
    const contentY = rect.top + anchor.ratioY * rect.height;
    scroll.scrollLeft += contentX - targetX;
    scroll.scrollTop += contentY - targetY;
    return;
  }
  scroll.scrollLeft = anchor.centerX * scroll.scrollWidth - scroll.clientWidth / 2;
  scroll.scrollTop = anchor.centerY * scroll.scrollHeight - scroll.clientHeight / 2;
}

function schedulePdfRerender(delay = 160) {
  window.clearTimeout(state.pdfRenderTimer);
  state.pdfRenderTimer = window.setTimeout(() => {
    state.pdfRenderTimer = 0;
    renderVisiblePdfPages();
  }, delay);
}

function fitPdfPagesToPanel(anchor = capturePdfViewportAnchor()) {
  const availableWidth = Math.max(280, elements.pdfScroll.clientWidth - 26);
  let changed = false;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    const currentWidth = Number(canvas.dataset.baseWidth);
    if (Math.abs(currentWidth - availableWidth) < 1) return;
    const aspectRatio = Number(canvas.dataset.pageAspect) || Number(canvas.dataset.baseHeight) / Math.max(currentWidth, 1);
    canvas.dataset.baseWidth = String(Math.floor(availableWidth));
    canvas.dataset.baseHeight = String(Math.floor(availableWidth * aspectRatio));
    canvas.dataset.rendered = "false";
    changed = true;
  });
  if (!changed) return;
  resizePdfPages();
  restorePdfViewportAnchor(anchor);
  schedulePdfRerender();
}

function schedulePdfPanelResize(anchor = capturePdfViewportAnchor()) {
  state.pendingPdfResizeAnchor = anchor;
  window.cancelAnimationFrame(state.pdfResizeFrame);
  state.pdfResizeFrame = window.requestAnimationFrame(() => {
    state.pdfResizeFrame = 0;
    const pendingAnchor = state.pendingPdfResizeAnchor;
    state.pendingPdfResizeAnchor = null;
    if (state.mode === "edit" && state.translationExpanded) return;
    fitPdfPagesToPanel(pendingAnchor);
  });
}

function setPdfZoom(nextZoom, { persist = true, preserveViewport = true, anchor = null } = {}) {
  const viewportAnchor = preserveViewport
    ? capturePdfViewportAnchor(anchor?.clientX ?? null, anchor?.clientY ?? null)
    : null;
  state.pdfZoom = Math.min(300, Math.max(50, Math.round(nextZoom)));
  elements.pdfZoomValue.textContent = `${state.pdfZoom}%`;
  elements.zoomOutButton.disabled = state.pdfZoom <= 50;
  elements.zoomInButton.disabled = state.pdfZoom >= 300;
  resizePdfPages();
  if (persist) localStorage.setItem("paperBridge.pdfZoom", String(state.pdfZoom));
  restorePdfViewportAnchor(viewportAnchor);
  schedulePdfRerender();
}

function zoomPdfWithWheel(event) {
  if (state.previewMode !== "pdf" || !event.ctrlKey) return;
  event.preventDefault();
  if (!state.pdfDocument) return;
  const deltaPixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? elements.pdfScroll.clientHeight : 1);
  if (!deltaPixels) return;
  const step = Math.max(1, Math.min(12, Math.abs(deltaPixels) / 20));
  const direction = deltaPixels < 0 ? 1 : -1;
  setPdfZoom(state.pdfZoom + direction * step, {
    anchor: { clientX: event.clientX, clientY: event.clientY }
  });
}

function beginPdfPan(event) {
  if (event.button !== 0 || !event.target.closest(".pdf-page-shell")) return;
  if (event.target.closest(".pdf-text-layer span")) return;
  state.pdfPan = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    scrollLeft: elements.pdfScroll.scrollLeft,
    scrollTop: elements.pdfScroll.scrollTop
  };
  elements.pdfScroll.setPointerCapture(event.pointerId);
  elements.pdfScroll.classList.add("panning");
  event.preventDefault();
}

function movePdfPan(event) {
  if (!state.pdfPan || state.pdfPan.pointerId !== event.pointerId) return;
  elements.pdfScroll.scrollLeft = state.pdfPan.scrollLeft - (event.clientX - state.pdfPan.clientX);
  elements.pdfScroll.scrollTop = state.pdfPan.scrollTop - (event.clientY - state.pdfPan.clientY);
  event.preventDefault();
}

function endPdfPan(event) {
  if (!state.pdfPan || state.pdfPan.pointerId !== event.pointerId) return;
  state.pdfPan = null;
  elements.pdfScroll.classList.remove("panning");
  if (elements.pdfScroll.hasPointerCapture(event.pointerId)) elements.pdfScroll.releasePointerCapture(event.pointerId);
}

function invalidatePdfNavigationIndex() {
  state.pdfNavigationToken += 1;
  state.pdfParagraphIndex = null;
  state.pdfParagraphIndexPromise = null;
  state.pdfCaptionIndex = null;
  state.pdfCaptionIndexPromise = null;
  state.pdfSourceIndex = null;
  state.pdfSourceIndexPromise = null;
}

function normalizePdfNavigationText(value, { latex = false } = {}) {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/[ﬁﬂﬀﬃﬄ]/g, (ligature) => ({ ﬁ: "fi", ﬂ: "fl", ﬀ: "ff", ﬃ: "ffi", ﬄ: "ffl" })[ligature])
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
  if (latex) {
    text = text
      .replace(/(^|[^\\])%.*$/gm, "$1 ")
      .replace(/\$\$[\s\S]*?\$\$/g, " MATH ")
      .replace(/\$[^$]*\$/g, " MATH ")
      .replace(/\\(?:begin|end)\s*\{[^{}]+\}/g, " ")
      .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label|url)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ")
      .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
      .replace(/\\([%&#_$])/g, "$1")
      .replace(/[{}~]/g, " ");
  }
  return text
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function navigationTokens(value, options) {
  const normalized = normalizePdfNavigationText(value, options);
  const tokens = normalized ? normalized.split(" ") : [];
  return { normalized, tokens, tokenSet: new Set(tokens) };
}

function longestCommonTokenRun(left, right) {
  if (!left.length || !right.length) return 0;
  let previous = new Uint16Array(right.length + 1);
  let longest = 0;
  for (const token of left) {
    const current = new Uint16Array(right.length + 1);
    for (let index = 0; index < right.length; index += 1) {
      if (token === right[index]) {
        current[index + 1] = previous[index] + 1;
        longest = Math.max(longest, current[index + 1]);
      }
    }
    previous = current;
  }
  return longest;
}

function scoreNavigationText(query, candidate, selectedNormalized = "") {
  const run = longestCommonTokenRun(query.tokens, candidate.tokens);
  const querySet = query.tokenSet || new Set(query.tokens);
  const candidateSet = candidate.tokenSet || new Set(candidate.tokens);
  let overlap = 0;
  for (const token of querySet) if (candidateSet.has(token)) overlap += 1;
  const selectedExact = selectedNormalized.length >= 4 && candidate.normalized.includes(selectedNormalized);
  return {
    run,
    overlap,
    selectedExact,
    score: run * 4 + overlap + (selectedExact ? 5 : 0)
  };
}

function shortTokenRunInText(tokens, normalizedText) {
  if (!tokens?.length || !normalizedText) return 0;
  const maxRun = Math.min(8, tokens.length);
  for (let size = maxRun; size >= 3; size -= 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      if (normalizedText.includes(tokens.slice(index, index + size).join(" "))) return size;
    }
  }
  return 0;
}

function pdfPageRatio(page, pageCount) {
  const normalizedPage = Number(page);
  const normalizedPageCount = Number(pageCount);
  if (!Number.isFinite(normalizedPage) || !Number.isFinite(normalizedPageCount) || normalizedPageCount <= 1) return null;
  return Math.min(1, Math.max(0, (normalizedPage - 1) / (normalizedPageCount - 1)));
}

function candidatePositionRatio(candidate) {
  const explicit = Number(candidate.positionRatio);
  if (Number.isFinite(explicit)) return Math.min(1, Math.max(0, explicit));
  return null;
}

function scoreNavigationPageEvidence(candidate, pageTokens) {
  if (!pageTokens?.tokens?.length) {
    return { pageRun: 0, pageOverlap: 0, pageOverlapRatio: 0, pageBoost: 0, pagePenalty: 0 };
  }
  const pageSet = pageTokens.tokenSet || new Set(pageTokens.tokens);
  const candidateSet = candidate.tokenSet || new Set(candidate.tokens);
  let pageOverlap = 0;
  for (const token of candidateSet) if (pageSet.has(token)) pageOverlap += 1;
  const denominator = Math.max(1, Math.min(candidateSet.size, 24));
  const pageRun = pageOverlap >= 3 ? shortTokenRunInText(candidate.tokens, pageTokens.normalized) : 0;
  const pageOverlapRatio = pageOverlap / denominator;
  const pageBoost = Math.min(24, pageRun * 2 + Math.min(10, pageOverlap) + (pageOverlapRatio >= 0.42 ? 8 : 0));
  const pagePenalty = pageTokens.tokens.length >= 24 && pageRun < 3 && pageOverlap < 4 ? 16 : 0;
  return {
    pageRun,
    pageOverlap,
    pageOverlapRatio,
    pageBoost,
    pagePenalty
  };
}

function scoreNavigationPosition(candidate, { page = 0, pageCount = 0 } = {}) {
  const pagePosition = pdfPageRatio(page, pageCount);
  const sourcePosition = candidatePositionRatio(candidate);
  if (pagePosition === null || sourcePosition === null) return { positionDistance: null, positionBoost: 0, positionPenalty: 0 };
  const distance = Math.abs(pagePosition - sourcePosition);
  let positionBoost = distance <= 0.16 ? 8 : 0;
  let positionPenalty = distance <= 0.22 ? 0 : Math.round((distance - 0.22) * 46);
  if (Number(page) <= 2 && sourcePosition >= 0.58) positionPenalty += 18;
  if (Number(page) >= Number(pageCount) - 1 && sourcePosition <= 0.42) positionPenalty += 18;
  return { positionDistance: distance, positionBoost, positionPenalty };
}

function findBestNavigationMatch(queryText, selectedText, candidates, { source = false, caption = false, page = 0, pageCount = 0, pageText = "" } = {}) {
  const query = navigationTokens(queryText);
  const selectedNormalized = normalizePdfNavigationText(selectedText);
  const pageTokens = navigationTokens(pageText);
  if (query.tokens.length < 2) return null;
  let best = null;
  let runnerUp = null;
  for (const candidate of candidates) {
    const metrics = scoreNavigationText(query, candidate, selectedNormalized);
    const pageEvidence = scoreNavigationPageEvidence(candidate, pageTokens);
    const position = scoreNavigationPosition(candidate, { page, pageCount });
    const result = {
      ...candidate,
      ...metrics,
      ...pageEvidence,
      ...position,
      baseScore: metrics.score,
      score: metrics.score + pageEvidence.pageBoost + position.positionBoost - pageEvidence.pagePenalty - position.positionPenalty
    };
    if (!best || result.score > best.score) {
      runnerUp = best;
      best = result;
    } else if (!runnerUp || result.score > runnerUp.score) {
      runnerUp = result;
    }
  }
  if (!best) return null;
  const querySize = new Set(query.tokens).size;
  const overlapRatio = best.overlap / Math.max(1, Math.min(querySize, 12));
  const captionReliable = caption && (
    (best.selectedExact && best.overlap >= Math.min(3, querySize))
    || best.run >= 3
    || (best.run >= 2 && best.overlap >= 4)
  );
  const reliable = captionReliable
    || best.run >= (source ? 4 : 5)
    || (best.run >= 3 && best.overlap >= 5 && overlapRatio >= 0.45)
    || (best.pageRun >= 5 && best.pageOverlap >= 6 && best.run >= 2)
    || (best.selectedExact && best.run >= 3);
  if (!reliable) return null;
  const competingLocation = !source
    || (runnerUp && (runnerUp.file !== best.file || Math.abs((runnerUp.line || 0) - (best.line || 0)) > 10));
  if (!caption && best.run < 6 && runnerUp && competingLocation && best.score - runnerUp.score < 2) return null;
  return best;
}

async function getPdfParagraphIndex() {
  if (state.pdfParagraphIndex) return state.pdfParagraphIndex;
  if (state.pdfParagraphIndexPromise) return state.pdfParagraphIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.documents || []).map((item) => item.file);
  const promise = Promise.all(files.map((file) => api(`/api/document?file=${encodeURIComponent(file)}`)))
    .then((documents) => {
      if (token !== state.pdfNavigationToken) return [];
      const entries = documents.flatMap((documentPayload) => documentPayload.segments.map((segment) => ({
        file: documentPayload.file,
        index: segment.index,
        id: segment.id,
        startLine: segment.startLine,
        endLine: segment.endLine,
        sectionIndex: segment.sectionIndex,
        ...navigationTokens(segment.plainText || segment.english, { latex: !segment.plainText })
      }))).filter((entry) => entry.tokens.length);
      const denominator = Math.max(1, entries.length - 1);
      state.pdfParagraphIndex = entries.map((entry, index) => ({
        ...entry,
        positionRatio: entries.length <= 1 ? 0 : index / denominator
      }));
      return state.pdfParagraphIndex;
    })
    .finally(() => {
      if (state.pdfParagraphIndexPromise === promise) state.pdfParagraphIndexPromise = null;
    });
  state.pdfParagraphIndexPromise = promise;
  return promise;
}

function skipLatexBalancedArgument(text, cursor, open, close) {
  if (text[cursor] !== open) return null;
  let depth = 0;
  for (let index = cursor; index < text.length; index += 1) {
    const char = text[index];
    const escaped = index > 0 && text[index - 1] === "\\";
    if (char === open && !escaped) depth += 1;
    else if (char === close && !escaped) {
      depth -= 1;
      if (depth === 0) return { start: cursor, end: index + 1 };
    }
  }
  return null;
}

function latexLineAtOffset(lineStarts, offset) {
  let left = 0;
  let right = lineStarts.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (lineStarts[middle] <= offset) left = middle + 1;
    else right = middle - 1;
  }
  return Math.max(1, right + 1);
}

function latexLineStarts(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function extractLatexCaptions(source) {
  const content = String(source.content || "");
  const lines = content.split(/\r?\n/);
  const lineStarts = latexLineStarts(content);
  const captions = [];
  const commandPattern = /\\caption(?![A-Za-z@])/g;
  for (const match of content.matchAll(commandPattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(content[cursor] || "")) cursor += 1;
    if (content[cursor] === "[") {
      const optional = skipLatexBalancedArgument(content, cursor, "[", "]");
      if (!optional) continue;
      cursor = optional.end;
      while (/\s/.test(content[cursor] || "")) cursor += 1;
    }
    const required = skipLatexBalancedArgument(content, cursor, "{", "}");
    if (!required) continue;
    const caption = content.slice(required.start + 1, required.end - 1);
    const line = latexLineAtOffset(lineStarts, match.index);
    const sourceStart = Math.max(0, line - 4);
    const sourceEnd = Math.min(lines.length, line + 5);
    const before = content.slice(Math.max(0, match.index - 1000), match.index);
    const beginMatches = [...before.matchAll(/\\begin\s*\{(figure\*?|table\*?)\}/g)];
    const env = beginMatches.at(-1)?.[1] || "figure";
    const after = content.slice(required.end, required.end + 700);
    const label = after.match(/\\label\s*\{([^{}]+)\}/)?.[1] || "";
    const tokens = navigationTokens(caption, { latex: true });
    if (tokens.tokens.length < 2) continue;
    captions.push({
      file: source.file,
      line,
      env,
      label,
      caption,
      sourceLines: lines.slice(sourceStart, sourceEnd).map((text, offset) => ({ line: sourceStart + offset + 1, text })),
      ...tokens
    });
  }
  return captions;
}

async function getPdfCaptionIndex() {
  if (state.pdfCaptionIndex) return state.pdfCaptionIndex;
  if (state.pdfCaptionIndexPromise) return state.pdfCaptionIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.texFiles || []).filter((file) => file.toLowerCase().endsWith(".tex"));
  const promise = Promise.all(files.map((file) => api(`/api/source?file=${encodeURIComponent(file)}`)))
    .then((sources) => {
      if (token !== state.pdfNavigationToken) return [];
      state.pdfCaptionIndex = sources.flatMap(extractLatexCaptions);
      return state.pdfCaptionIndex;
    })
    .finally(() => {
      if (state.pdfCaptionIndexPromise === promise) state.pdfCaptionIndexPromise = null;
    });
  state.pdfCaptionIndexPromise = promise;
  return promise;
}

async function getPdfSourceIndex() {
  if (state.pdfSourceIndex) return state.pdfSourceIndex;
  if (state.pdfSourceIndexPromise) return state.pdfSourceIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.texFiles || []).filter((file) => file.toLowerCase().endsWith(".tex"));
  const promise = Promise.all(files.map((file) => api(`/api/source?file=${encodeURIComponent(file)}`)))
    .then((sources) => {
      if (token !== state.pdfNavigationToken) return [];
      const entries = sources.flatMap((source) => {
        const lines = source.content.split(/\r?\n/);
        return lines.map((_line, index) => {
          const start = Math.max(0, index - 3);
          const end = Math.min(lines.length, index + 6);
          return {
            file: source.file,
            line: index + 1,
            sourceLines: lines.slice(start, end).map((text, offset) => ({ line: start + offset + 1, text })),
            ...navigationTokens(lines.slice(start, end).join("\n"), { latex: true })
          };
        });
      }).filter((entry) => entry.tokens.length);
      const denominator = Math.max(1, entries.length - 1);
      state.pdfSourceIndex = entries.map((entry, index) => ({
        ...entry,
        positionRatio: entries.length <= 1 ? 0 : index / denominator
      }));
      return state.pdfSourceIndex;
    })
    .finally(() => {
      if (state.pdfSourceIndexPromise === promise) state.pdfSourceIndexPromise = null;
    });
  state.pdfSourceIndexPromise = promise;
  return promise;
}

function extractPdfNavigationQuery(event) {
  const shell = event.target.closest(".pdf-page-shell");
  const canvas = shell?.querySelector(".pdf-page");
  const textLayer = canvas ? state.pdfTextLayers.get(canvas) : null;
  if (!shell || !textLayer?.ready) return null;
  const target = event.target.closest(".pdf-text-layer span");
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() || target?.textContent?.trim() || "";
  const indexedTarget = target?.matches("[data-pdf-text-index]")
    ? target
    : target?.querySelector("[data-pdf-text-index]");
  let index = indexedTarget ? Number(indexedTarget.dataset.pdfTextIndex) : -1;
  if (!Number.isInteger(index) || index < 0) index = target ? textLayer.task.textDivs.indexOf(target) : -1;
  if (index < 0 && selection?.anchorNode) {
    const anchorElement = selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    const anchorSpan = anchorElement?.closest?.(".pdf-text-layer [data-pdf-text-index]");
    index = anchorSpan ? Number(anchorSpan.dataset.pdfTextIndex) : -1;
  }
  if (index < 0) return null;
  const items = textLayer.task.textContentItemsStr;
  const divs = textLayer.task.textDivs;
  const page = Number(shell.dataset.page || canvas.dataset.page || 0);
  const pageCount = Number(state.pdfDocument?.numPages || state.project?.pdf?.pages || 0);
  let start = index;
  let end = index + 1;
  const sameTextBlock = (before, after) => {
    if (!before || !after) return false;
    const beforeRect = before.getBoundingClientRect();
    const afterRect = after.getBoundingClientRect();
    const gap = afterRect.top - beforeRect.bottom;
    const lineJump = afterRect.top < beforeRect.top - Math.max(beforeRect.height, afterRect.height) * 1.5;
    return !lineJump && gap <= Math.max(12, Math.max(beforeRect.height, afterRect.height) * 0.95);
  };
  while (start > 0 && index - start < 8 && sameTextBlock(divs[start - 1], divs[start])) start -= 1;
  while (end < items.length && end - index < 9 && sameTextBlock(divs[end - 1], divs[end])) end += 1;
  const context = items.slice(start, end).filter(Boolean).join(" ");
  return {
    selectedText,
    context: context || selectedText,
    page,
    pageCount,
    pageText: items.filter(Boolean).join(" ")
  };
}

function highlightLocatedSegment(file, index) {
  const row = [...elements.segmentList.querySelectorAll(".segment-row")]
    .find((candidate) => candidate.dataset.file === file && Number(candidate.dataset.segmentIndex) === index);
  if (!row) return false;
  row.classList.remove("pdf-located");
  void row.offsetWidth;
  row.classList.add("pdf-located");
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => row.classList.remove("pdf-located"), 2200);
  return true;
}

function highlightLocatedMathBlock(file, id) {
  const row = [...elements.segmentList.querySelectorAll(".math-row")]
    .find((candidate) => candidate.dataset.file === file && candidate.dataset.mathId === id);
  if (!row) return false;
  row.classList.remove("pdf-located");
  void row.offsetWidth;
  row.classList.add("pdf-located");
  row.querySelector(".math-source-editor")?.focus({ preventScroll: true });
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => row.classList.remove("pdf-located"), 2200);
  return true;
}

async function locatePdfSelection(event) {
  if (state.compileInFlight || state.buildPreviewAvailable === false) {
    toast("请等待编译成功后再定位。", "info", 3200);
    return;
  }
  // Panning captures the pointer on the scroll container, which can also become the double-click target.
  const shell = event.target.closest(".pdf-page-shell")
    || document.elementFromPoint(event.clientX, event.clientY)?.closest(".pdf-page-shell");
  const canvas = shell?.querySelector(".pdf-page");
  if (!canvas || !state.pdfDocument || state.pdfNavigationBusy) return;
  state.pdfNavigationBusy = true;
  elements.pdfScroll.dataset.navigationState = "matching";
  try {
    const pageNumber = Number(shell.dataset.page);
    const page = await state.pdfDocument.getPage(pageNumber);
    const bounds = canvas.getBoundingClientRect();
    const viewport = page.getViewport({ scale: bounds.width / page.getViewport({ scale: 1 }).width });
    const point = viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
    const location = await api("/api/synctex/inverse", {
      method: "POST",
      body: JSON.stringify({ page: pageNumber, x: point[0] - page.view[0], y: page.view[3] - point[1] })
    });
    if (state.sourceDirty && state.sourceFile === location.file) {
      toast("源码有未保存修改，请先点击“编译”更新定位信息。", "info", 4200);
      return;
    }
    const found = state.mode === "edit"
      ? await locateTranslationSource(location.file, location.line)
      : await openSourceLocation(location.file, location.line);
    if (found) {
      elements.pdfScroll.dataset.navigationState = "synctex";
    }
  } catch (error) {
    elements.pdfScroll.dataset.navigationState = "error";
    toast(error.message, "info", 4200);
  } finally {
    state.pdfNavigationBusy = false;
  }
}

async function locateSourceSelection() {
  if (!/\.tex$/i.test(state.sourceFile || "") || !state.pdfDocument || state.pdfNavigationBusy) return;
  if (state.compileInFlight || state.buildPreviewAvailable === false || state.sourceDirty) {
    toast("请先点击“编译”，再定位到最新 PDF。", "info", 3600);
    return;
  }
  state.pdfNavigationBusy = true;
  try {
    const position = sourceCursorPosition();
    const location = await api("/api/synctex/forward", {
      method: "POST",
      body: JSON.stringify({ file: state.sourceFile, line: position.line, column: position.column })
    });
    setSourceFocus(false);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await highlightSyncTeXPdf(location);
    elements.sourceEditor.dataset.navigationState = "synctex";
  } catch (error) {
    elements.sourceEditor.dataset.navigationState = "error";
    toast(error.message, "info", 4200);
  } finally {
    state.pdfNavigationBusy = false;
  }
}

async function highlightSyncTeXPdf(location) {
  const shell = elements.pdfScroll.querySelector('.pdf-page-shell[data-page="' + location.page + '"]');
  const canvas = shell?.querySelector(".pdf-page");
  if (!canvas) return;
  const page = await state.pdfDocument.getPage(location.page);
  const bounds = canvas.getBoundingClientRect();
  const viewport = page.getViewport({ scale: bounds.width / page.getViewport({ scale: 1 }).width });
  const rect = [
    ...viewport.convertToViewportPoint(page.view[0] + location.x, page.view[3] - location.y - location.height),
    ...viewport.convertToViewportPoint(page.view[0] + location.x + location.width, page.view[3] - location.y)
  ];
  const left = Math.min(rect[0], rect[2]);
  const top = Math.min(rect[1], rect[3]);
  elements.pdfScroll.querySelectorAll(".pdf-source-highlight").forEach((node) => node.remove());
  const marker = document.createElement("div");
  marker.className = "pdf-source-highlight";
  marker.style.left = left + "px";
  marker.style.top = top + "px";
  marker.style.width = Math.max(4, Math.abs(rect[2] - rect[0])) + "px";
  marker.style.height = Math.max(4, Math.abs(rect[3] - rect[1])) + "px";
  shell.append(marker);
  const scrollBounds = elements.pdfScroll.getBoundingClientRect();
  const pageBounds = shell.getBoundingClientRect();
  const pageTop = elements.pdfScroll.scrollTop + pageBounds.top - scrollBounds.top;
  elements.pdfScroll.scrollTop = Math.max(pageTop - 8, pageTop + top - elements.pdfScroll.clientHeight * 0.28);
  elements.pdfScroll.scrollLeft += pageBounds.left - scrollBounds.left + left - elements.pdfScroll.clientWidth * 0.2;
  elements.pdfScroll.dataset.navigationState = "synctex";
  window.setTimeout(() => marker.remove(), 2200);
}

async function locateTranslationBlock(row, { reveal = false } = {}) {
  if (state.mode !== "edit" || state.pdfNavigationBusy) return;
  if (!state.pdfDocument || state.compileInFlight || state.buildPreviewAvailable === false) {
    if (reveal) toast("请先编译可用的 PDF，再进行定位。", "info");
    return;
  }
  if (state.translationExpanded) {
    if (!reveal) return;
    setTranslationExpanded(false);
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  }
  if (!row.dataset.file || !Number(row.dataset.startLine)) return;
  state.pdfNavigationBusy = true;
  try {
    const location = await api("/api/synctex/forward", {
      method: "POST",
      body: JSON.stringify({ file: row.dataset.file, line: Number(row.dataset.startLine), column: 0 })
    });
    await highlightSyncTeXPdf(location);
  } catch (error) {
    if (reveal || error.payload?.code === "SYNCTEX_STALE") toast(error.message, "info", 3500);
  } finally {
    state.pdfNavigationBusy = false;
  }
}

async function locateTranslationSource(file, line) {
  if (state.currentFile !== file && !await loadDocument(file)) return false;
  const rows = [...elements.segmentList.querySelectorAll("article[data-start-line]")];
  const distance = (row) => Math.max(Number(row.dataset.startLine) - line, line - Number(row.dataset.endLine), 0);
  const row = rows.sort((left, right) => distance(left) - distance(right))[0];
  if (!row || row.dataset.file !== file) return openSourceLocation(file, line);
  elements.segmentList.querySelector(".pdf-located")?.classList.remove("pdf-located");
  row.classList.add("pdf-located");
  row.scrollIntoView({ block: "start", behavior: "instant" });
  window.setTimeout(() => row.classList.remove("pdf-located"), 2200);
  return true;
}

async function locateFastPreviewSelection(event) {
  const block = event.target.closest(".fast-preview-block");
  if (!block) return;
  const file = block.dataset.sourceFile
    || state.fastPreviewFile
    || state.currentDocument?.file
    || state.project?.config?.mainTex
    || "";
  const line = Number(block.dataset.sourceLine || 0);
  if (!file || !line) return;
  block.classList.remove("source-highlight");
  void block.offsetWidth;
  block.classList.add("source-highlight");
  window.setTimeout(() => block.classList.remove("source-highlight"), 2400);
  try {
    let documentPayload = state.currentDocument?.file === file ? state.currentDocument : null;
    if (!documentPayload && state.project?.documents?.some((item) => item.file === file)) {
      documentPayload = await api(`/api/document?file=${encodeURIComponent(file)}`);
    }
    const segment = documentPayload?.segments?.find((candidate) => (
      line >= Number(candidate.startLine || 0) && line <= Number(candidate.endLine || 0)
    ));
    if (segment) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== file) await loadDocument(file);
      if (highlightLocatedSegment(file, segment.index)) {
        toast("已定位到对应的中英文段落。", "success", 2600);
        return;
      }
    }
    const mathBlock = documentPayload?.mathBlocks?.find((candidate) => (
      line >= Number(candidate.startLine || 0) && line <= Number(candidate.endLine || 0)
    ));
    if (mathBlock) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== file) await loadDocument(file);
      if (highlightLocatedMathBlock(file, mathBlock.id)) {
        toast("已定位到对应公式 TeX。", "success", 2600);
        return;
      }
    }
    if (await openSourceLocation(file, line)) {
      toast("未找到对应翻译段落，已定位到 TeX 源码。", "success", 3200);
    }
  } catch (error) {
    toast(`快速预览定位失败：${error.message}`, "error", 5200);
  }
}

async function api(url, options = {}) {
  const trackedWrite = UNDO_TRACKED_URLS.has(url) && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
  let writeSucceeded = false;
  if (trackedWrite) {
    state.pendingWrites += 1;
    if (state.mode === "edit") updateHeaderSaveState("saving");
  }
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed: ${response.status}`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    if (["/api/project/open", "/api/setup"].includes(url)) {
      state.compileOnOpenPending = true;
      state.projectTreeInitialized = false;
    }
    writeSucceeded = true;
    return payload;
  } finally {
    if (trackedWrite) {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      if (state.mode === "edit" && !state.pendingWrites) {
        updateHeaderSaveState(!writeSucceeded ? "error" : state.saveTimers.size ? "dirty" : "saved");
      }
      if (writeSucceeded) reviewCenter?.invalidate();
      void refreshUndoStatus();
    }
  }
}

function applyUndoStatus(status = {}) {
  state.undoCount = Math.max(0, Number(status.count || 0));
  state.undoLabel = String(status.nextLabel || "");
  if (state.project) state.project.undo = { ...status, count: state.undoCount, nextLabel: state.undoLabel };
  elements.undoButton.disabled = state.undoCount === 0;
  elements.undoButton.title = state.undoCount
    ? `撤销：${state.undoLabel || "上一步操作"}（Ctrl+Z，${state.undoCount}/10）`
    : "没有可撤销的操作（Ctrl+Z）";
  elements.undoCount.textContent = String(state.undoCount);
  elements.undoCount.classList.toggle("hidden", state.undoCount === 0);
}

async function refreshUndoStatus() {
  try {
    const response = await fetch("/api/undo/status");
    if (!response.ok) return null;
    const status = await response.json();
    applyUndoStatus(status);
    return status;
  } catch {
    // The next project refresh will restore the status if the local server is restarting.
    return null;
  }
}

function toast(message, type = "success", timeout = 3600) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  window.setTimeout(() => node.remove(), timeout);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  const icon = button.querySelector("[data-lucide], svg");
  if (busy && icon) {
    button.dataset.previousIcon = icon.getAttribute("data-lucide") || button.dataset.previousIcon || "circle";
    icon.setAttribute("data-lucide", "loader-circle");
  } else if (icon && button.dataset.previousIcon) {
    icon.setAttribute("data-lucide", button.dataset.previousIcon);
  }
  refreshIcons();
}

function confirmUnexpectedLatexCommands(error) {
  if (error.payload?.code !== "UNEXPECTED_LATEX_COMMANDS") return false;
  const commands = error.payload.details?.unexpectedCommands || [];
  return window.confirm([
    "AI 输出新增了原文中没有的 LaTeX 命令：",
    "",
    ...commands,
    "",
    "这些命令不是已知危险命令，但可能改变排版或文件结构。确认写入吗？"
  ].join("\n"));
}

function dangerousLatexMessage(error) {
  const commands = error.payload?.details?.dangerousCommands || [];
  return commands.length
    ? `已阻止危险 LaTeX 命令：${commands.join(", ")}`
    : error.message;
}

function translationFailureMessage(error) {
  const details = error.payload?.details || {};
  if (Array.isArray(details.issues) && details.issues.length) {
    return `${error.message}\n${details.issues.slice(0, 4).join("\n")}`;
  }
  const missing = details.missingTokens;
  if (missing?.length) return `模型丢失 LaTeX 标记：${missing.join(", ")}`;
  return error.message;
}

function fileLabel(file) {
  return file
    .replace(/\.tex$/i, "")
    .replace(/^\d+_/, "")
    .replaceAll("_", " ");
}

function statusLabel(status) {
  if (status === "synced") return "已翻译";
  if (status === "pending" || status === "english-changed") return "需重译";
  return "未翻译";
}

function updateTopbarCurrentFile(file = "") {
  if (!elements.topCurrentFile) return;
  elements.topCurrentFile.textContent = file || state.sourceFile || state.currentFile || state.project?.config?.mainTex || "未选择文件";
  elements.topCurrentFile.title = elements.topCurrentFile.textContent;
}

function updateHeaderSaveState(status = "saved") {
  if (!elements.headerSaveState) return;
  const normalized = ["saving", "dirty", "error"].includes(status) ? status : "saved";
  if (elements.headerSaveState.dataset.status === normalized) return;
  elements.headerSaveState.dataset.status = normalized;
  elements.headerSaveState.className = `header-save-state ${normalized}`;
  const icon = elements.headerSaveState.querySelector("[data-lucide], svg");
  const label = elements.headerSaveState.querySelector("span");
  if (icon) icon.setAttribute("data-lucide", normalized === "error" ? "circle-alert" : normalized === "saved" ? "circle-check" : "circle-dot");
  if (label) label.textContent = normalized === "saving" ? "保存中" : normalized === "dirty" ? "等待保存" : normalized === "error" ? "保存失败" : "已保存";
  refreshIcons();
}

function updateProjectHeader() {
  const config = state.project.config;
  applyUndoStatus(state.project.undo || {});
  elements.projectName.textContent = projectDisplayTitle(config);
  elements.projectName.title = [config.projectRoot, config.mainTex].filter(Boolean).join("\n");
  elements.openProjectFolderButton.disabled = !config.projectRoot;
  updateTopbarCurrentFile((state.mode === "edit" ? state.currentFile : state.sourceFile) || config.mainTex);
  document.querySelector("#terminologyBadge").textContent = state.project.terminologyCount || 0;
  document.querySelector("#terminologyBadge").classList.toggle("hidden", !state.project.terminologyCount);
  updateTranslationBuildLabel();
  const git = state.project.git;
  const remotes = Array.isArray(git.remotes) ? git.remotes : [];
  state.gitRemoteName = git.remoteName || "";
  const hasRemote = Boolean(git.remoteName);
  const remoteLabel = git.remoteLabel || (git.overleaf ? "Overleaf" : "Git 远端");
  const remoteTargetLabel = git.remoteRepository ? `${remoteLabel} · ${git.remoteRepository}` : remoteLabel;
  elements.gitRemoteSelect.replaceChildren(...remotes.map((remote) => {
    const option = document.createElement("option");
    option.value = remote.name;
    option.textContent = remote.repository ? `${remote.label} · ${remote.repository}` : remote.label;
    option.selected = remote.name === git.remoteName;
    return option;
  }));
  elements.gitRemoteTarget.classList.toggle("hidden", !hasRemote);
  elements.gitRemoteSelect.disabled = remotes.length < 2;
  elements.gitRemoteTarget.title = remotes.length > 1
    ? "选择本次拉取和推送的目标仓库"
    : `当前同步目标：${remoteTargetLabel}`;
  const pullButton = document.querySelector("#pullButton");
  const pushButton = document.querySelector("#pushButton");
  pullButton.disabled = !hasRemote;
  pushButton.disabled = !hasRemote;
  pullButton.querySelector("span").textContent = "拉取";
  pushButton.querySelector("span").textContent = hasRemote ? `同步至 ${remoteLabel}` : "同步";
  pullButton.title = hasRemote ? `从 ${remoteTargetLabel} 拉取最新版本` : "当前项目没有连接 Git 远端仓库";
  pushButton.title = hasRemote ? `提交并推送至 ${remoteTargetLabel}` : "当前项目没有连接 Git 远端仓库";
  elements.syncState.className = `sync-state ${git.available ? (git.dirty ? "dirty" : "clean") : "error"}`;
  let syncText = "未连接 Git";
  if (git.available && !hasRemote) syncText = "本地 Git，未连接远端";
  else if (git.dirty) syncText = `${git.changedFiles.length} 个文件待提交`;
  else if (git.behind) syncText = `${remoteLabel} 有 ${git.behind} 次更新`;
  else if (git.ahead) syncText = `${git.ahead} 次提交待推送`;
  else if (hasRemote) syncText = `已与 ${remoteLabel} 对齐`;
  elements.syncState.querySelector("span:last-child").textContent = syncText;
  renderSidebarProjectList(state.project);
}

async function undoLastChange() {
  if (elements.undoButton.disabled) return false;
  if (state.sourceDirty) {
    toast("TeX 源码还有未保存修改，请先按 Ctrl+S 保存或在编辑器内撤销。", "warning", 5200);
    return false;
  }
  setBusy(elements.undoButton, true);
  try {
    const currentFile = state.mode === "source" ? state.sourceFile : state.currentFile;
    const result = await api("/api/undo", {
      method: "POST",
      body: JSON.stringify({ refreshProject: false, file: currentFile })
    });
    applyUndoStatus(result.history || {});
    if (!result.changed) {
      toast("没有可撤销的操作。", "warning", 2800);
      return false;
    }
    for (const file of result.changedFiles || []) state.sourceSearchContents.delete(file);
    if (result.document) {
      state.currentDocument = result.document;
      state.currentFile = result.document.file;
      if (state.mode === "edit") renderSegments();
    }
    if (result.source && result.source.file === state.sourceFile && !state.sourceDirty) {
      const editor = elements.sourceEditor;
      const { selectionStart, selectionEnd, scrollTop, scrollLeft } = editor;
      state.sourceHash = result.source.sourceHash;
      state.sourceEol = result.source.eol || "\n";
      editor.value = result.source.content;
      state.sourceSavedContent = editor.value;
      editor.setSelectionRange(selectionStart, selectionEnd);
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;
      setSourceDirty(false);
      scheduleSourceEditorRefresh();
    }
    if (result.filesChanged) await refreshProject({ preserveDocument: false });
    invalidatePdfNavigationIndex();
    invalidateReferences();
    reviewCenter?.invalidate();
    toast(`已撤销：${result.label || "上一步操作"}。`, "success", 3600);
    return true;
  } catch (error) {
    toast(`撤销失败：${error.message}`, "error", 5600);
    return false;
  } finally {
    setBusy(elements.undoButton, false);
    applyUndoStatus(state.project?.undo || { count: state.undoCount, nextLabel: state.undoLabel });
  }
}

function shouldUseNativeTextUndo(target) {
  // Autosave must not switch an editor's Ctrl+Z to project-wide file restoration.
  return Boolean(target?.closest("textarea, input, select, [contenteditable='true']"));
}

async function waitForPendingSaves(timeoutMs = 70_000) {
  const started = Date.now();
  while (
    state.saveTimers.size
    || state.pendingWrites
    || state.fileTranslationJobs.size
    || state.segmentTranslationQueue.length
    || state.activeSegmentTranslations
  ) {
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return true;
}

async function handleDesktopCloseRequest(save) {
  if (!await refreshUndoStatus()) {
    return { ok: false, message: "无法确认论文的保存状态，请稍后再退出。" };
  }
  const backgroundJobs = state.fileTranslationJobs.size > 0
    || state.segmentTranslationQueue.length > 0
    || state.activeSegmentTranslations > 0;
  const dirty = state.sourceDirty
    || state.terminologyDirty
    || state.saveTimers.size > 0
    || state.pendingWrites > 0
    || backgroundJobs
    || state.undoCount > 0;
  if (!save) return { ok: true, dirty, undoCount: state.undoCount };
  if (state.sourceDirty && !await saveSourceFile({ quiet: true, refreshPreview: false })) {
    return { ok: false, message: "TeX 源码保存失败，窗口没有关闭。" };
  }
  if (state.terminologyDirty && !await saveTerminology({ quiet: true })) {
    return { ok: false, message: "术语表保存失败，窗口没有关闭。" };
  }
  if (!await waitForPendingSaves()) {
    return { ok: false, message: "仍有翻译或保存任务未完成，请稍后再退出。" };
  }
  try {
    const status = await api("/api/undo/commit", { method: "POST", body: "{}" });
    applyUndoStatus(status);
    return { ok: true, dirty: false, undoCount: 0 };
  } catch (error) {
    return { ok: false, message: `无法确认保存状态：${error.message}` };
  }
}

function updateTranslationProgress() {
  const documents = state.project.documents;
  const total = documents.reduce((sum, item) => sum + item.segments, 0);
  const translated = documents.reduce((sum, item) => sum + item.translated, 0);
  const percent = total ? Math.round((translated / total) * 100) : 0;
  elements.translationProgressCount.textContent = `已翻译 ${translated}/${total} 段 · `;
  elements.translationProgressPercent.textContent = `${percent}%`;
  elements.translationProgress.title = elements.translationProgress.textContent;
  elements.translationProgressBar.style.width = `${percent}%`;
}

function setFileTranslationProgress(completed, total, label, status = "") {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  elements.fileTranslationProgress.classList.remove("hidden", "warning", "error");
  if (status) elements.fileTranslationProgress.classList.add(status);
  elements.fileTranslationProgressLabel.textContent = label;
  elements.fileTranslationProgressCount.textContent = `${completed} / ${total}`;
  elements.fileTranslationProgressBar.style.width = `${percent}%`;
  elements.fileTranslationProgressTrack.setAttribute("aria-valuenow", String(percent));
}

function hideFileTranslationProgress() {
  elements.fileTranslationProgress.classList.add("hidden");
  elements.fileTranslationProgress.classList.remove("warning", "error");
  elements.fileTranslationProgressBar.style.width = "0%";
  elements.fileTranslationProgressTrack.setAttribute("aria-valuenow", "0");
}

function updateTranslateFileButton() {
  updateTranslationDirection();
}

function renderFileTranslationProgress(preferredFile = state.visibleTranslationJobFile || state.currentFile) {
  let job = preferredFile ? state.fileTranslationJobs.get(preferredFile) : null;
  if (!job && state.currentFile) job = state.fileTranslationJobs.get(state.currentFile);
  if (!job) job = [...state.fileTranslationJobs.values()][0] || null;
  if (!job && state.lastFileTranslationProgress?.file === preferredFile) job = state.lastFileTranslationProgress;
  if (!job) {
    hideFileTranslationProgress();
    updateTranslateFileButton();
    return;
  }
  state.visibleTranslationJobFile = job.file;
  setFileTranslationProgress(job.completed, job.total, job.label, job.statusClass || "");
  updateTranslateFileButton();
}

function finishFileTranslationJob(file, updates = {}) {
  const job = state.fileTranslationJobs.get(file);
  if (!job) return;
  Object.assign(job, updates);
  state.lastFileTranslationProgress = { ...job };
  state.fileTranslationJobs.delete(file);
  renderFileTranslationProgress(file);
  window.setTimeout(() => {
    if (
      state.lastFileTranslationProgress?.file === file
      && !state.fileTranslationJobs.has(file)
      && state.visibleTranslationJobFile === file
    ) {
      state.lastFileTranslationProgress = null;
      renderFileTranslationProgress();
    }
  }, 7000);
}

function normalizeTerminologyEntry(entry = {}) {
  return {
    chinese: String(entry.chinese || "").trim(),
    english: String(entry.english || entry.en || entry.term || "").trim(),
    fullName: String(entry.fullName || entry.full || entry.definition || "").trim(),
    keepEnglish: entry.keepEnglish === true,
    note: String(entry.note || "").trim(),
    frequency: Math.max(0, Number(entry.frequency || 0) || 0),
    firstOccurrence: Math.max(0, Number(entry.firstOccurrence || 0) || 0),
    needsFullName: entry.needsFullName === true
  };
}

function terminologyMatchesSearch(entry, query) {
  if (!query) return true;
  return [entry.chinese, entry.english, entry.fullName, entry.note]
    .some((value) => String(value || "").toLowerCase().includes(query));
}

function setTerminologyStatus(message = "", tone = "") {
  elements.terminologyStatus.textContent = message;
  elements.terminologyStatus.className = `terminology-status ${tone}`.trim();
}

function setTerminologyDirty(dirty = true) {
  state.terminologyDirty = dirty;
  setTerminologyStatus(dirty ? "有未保存的术语修改" : "术语表已保存", dirty ? "dirty" : "saved");
}

function updateTerminologyMeta(payload = null) {
  const count = state.terminologyEntries.length;
  document.querySelector("#terminologyBadge").textContent = String(count);
  document.querySelector("#terminologyBadge").classList.toggle("hidden", !count);
  if (state.project) state.project.terminologyCount = count;
  const file = state.terminologyFile || state.currentFile;
  const scope = payload?.scope === "project" ? "全文术语表" : file ? fileLabel(file) : "全文术语表";
  const source = payload?.manual ? "手动维护" : payload?.ruleBased ? "规则提取" : payload?.cached ? "已缓存" : "全文";
  elements.terminologyMeta.textContent = `${scope} · ${count} 条 · ${source}`;
}

function renderTerminologyEntries() {
  const query = elements.terminologySearch.value.trim().toLowerCase();
  elements.terminologyList.replaceChildren();
  let visible = 0;
  state.terminologyEntries.forEach((entry, index) => {
    if (!terminologyMatchesSearch(entry, query)) return;
    visible += 1;
    const row = document.createElement("div");
    row.className = "terminology-row";
    if (entry.needsFullName && !entry.fullName) row.classList.add("needs-full-name");
    row.dataset.index = String(index);

    const makeTextField = (field, labelText, placeholder = "") => {
      const label = document.createElement("label");
      const span = document.createElement("span");
      const input = document.createElement("input");
      span.textContent = labelText;
      input.type = "text";
      input.value = entry[field] || "";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        state.terminologyEntries[index][field] = input.value;
        if (field === "fullName" && input.value.trim()) state.terminologyEntries[index].needsFullName = false;
        setTerminologyDirty(true);
        updateTerminologyMeta();
      });
      label.append(span, input);
      return label;
    };

    const keepLabel = document.createElement("label");
    keepLabel.className = "terminology-keep";
    const keepInput = document.createElement("input");
    keepInput.type = "checkbox";
    keepInput.checked = entry.keepEnglish === true;
    keepInput.addEventListener("change", () => {
      state.terminologyEntries[index].keepEnglish = keepInput.checked;
      setTerminologyDirty(true);
    });
    const keepText = document.createElement("span");
    keepText.textContent = "中文稿保留英文";
    keepLabel.append(keepInput, keepText);

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button small";
    deleteButton.type = "button";
    deleteButton.title = "删除术语";
    deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
    deleteButton.addEventListener("click", () => {
      state.terminologyEntries.splice(index, 1);
      setTerminologyDirty(true);
      updateTerminologyMeta();
      renderTerminologyEntries();
    });

    row.append(
      makeTextField("chinese", "中文", "信标"),
      makeTextField("english", "缩写/英文", "ADR"),
      makeTextField("fullName", "全称", entry.needsFullName ? "请补全缩写全称" : "Adaptive Data Rate"),
      makeTextField("note", "备注", entry.frequency ? `出现 ${entry.frequency} 次` : "可选"),
      keepLabel,
      deleteButton
    );
    elements.terminologyList.append(row);
  });

  elements.terminologyEmpty.textContent = state.terminologyEntries.length
    ? "没有匹配的术语。"
    : "暂无术语。可以手动新增，或从论文中的缩写定义和术语表格提取。";
  elements.terminologyEmpty.classList.toggle("hidden", visible > 0);
  refreshIcons();
}

async function openTerminologyDialog() {
  const terminologyFile = state.currentFile || state.project?.config?.mainTex || "";
  if (!terminologyFile) {
    toast("请先打开论文项目。", "error");
    return;
  }
  state.terminologyFile = terminologyFile;
  state.terminologyEntries = [];
  state.terminologyDirty = false;
  elements.terminologySearch.value = "";
  updateTerminologyMeta();
  renderTerminologyEntries();
  setTerminologyStatus("正在读取全文术语表...");
  elements.terminologyDialog.showModal();
  try {
    const payload = await api(`/api/file/terminology?file=${encodeURIComponent(state.terminologyFile)}`);
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus(payload.cached ? "已读取全文术语表" : "全文还没有术语表", payload.cached ? "saved" : "");
  } catch (error) {
    setTerminologyStatus("术语表读取失败", "dirty");
    toast(error.message, "error", 5200);
  }
}

function closeTerminologyDialog() {
  if (state.terminologyDirty && !window.confirm("术语表有未保存修改，确定关闭吗？")) return;
  elements.terminologyDialog.close();
}

function addTerminologyEntry() {
  if (state.terminologyEntries.length >= MAX_TERMINOLOGY_ENTRIES) {
    toast(`术语表最多保存 ${MAX_TERMINOLOGY_ENTRIES} 条。`, "error");
    return;
  }
  state.terminologyEntries.push({ chinese: "", english: "", fullName: "", keepEnglish: false, note: "" });
  elements.terminologySearch.value = "";
  setTerminologyDirty(true);
  updateTerminologyMeta();
  renderTerminologyEntries();
  elements.terminologyList.querySelector(".terminology-row:last-child input")?.focus();
}

function collectTerminologyEntries() {
  const entries = state.terminologyEntries
    .map(normalizeTerminologyEntry)
    .filter((entry) => entry.chinese || entry.english || entry.note);
  if (entries.length > MAX_TERMINOLOGY_ENTRIES) {
    throw new Error(`术语表最多保存 ${MAX_TERMINOLOGY_ENTRIES} 条，请先删除一些术语。`);
  }
  if (entries.some((entry) => !entry.english)) {
    throw new Error("每条术语都需要填写英文写法。");
  }
  return entries;
}

async function saveTerminology(options = {}) {
  if (!state.terminologyFile) return true;
  const quiet = options.quiet === true;
  let entries;
  try {
    entries = collectTerminologyEntries();
  } catch (error) {
    if (!quiet) toast(error.message, "error", 5200);
    return false;
  }
  setBusy(elements.saveTerminologyButton, true);
  setTerminologyStatus("正在保存术语表...");
  try {
    const payload = await api("/api/file/terminology", {
      method: "PUT",
      body: JSON.stringify({ file: state.terminologyFile, entries })
    });
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus("术语表已保存，后续翻译会优先使用它", "saved");
    if (!quiet) toast("术语表已保存。", "success");
    return true;
  } catch (error) {
    setTerminologyStatus("术语表保存失败", "dirty");
    if (!quiet) toast(error.message, "error", 5200);
    return false;
  } finally {
    setBusy(elements.saveTerminologyButton, false);
  }
}

async function regenerateTerminology() {
  if (!state.terminologyFile) return;
  if (state.terminologyDirty && !window.confirm("重新提取会覆盖当前未保存的术语修改，继续吗？")) return;
  if (!state.terminologyDirty && state.terminologyEntries.length && !window.confirm("重新提取会覆盖当前术语表，继续吗？")) return;
  setBusy(elements.regenerateTerminologyButton, true);
  setTerminologyStatus("正在从全文提取术语表...");
  try {
    const payload = await api("/api/file/terminology", {
      method: "POST",
      body: JSON.stringify({ file: state.terminologyFile, force: true })
    });
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus(`已提取 ${state.terminologyEntries.length} 条术语`, "saved");
    toast(`已从全文提取 ${state.terminologyEntries.length} 条术语。`, "success");
  } catch (error) {
    setTerminologyStatus("术语表提取失败", "dirty");
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.regenerateTerminologyButton, false);
  }
}

async function applyTerminologyDefinitions() {
  if (!state.terminologyFile) return;
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  let entries;
  try {
    entries = collectTerminologyEntries();
  } catch (error) {
    toast(error.message, "error", 5200);
    return;
  }
  const expandable = entries.filter((entry) => entry.english && entry.fullName);
  if (!expandable.length) {
    toast("请先为至少一个缩写填写全称。", "error", 4200);
    return;
  }
  if (!window.confirm("将按全文顺序，把已填写全称的缩写写入第一次出现的位置，格式为“全称（缩写）”。继续吗？")) return;
  setBusy(elements.applyTerminologyDefinitionsButton, true);
  setTerminologyStatus("正在写入全文首次出现位置...");
  try {
    const result = await api("/api/file/terminology/apply", {
      method: "POST",
      body: JSON.stringify({ file: state.terminologyFile, entries })
    });
    state.terminologyEntries = (result.terminology?.entries || entries).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(result.terminology);
    renderTerminologyEntries();
    if (result.source?.file && state.sourceFile === result.source.file) {
      state.sourceHash = result.source.sourceHash;
      state.sourceEol = result.source.eol || state.sourceEol;
      elements.sourceEditor.value = result.source.content;
      state.sourceSavedContent = elements.sourceEditor.value;
      setSourceDirty(false);
      updateSourceLineNumbers();
      refreshSourceSearch();
    }
    if (result.document && result.document.file === state.currentFile) {
      state.currentDocument = result.document;
      renderSegments();
    }
    const applied = result.applied?.length || 0;
    const skipped = result.skipped?.length || 0;
    setTerminologyStatus(`已写入 ${applied} 个缩写${skipped ? `，跳过 ${skipped} 个` : ""}`, "saved");
    toast(applied ? `已把 ${applied} 个缩写写入首次出现位置。` : "没有需要写入的缩写。", applied ? "success" : "error", 5200);
  } catch (error) {
    setTerminologyStatus("写入首次出现位置失败", "dirty");
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.applyTerminologyDefinitionsButton, false);
  }
}


function referenceProjectKey() {
  return state.project?.config?.projectRoot || "";
}

function invalidateReferences() {
  referenceWorkbench?.invalidate();
}

function loadReferences(options) {
  return referenceWorkbench?.load(options);
}

async function prepareReferenceWrite() {
  const start = Date.now();
  while (state.sourceSaveInFlight || state.pendingWrites || state.saveTimers.size) {
    if (Date.now() - start > 6500) throw new Error("编辑区有保存任务正在进行，请稍后重试。");
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  if (state.sourceDirty && !await saveSourceFile({ quiet: true, refreshPreview: false })) {
    throw new Error("请先保存当前源码，再修改参考文献。");
  }
}

async function applyReferenceWrite(result) {
  if (result.project) {
    state.project = result.project;
    updateProjectHeader();
    renderDocumentList();
    renderSourceFileOptions(state.sourceFile);
  }
  const files = result.changedFiles || (result.file ? [result.file, state.project?.config?.mainTex] : []);
  for (const file of files) state.sourceSearchContents.delete(file);
  if (files.includes(state.sourceFile)) {
    const caret = [elements.sourceEditor.selectionStart, elements.sourceEditor.selectionEnd, elements.sourceEditor.selectionDirection];
    const scrollTop = elements.sourceEditor.scrollTop;
    if (await refreshLoadedSourceFromDisk(state.sourceFile)) {
      elements.sourceEditor.setSelectionRange(...caret);
      elements.sourceEditor.scrollTop = scrollTop;
      syncSourceEditorLayers();
    }
  }
  if (state.mode === "edit" && result.changedFiles?.includes(state.currentFile) && /\.tex$/i.test(state.currentFile || "")) {
    const target = state.citationTarget;
    const original = target?.element.closest(".segment-row");
    const selector = target?.element.matches(".segment-reading") ? ".segment-reading" : "textarea.segment-textarea";
    const language = target?.element.classList.contains("english") ? "english" : "chinese";
    await loadDocument(state.currentFile);
    if (original && target === state.citationTarget && !target.element.isConnected) {
      const row = [...elements.segmentList.querySelectorAll(".segment-row")].find((candidate) =>
        candidate.dataset.file === original.dataset.file && candidate.dataset.startLine === original.dataset.startLine
      );
      const editor = row?.querySelector(selector + "." + language);
      if (editor?.value === target.element.value) state.citationTarget = { ...target, element: editor };
    }
  }
  if (files.length) invalidatePdfNavigationIndex();
}

function isCitationEditor(textarea) {
  if (!textarea?.isConnected) return false;
  if (textarea === elements.sourceEditor) return state.mode === "source" && /\.tex$/i.test(state.sourceFile || "");
  return state.mode === "edit" && textarea.matches("textarea.segment-textarea, .segment-reading");
}

function bindReferences() {
  referenceWorkbench = mountReferenceWorkbench({
    api, project: referenceProjectKey,
    bibTargets: () => (state.project?.projectFiles || []).filter((item) => item.extension === ".bib").map((item) => item.path),
    showWorkbench: () => { if (!state.referencesOpen) setReferencesOpen(true); },
    insert: insertCitationAtCurrentTarget,
    hasCitationTarget: () => Boolean(citationTargetElement()),
    gotoCitation: ({ file, line, paragraph }) => state.mode === "edit" && paragraph ? locateTranslationSource(file, line) : openSourceLocation(file, line, { keepReferences: true }),
    gotoSource: ({ file, startLine }) => openSourceLocation(file, startLine, { keepReferences: true }),
    beforeWrite: prepareReferenceWrite,
    afterWrite: applyReferenceWrite,
    notify: toast, icons: refreshIcons, dragType: CITATION_DRAG_TYPE
  });
  citationTools = createCitationTools({
    references: referenceWorkbench, canCite: isCitationEditor, offsetFromPoint: textareaCaretOffsetFromPoint
  });
}

function rememberCitationTarget(textarea) {
  if (!isCitationEditor(textarea) || typeof textarea.selectionStart !== "number") return;
  state.citationTarget = {
    element: textarea,
    file: textarea === elements.sourceEditor ? state.sourceFile : textarea.closest(".segment-row")?.dataset.file,
    start: textarea.selectionStart,
    end: textarea.selectionEnd
  };
}

function citationTargetElement() {
  const active = document.activeElement;
  if (isCitationEditor(active)) {
    rememberCitationTarget(active);
    return active;
  }
  const target = state.citationTarget;
  if (isCitationEditor(target?.element) && (target.element !== elements.sourceEditor || target.file === state.sourceFile)) return target.element;
  return null;
}

function textareaCaretOffsetFromPoint(textarea, clientX, clientY) {
  const value = textarea.value;
  if (!value) return 0;
  const style = window.getComputedStyle(textarea);
  const bounds = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  const copiedProperties = [
    "font-family", "font-size", "font-style", "font-weight", "font-variant",
    "letter-spacing", "line-height", "text-align", "text-indent", "text-transform",
    "direction", "tab-size", "padding", "border", "box-sizing", "overflow-wrap", "word-break"
  ];
  for (const property of copiedProperties) mirror.style.setProperty(property, style.getPropertyValue(property));
  const horizontalBorder = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
  mirror.style.position = "fixed";
  mirror.style.left = "0";
  mirror.style.top = "0";
  mirror.style.width = `${textarea.clientWidth + horizontalBorder}px`;
  mirror.style.height = "auto";
  mirror.style.minHeight = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "visible";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.textContent = `${value}\u200b`;
  document.body.append(mirror);

  try {
    const textNode = mirror.firstChild;
    const range = document.createRange();
    const caretRect = (offset) => {
      range.setStart(textNode, Math.min(offset, value.length));
      range.collapse(true);
      return range.getBoundingClientRect();
    };
    const mirrorBounds = mirror.getBoundingClientRect();
    const targetX = mirrorBounds.left + clientX - bounds.left + textarea.scrollLeft;
    const targetY = mirrorBounds.top + clientY - bounds.top + textarea.scrollTop;

    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (caretRect(middle).top <= targetY) low = middle;
      else high = middle - 1;
    }
    const lineTop = caretRect(low).top;
    let lineStart = 0;
    let lineEnd = low;
    high = low;
    while (lineStart < high) {
      const middle = Math.floor((lineStart + high) / 2);
      if (caretRect(middle).top < lineTop - 0.5) lineStart = middle + 1;
      else high = middle;
    }
    high = value.length;
    while (lineEnd < high) {
      const middle = Math.ceil((lineEnd + high) / 2);
      if (caretRect(middle).top <= lineTop + 0.5) lineEnd = middle;
      else high = middle - 1;
    }

    let closest = lineStart;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let offset = lineStart; offset <= lineEnd; offset += 1) {
      const distance = Math.abs(caretRect(offset).left - targetX);
      if (distance >= closestDistance) continue;
      closest = offset;
      closestDistance = distance;
    }
    return closest;
  } finally {
    mirror.remove();
  }
}

function insertCitationIntoTarget(target, key, start, end = start) {
  const insertionPoint = Math.min(target.value.length, Math.max(start, end));
  target.activateCitationEditor?.();
  const before = target.value.slice(0, insertionPoint);
  const glue = before && !/[\s~([{]$/.test(before) ? "~" : "";
  const citation = `${glue}\\cite{${key}}`;
  target.setRangeText(citation, insertionPoint, insertionPoint, "end");
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus();
  rememberCitationTarget(target);
  toast(`已插入 \\cite{${key}}。`, "success");
}

function insertCitationAtCurrentTarget(entry) {
  const target = citationTargetElement();
  if (!target) {
    toast("请先在中文、英文段落或 TeX 源码里点一下要插入引用的位置。", "error", 5600);
    return false;
  }
  const start = Number.isFinite(state.citationTarget?.start) ? state.citationTarget.start : target.selectionStart || 0;
  const end = Number.isFinite(state.citationTarget?.end) ? state.citationTarget.end : target.selectionEnd || start;
  insertCitationIntoTarget(target, entry.key, start, end);
  return true;
}

function closeReferenceInsertDialog() {
  if (elements.referenceInsertDialog?.open) elements.referenceInsertDialog.close();
}

async function openReferenceInsertDialog() {
  closeCitationContextMenu();
  if (!await loadReferences({ render: false })) return;
  elements.referenceInsertSearch.value = elements.referencesSearch?.value || "";
  elements.referenceInsertMeta.textContent = state.citationTarget?.element?.classList.contains("source-editor")
    ? "将插入到 TeX 源码当前光标处"
    : "将插入到当前段落光标处；如果选中了一个词，会插在这个词后面";
  referenceWorkbench.renderInsert();
  if (!elements.referenceInsertDialog.open) elements.referenceInsertDialog.showModal();
  window.requestAnimationFrame(() => elements.referenceInsertSearch.focus());
}

function closeCitationContextMenu() {
  document.querySelector(".citation-context-menu")?.remove();
}

function openCitationContextMenu(event, textarea) {
  rememberCitationTarget(textarea);
  event.preventDefault();
  closeCitationContextMenu();
  const menu = document.createElement("div");
  menu.className = "citation-context-menu";
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 100)}px`;
  const appendAction = (icon, label, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
    button.addEventListener("click", () => {
      closeCitationContextMenu();
      void action(button);
    });
    menu.append(button);
  };
  appendAction("quote", "插入文献", () => openReferenceInsertDialog());
  const segmentRow = textarea.closest(".segment-row");
  const hasSelection = textarea.selectionEnd > textarea.selectionStart;
  if (textarea.classList.contains("source-editor") && hasSelection) {
    appendAction("message-square-plus", "添加批注", () => reviewCenter?.newNote(reviewSelectionAt(textarea)));
  }
  if (segmentRow?.commentParagraphAction && hasSelection) {
    appendAction("percent", "注释选中内容", (button) => segmentRow.commentParagraphAction(button));
  }
  menu.addEventListener("pointerdown", (innerEvent) => innerEvent.stopPropagation());
  document.body.append(menu);
  refreshIcons();
  window.setTimeout(() => {
    document.addEventListener("pointerdown", closeCitationContextMenu, { once: true });
    document.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Escape") closeCitationContextMenu();
    }, { once: true });
  }, 0);
}

function attachCitationTarget(textarea) {
  if (!textarea) return;
  citationTools.bindEditor(textarea);
  for (const eventName of ["focus", "click", "keyup", "select"]) {
    textarea.addEventListener(eventName, () => rememberCitationTarget(textarea));
  }
  textarea.addEventListener("contextmenu", (event) => openCitationContextMenu(event, textarea));
  textarea.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes(CITATION_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    textarea.classList.add("citation-drop-target");
  });
  textarea.addEventListener("dragleave", () => textarea.classList.remove("citation-drop-target"));
  textarea.addEventListener("drop", (event) => {
    const key = event.dataTransfer?.getData(CITATION_DRAG_TYPE);
    if (!key) return;
    event.preventDefault();
    textarea.classList.remove("citation-drop-target");
    const offset = textarea.latexOffsetFromPoint?.(event.clientX, event.clientY)
      ?? textareaCaretOffsetFromPoint(textarea, event.clientX, event.clientY);
    insertCitationIntoTarget(textarea, key, offset);
  });
}

const PROJECT_PREVIEW_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".gif", ".webp", ".bmp", ".tif", ".tiff"
]);

function projectFileIcon(entry) {
  if (entry.type === "directory") return "folder";
  if (PROJECT_PREVIEW_EXTENSIONS.has(String(entry.extension || "").toLowerCase())) return "image";
  if (String(entry.extension || "").toLowerCase() === ".bib") return "book-open";
  return "file-text";
}

const AUXILIARY_FILES_GROUP = "\0auxiliary-files";

function isAuxiliaryProjectFile(entry) {
  const file = String(entry.path || "");
  return /(?:^|[\\/])\.(?:output|tmp)(?:[\\/]|$)/i.test(file)
    || (entry.type !== "directory" && /\.(?:aux|bbl|bcf|blg|brf|fdb_latexmk|fls|lof|lot|log|nav|out|output|run\.xml|snm|synctex(?:\.gz)?|tmp|toc|vrb|xdv|dvi|idx|ilg|ind|glg|glo|gls|acn|acr|alg|spl)$/i.test(file));
}

function showSourceEditor() {
  elements.sourceEditorShell?.classList.remove("hidden");
  elements.projectFilePreview?.classList.add("hidden");
}

async function openProjectFile(file) {
  const relative = String(file || "").replaceAll("\\", "/");
  if (!relative) return;
  if (/\.(?:tex|bib|md|markdown)$/i.test(relative) && state.project?.sourceFiles?.includes(relative)) {
    showSourceEditor();
    if (state.mode !== "source" && !setMode("source", { loadCurrent: false })) return;
    renderSourceFileOptions(relative);
    await loadSourceFile(relative);
    return;
  }
  if (state.sourceDirty && !confirmDiscardSourceChanges()) return;
  if (state.mode !== "source" && !setMode("source", { loadCurrent: false })) return;
  const entry = (state.project?.projectFiles || []).find((candidate) => candidate.path === relative);
  if (!entry) return;
  const extension = String(entry.extension || "").toLowerCase();
  elements.sourceEditorShell?.classList.add("hidden");
  elements.projectFilePreview?.classList.remove("hidden");
  elements.projectFilePreviewTitle.textContent = relative;
  elements.projectFilePreviewMeta.textContent = entry.previewable ? "项目文件预览" : "文件预览不可用，可在资源管理器中打开";
  elements.projectFilePreviewBody.replaceChildren();
  const url = `/api/project/file?path=${encodeURIComponent(relative)}`;
  if (extension === ".pdf") {
    const frame = document.createElement("iframe");
    frame.src = `${url}#toolbar=0&navpanes=0`;
    frame.title = relative;
    elements.projectFilePreviewBody.append(frame);
  } else if (PROJECT_PREVIEW_EXTENSIONS.has(extension)) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = relative;
    image.loading = "lazy";
    elements.projectFilePreviewBody.append(image);
  } else {
    const note = document.createElement("div");
    note.className = "project-file-preview-note";
    note.textContent = extension === ".bib"
      ? "在主 TeX 中声明此 Bib 文件后，可在源码视图中编辑。"
      : "此文件没有内置预览，可使用文件栏上方的文件夹按钮查看。";
    elements.projectFilePreviewBody.append(note);
  }
  renderSectionList();
  updateTopbarCurrentFile(relative);
  updateModeButtons();
}

function renderDocumentList() {
  const entries = Array.isArray(state.project?.projectFiles) ? state.project.projectFiles : [];
  const auxiliaryEntries = entries.filter((entry) => entry.type !== "directory" && isAuxiliaryProjectFile(entry));
  const documents = state.project.documents || [];
  const documentByFile = new Map(documents.map((item) => [item.file, item]));
  elements.documentCount.textContent = String(entries.length);
  elements.documentList.replaceChildren();
  if (!state.projectTreeInitialized) {
    state.expandedProjectFolders.clear();
    state.projectTreeInitialized = true;
  }
  const nodes = new Map([["", { path: "", type: "directory", children: [] }]]);
  const ensureDirectory = (directory) => {
    if (!nodes.has(directory)) nodes.set(directory, { path: directory, type: "directory", children: [] });
    return nodes.get(directory);
  };
  for (const entry of entries) {
    if (isAuxiliaryProjectFile(entry)) continue;
    const file = String(entry.path || "").replaceAll("\\\\", "/");
    const parts = file.split("/");
    const parent = ensureDirectory(parts.slice(0, -1).join("/"));
    const node = { ...entry, path: file, name: parts.at(-1), children: [] };
    parent.children.push(node);
    if (entry.type === "directory") ensureDirectory(file);
  }
  for (const node of nodes.values()) {
    node.children.sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }
  if (auxiliaryEntries.length) {
    const auxiliaryGroup = {
      path: AUXILIARY_FILES_GROUP,
      type: "directory",
      name: "辅助文件",
      children: auxiliaryEntries.map((entry) => ({ ...entry, name: entry.path, children: [] }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
    };
    nodes.set(AUXILIARY_FILES_GROUP, auxiliaryGroup);
    nodes.get("").children.push(auxiliaryGroup);
  }
  const renderTree = (parent, depth) => {
    for (const entry of parent.children) {
      const file = entry.path;
      const item = documentByFile.get(file);
      const button = document.createElement("button");
      const isFolder = entry.type === "directory";
      const expanded = isFolder && state.expandedProjectFolders.has(file);
      button.className = `document-button ${isFolder ? "folder" : "file"} ${file === state.currentFile || (state.mode === "source" && file === state.sourceFile) ? "active" : ""}`;
      button.type = "button";
      button.style.paddingLeft = `${8 + depth * 15}px`;
      button.innerHTML = `
        <i data-lucide="${isFolder ? (expanded ? "chevron-down" : "chevron-right") : projectFileIcon(entry)}"></i>
        <span class="document-label"></span>
        <span class="document-progress"></span>
      `;
      button.querySelector(".document-label").textContent = entry.name;
      button.querySelector(".document-progress").textContent = "";
      button.title = file === AUXILIARY_FILES_GROUP ? "辅助文件" : file || state.project?.config?.projectRoot || "";
      if (isFolder) {
        button.setAttribute("aria-expanded", String(expanded));
        button.addEventListener("click", () => {
          if (state.expandedProjectFolders.has(file)) state.expandedProjectFolders.delete(file);
          else state.expandedProjectFolders.add(file);
          renderDocumentList();
        });
      } else {
        button.addEventListener("click", async () => {
          if (item && state.mode === "edit") {
            await loadDocument(file);
            return;
          }
          await openProjectFile(file);
          renderDocumentList();
        });
      }
      elements.documentList.append(button);
      if (isFolder && expanded) renderTree(nodes.get(file) || entry, depth + 1);
    }
  };
  const root = nodes.get("");
  root.name = projectDisplayTitle(state.project?.config || {});
  renderTree({ children: [root] }, 0);
  updateTranslationProgress();
  refreshIcons();
}

function sourceHeadingEntries(file, content) {
  const normalizedFile = String(file || "").replaceAll("\\", "/");
  const lines = String(content || "").split(/\r?\n/);
  const attachDocumentTargets = (entries) => entries.map((entry) => {
    const segment = state.currentDocument?.file === normalizedFile
      ? state.currentDocument.segments.find((candidate) => (
        Array.isArray(candidate.headingPath) && candidate.headingPath.some((heading) => (
          (heading.id || `${normalizedFile}:heading:${heading.line}`) === entry.id
        ))
      ))
      : null;
    return {
      ...entry,
      segmentId: segment?.id || "",
      sectionId: segment?.sectionId || ""
    };
  });
  if (/\.(?:md|markdown)$/i.test(normalizedFile)) {
    let fenced = false;
    const fence = String.fromCharCode(96).repeat(3);
    return attachDocumentTargets(lines.flatMap((line, index) => {
      if (/^\s*(?:~~~)/.test(line) || line.includes(fence)) {
        fenced = !fenced;
        return [];
      }
      if (fenced) return [];
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!match) return [];
      return [{
        id: `${normalizedFile}:heading:${index + 1}`,
        file: normalizedFile,
        line: index + 1,
        level: match[1].length,
        title: match[2].trim()
      }];
    }));
  }
  return attachDocumentTargets(lines.flatMap((line, index) => {
    const uncommented = line.replace(/(^|[^\\])%.*$/, "$1");
    const match = uncommented.match(/^\s*\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/);
    if (!match) return [];
    return [{
      id: `${normalizedFile}:heading:${index + 1}`,
      file: normalizedFile,
      line: index + 1,
      level: ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"].indexOf(match[1]) + 1,
      title: match[2].trim()
    }];
  }));
}

function documentHeadingEntries(documentPayload) {
  const entries = [];
  const seen = new Set();
  for (const segment of documentPayload?.segments || []) {
    const path = Array.isArray(segment.headingPath) ? segment.headingPath : [];
    for (const heading of path) {
      const id = heading.id || `${documentPayload.file}:heading:${heading.line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        file: documentPayload.file,
        line: heading.line,
        level: heading.level,
        title: heading.title,
        segmentId: segment.id,
        sectionId: segment.sectionId
      });
    }
  }
  return entries.sort((left, right) => Number(left.line || 0) - Number(right.line || 0));
}

function updateOutlineSelection(line) {
  const buttons = [...elements.sectionList.querySelectorAll(".section-item[data-line]")];
  if (!buttons.length) return;
  let current = line;
  if (!current && state.mode === "source") current = sourceCursorPosition().line;
  if (!current && state.mode === "edit") {
    const limit = elements.segmentList.getBoundingClientRect().top + 48;
    const headings = [...elements.segmentList.querySelectorAll(".segment-heading[data-start-line]")];
    current = Number(headings.findLast((heading) => heading.getBoundingClientRect().top <= limit)?.dataset.startLine) || 1;
  }
  const active = buttons.findLast((button) => Number(button.dataset.line) <= current);
  if (state.mode === "edit" && active?.dataset.sectionId && state.currentSectionId !== active.dataset.sectionId) {
    state.currentSectionId = active.dataset.sectionId;
    updateTranslateSectionButton();
  }
  for (const button of buttons) {
    if (button === active) button.setAttribute("aria-current", "location");
    else button.removeAttribute("aria-current");
  }
}

function activeReviewSource() {
  if (state.mode === "source" && /\.tex$/i.test(state.sourceFile || "")
    && elements.projectFilePreview.classList.contains("hidden")) return reviewSelectionAt(elements.sourceEditor);
  const focused = document.activeElement?.closest(".segment-row");
  if (focused && state.mode === "edit") return reviewSelectionAt(focused);
  const remembered = state.reviewSelection;
  return remembered && (!remembered.file || remembered.file === state.currentFile) ? remembered : null;
}

function reviewSelectionAt(target) {
  if (target === elements.sourceEditor) {
    if (!/\.tex$/i.test(state.sourceFile || "")) return null;
    const { selectionStart: start, selectionEnd: end, value } = target;
    return { file: state.sourceFile, line: sourceCursorPosition().line, start, end, quote: value.slice(start, end).trim().slice(0, 1000) };
  }
  const row = target?.closest(".segment-row");
  if (!row || state.mode !== "edit") return null;
  const editor = target.matches("textarea.segment-textarea") ? target : null;
  const selection = editor?.value.slice(editor.selectionStart, editor.selectionEnd)
    || (row.contains(document.getSelection()?.anchorNode) ? document.getSelection().toString() : "");
  return { file: row.dataset.file, line: Number(row.dataset.startLine), quote: selection.trim().slice(0, 1000) };
}

function reviewPdfForward(file, line) {
  return api("/api/synctex/forward", { method: "POST", body: JSON.stringify({ file, line, column: 0 }) });
}

function renderPdfReviews() {
  if (state.previewMode !== "pdf" || !state.pdfDocument) return;
  void reviewCenter?.renderPdf(elements.pdfScroll, { revision: state.reviewPdfVersion, forward: reviewPdfForward });
}

function syncReviewSourceScroll() {
  for (const mark of elements.reviewSourceGutter.children) {
    mark.style.transform = "translateY(" + (-elements.sourceEditor.scrollTop) + "px)";
  }
}

function renderReviewSourceGutter() {
  const root = elements.reviewSourceGutter;
  root.replaceChildren();
  if (!reviewCenter || state.mode !== "source") return;
  const style = getComputedStyle(elements.sourceLineNumbers);
  const lineHeight = Number.parseFloat(style.lineHeight) || 19.5;
  const padding = Number.parseFloat(style.paddingTop) || 0;
  const grouped = new Map();
  for (const item of reviewCenter.all()) {
    if (item.anchor?.file !== state.sourceFile) continue;
    const group = grouped.get(item.anchor.line) || [];
    group.push(item);
    grouped.set(item.anchor.line, group);
  }
  for (const [line, items] of grouped) {
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "review-source-dot";
    mark.style.top = padding + (line - 1) * lineHeight + Math.max(0, (lineHeight - 17) / 2) + "px";
    mark.textContent = String(items.length);
    mark.title = "L" + line + " · " + items.length + " 条批注";
    mark.setAttribute("aria-label", mark.title);
    mark.addEventListener("click", () => reviewCenter.choose(items[0].id, { jump: true }));
    root.append(mark);
  }
  syncReviewSourceScroll();
}

async function locateReviewThread(item) {
  const anchor = item.anchor;
  if (anchor) {
    if (state.mode === "edit" && anchor.segmentId) await locateTranslationSource(anchor.file, anchor.line);
    else if (await openSourceLocation(anchor.file, anchor.line)) {
      if (anchor.end > anchor.start) elements.sourceEditor.setSelectionRange(anchor.start, anchor.end);
    }
  }
  if (state.mode === "edit" && state.translationExpanded) {
    setTranslationExpanded(false);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  setSourceFocus(false);
  if (!state.pdfDocument || state.previewMode !== "pdf") return;
  const samePdf = item.pdf?.version && item.pdf.version === state.reviewPdfVersion;
  if (samePdf && item.pdf.regions?.length) {
    const page = await state.pdfDocument.getPage(item.pdf.page);
    const [left, bottom, right, top] = item.pdf.regions[0];
    await highlightSyncTeXPdf({ page: item.pdf.page, x: left - page.view[0], y: page.view[3] - top, width: right - left, height: top - bottom });
  } else if (anchor) {
    const location = await reviewPdfForward(anchor.file, anchor.line).catch(() => null);
    if (location) await highlightSyncTeXPdf(location);
  }
}

function bindReview() {
  reviewCenter = mountReviewCenter({
    api, project: referenceProjectKey, beforeWrite: prepareReferenceWrite, pdfjs: pdfjsLib,
    openPanel: () => {
      if (state.sidebarPanel !== "comments" || state.referencesOpen) setSidebarPanel("comments");
    },
    locate: locateReviewThread,
    currentSelection: (target) => target ? reviewSelectionAt(target) : state.reviewSelection?.pdf
      ? state.reviewSelection : activeReviewSource(),
    notify: toast, icons: refreshIcons,
    onChange() {
      renderReviewSourceGutter();
      updateSourceSyntaxHighlight();
      reviewCenter?.decorateRows(elements.segmentList);
      renderPdfReviews();
    }
  });
  const dropCue = document.querySelector("#reviewDropCue");
  const pdfFile = (file) => file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  const draggingPdf = (transfer) => [...(transfer?.items || [])].some((item) => item.kind === "file" && item.type === "application/pdf");
  document.addEventListener("dragover", (event) => {
    if (!draggingPdf(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropCue.classList.remove("hidden");
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget && (event.clientX <= 0 || event.clientX >= innerWidth || event.clientY <= 0 || event.clientY >= innerHeight)) {
      dropCue.classList.add("hidden");
    }
  });
  document.addEventListener("drop", (event) => {
    dropCue.classList.add("hidden");
    const file = [...(event.dataTransfer?.files || [])].find(pdfFile);
    if (!file) return;
    event.preventDefault();
    void reviewCenter.importFile(file);
  });
  document.addEventListener("pointerup", (event) => {
    if (event.button !== 0 || event.target.closest("#reviewSelectionButton")) return;
    const editor = event.target.closest("#sourceEditor, .segment-textarea, .segment-reading");
    const anchor = editor ? reviewSelectionAt(editor)
      : event.target.closest("#pdfScroll") ? selectedPdfReview(elements.pdfScroll, state.reviewPdfVersion) : null;
    if (!anchor) return;
    state.reviewSelection = anchor;
    if (anchor.quote) reviewCenter.showSelection(anchor, { x: event.clientX, y: event.clientY });
  });
  elements.sourceEditor.addEventListener("select", () => {
    state.reviewSelection = reviewSelectionAt(elements.sourceEditor);
    updateOutlineSelection();
  });
  elements.segmentList.addEventListener("scroll", () => updateOutlineSelection(), { passive: true });
}

function renderSectionList() {
  if (!elements.sectionList) return;
  let sections = [];
  const previewingProjectFile = elements.projectFilePreview && !elements.projectFilePreview.classList.contains("hidden");
  const currentSourceMatchesDocument = state.sourceFile
    && state.sourceFile === (state.currentFile || state.currentDocument?.file);
  if (!previewingProjectFile && state.sourceFile && (state.mode === "source" || currentSourceMatchesDocument)) {
    sections = sourceHeadingEntries(state.sourceFile, elements.sourceEditor?.value || "");
  } else if (!previewingProjectFile && state.currentDocument) {
    sections = documentHeadingEntries(state.currentDocument);
  }
  const signature = JSON.stringify([state.mode, sections]);
  if (elements.sectionList.dataset.signature === signature) {
    updateOutlineSelection();
    return;
  }
  elements.sectionList.dataset.signature = signature;
  elements.sectionCount.textContent = String(sections.length);
  elements.sectionList.replaceChildren();
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.className = "project-file-empty";
    empty.textContent = "当前文件没有检测到章节或小节";
    elements.sectionList.append(empty);
    return;
  }
  for (const section of sections) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-item";
    button.dataset.line = String(section.line);
    button.dataset.sectionId = section.sectionId || "";
    button.style.paddingLeft = `${10 + Math.max(0, Number(section.level || 1) - 1) * 14}px`;
    button.title = `${section.title} · L${section.line}`;
    button.innerHTML = '<i data-lucide="list-tree"></i><span class="section-item-title"></span><span class="section-item-line"></span>';
    button.querySelector(".section-item-title").textContent = section.title || "未命名章节";
    button.querySelector(".section-item-line").textContent = `L${section.line}`;
    button.addEventListener("click", async () => {
      if (state.mode === "source") {
        await openSourceLocation(section.file, section.line);
        return;
      }
      const row = section.segmentId
        ? [...elements.segmentList.querySelectorAll(".segment-row")].find((candidate) => candidate.dataset.segmentId === section.segmentId)
        : null;
      if (row) {
        row.classList.remove("pdf-located");
        void row.offsetWidth;
        row.classList.add("pdf-located");
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => row.classList.remove("pdf-located"), 2200);
      }
      if (section.sectionId && state.currentDocument?.segments.some((segment) => segment.sectionId === section.sectionId)) {
        state.currentSectionId = section.sectionId;
        renderTranslationSections(state.currentDocument);
        updateOutlineSelection(section.line);
        updateTranslateSectionButton();
      }
    });
    elements.sectionList.append(button);
  }
  updateOutlineSelection();
  refreshIcons();
}

function fastPreviewHash(value) {
  let hash = 5381;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function fastPreviewEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fastPreviewVisibleLine(line) {
  const source = String(line || "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "%" && !fastPreviewIsEscaped(source, index)) {
      return source.slice(0, index).trimEnd();
    }
  }
  return source;
}

function fastPreviewSplitProseEnv({ envName, envArgs, bodyLines, bodyStartLine, beginLine }) {
  const paragraphs = [];
  let current = [];
  let currentStart = bodyStartLine;
  bodyLines.forEach((line, index) => {
    if (line.trim() === "") {
      if (current.length) paragraphs.push({ lines: current, startLine: currentStart });
      current = [];
      currentStart = bodyStartLine + index + 1;
      return;
    }
    if (!current.length) currentStart = bodyStartLine + index;
    current.push(line);
  });
  if (current.length) paragraphs.push({ lines: current, startLine: currentStart });
  if (!paragraphs.length) {
    return [{
      startLine: beginLine,
      endLine: beginLine + 1,
      source: `\\begin{${envName}}${envArgs}\n\\end{${envName}}`,
      parentEnv: envName
    }];
  }
  return paragraphs.map((paragraph, index) => {
    const first = index === 0;
    const last = index === paragraphs.length - 1;
    const prefix = first ? `\\begin{${envName}}${envArgs}\n` : "";
    const suffix = last ? `\n\\end{${envName}}` : "";
    return {
      startLine: paragraph.startLine,
      endLine: paragraph.startLine + paragraph.lines.length - 1,
      source: `${prefix}${paragraph.lines.join("\n")}${suffix}`,
      parentEnv: envName
    };
  });
}

function splitFastPreviewBlocks(source, options = {}) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.map((line) => fastPreviewVisibleLine(line));
  const blocks = [];
  const ordinals = new Map();
  const blockFile = String(options.file || "");
  const lineOffset = Math.max(0, Number(options.lineOffset || 0));
  const idScope = `${fastPreviewHash(blockFile).toString(16)}-${lineOffset}`;
  let blockStart = 0;
  let blockLines = [];

  const nextId = (blockSource) => {
    const hash = fastPreviewHash(blockSource).toString(16);
    const ordinal = ordinals.get(hash) || 0;
    ordinals.set(hash, ordinal + 1);
    return `fast-block-${idScope}-${hash}-${ordinal}`;
  };
  const pushBlock = (endLine) => {
    if (!blockLines.some((line) => line.trim())) {
      blockLines = [];
      return;
    }
    const blockSource = blockLines.join("\n");
    blocks.push({
      id: nextId(blockSource),
      file: blockFile,
      startLine: lineOffset + blockStart + 1,
      endLine: lineOffset + endLine + 1,
      source: blockSource
    });
    blockLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = visibleLines[index];
    const trimmed = line.trim();
    const boundary = trimmed === "" || FAST_PREVIEW_SECTION_PATTERN.test(trimmed) || FAST_PREVIEW_BEGIN_END_PATTERN.test(trimmed);
    if (boundary && blockLines.length) pushBlock(index - 1);
    if (trimmed === "") {
      blockStart = index + 1;
      continue;
    }

    if (FAST_PREVIEW_SECTION_PATTERN.test(trimmed)) {
      blockStart = index;
      blockLines = [line];
      pushBlock(index);
      blockStart = index + 1;
      continue;
    }

    const beginMatch = trimmed.match(/^\\begin\{(\w+\*?)\}(.*)$/);
    if (beginMatch && FAST_PREVIEW_GROUPED_ENVS.has(beginMatch[1])) {
      const envName = beginMatch[1];
      const envArgs = beginMatch[2] || "";
      const beginPattern = `\\begin{${envName}}`;
      const endPattern = `\\end{${envName}}`;
      const beginLine = index;
      const bodyStartLine = index + 1;
      const bodyLines = [];
      let depth = 1;
      index += 1;
      while (index < lines.length && depth > 0) {
        const inner = visibleLines[index].trim();
        if (inner.includes(beginPattern)) depth += 1;
        if (inner.includes(endPattern)) depth -= 1;
        if (depth > 0) bodyLines.push(visibleLines[index]);
        if (depth > 0) index += 1;
      }
      const envBlocks = FAST_PREVIEW_PROSE_ENVS.has(envName)
        ? fastPreviewSplitProseEnv({ envName, envArgs, bodyLines, bodyStartLine, beginLine })
        : [{
            startLine: beginLine,
            endLine: index,
            source: [visibleLines[beginLine], ...bodyLines, visibleLines[index] || ""].join("\n"),
            parentEnv: envName
          }];
      envBlocks.forEach((block) => blocks.push({
        ...block,
        id: nextId(block.source),
        file: blockFile,
        startLine: lineOffset + block.startLine + 1,
        endLine: lineOffset + block.endLine + 1
      }));
      blockStart = index + 1;
      continue;
    }

    if (trimmed && !blockLines.some((line) => line.trim())) blockStart = index;
    blockLines.push(line);
  }
  if (blockLines.length) pushBlock(lines.length - 1);
  return blocks;
}

function fastPreviewIncludedFile(parentFile, reference) {
  const source = String(reference || "").trim().replaceAll("\\", "/");
  if (!source || source.includes("\0")) return "";
  const withExtension = /\.[A-Za-z0-9]+$/.test(source) ? source : `${source}.tex`;
  const base = String(parentFile || "").replaceAll("\\", "/").split("/").slice(0, -1);
  const resolved = [];
  for (const part of [...base, ...withExtension.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) return "";
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

async function resolveFastPreviewParts(file, content, seen = new Set(), depth = 0) {
  const normalizedFile = String(file || "").replaceAll("\\", "/");
  if (!normalizedFile || depth > 5 || seen.has(normalizedFile.toLowerCase())) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(normalizedFile.toLowerCase());
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let chunkStart = 0;
  const pushChunk = (end) => {
    if (end <= chunkStart) return;
    parts.push({ file: normalizedFile, content: lines.slice(chunkStart, end).join("\n"), lineOffset: chunkStart });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const visible = fastPreviewVisibleLine(lines[index]).trim();
    const match = visible.match(/^\\(?:input|include)\s*\{([^{}]+)\}\s*$/);
    if (!match) continue;
    pushChunk(index);
    const includedFile = fastPreviewIncludedFile(normalizedFile, match[1]);
    if (includedFile) {
      try {
        const included = await api(`/api/source?file=${encodeURIComponent(includedFile)}`);
        parts.push(...await resolveFastPreviewParts(included.file || includedFile, included.content, nextSeen, depth + 1));
      } catch {
        // A missing optional include should not break the rest of the fast preview.
      }
    }
    chunkStart = index + 1;
  }
  pushChunk(lines.length);
  return parts.length ? parts : [{ file: normalizedFile, content: String(content || ""), lineOffset: 0 }];
}

function splitFastPreviewSource(source) {
  const parts = Array.isArray(source.parts) && source.parts.length
    ? source.parts
    : [{ file: source.file, content: source.content, lineOffset: 0 }];
  return parts.flatMap((part) => splitFastPreviewBlocks(part.content, {
    file: part.file,
    lineOffset: part.lineOffset
  }));
}

function renderFastPreviewText(source) {
  const readable = String(source || "")
    .replace(/\\([%&_#{}])/g, "$1")
    .replaceAll("~", "\u00a0");
  return fastPreviewEscape(readable)
    .replace(/\\(?:textbf|bfseries)\s*\{([^{}]*)\}/g, "<strong>$1</strong>")
    .replace(/\\(?:emph|textit)\s*\{([^{}]*)\}/g, "<em>$1</em>")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g, "<span class=\"fast-preview-command\">[$1]</span>")
    .replace(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]*)\}/g, "<figure>Image: $1</figure>")
    .replace(/\\\\/g, "<br>")
    .replace(/\n/g, "<br>");
}

function fastPreviewFigurePath(value, sourceFile, command) {
  return resolveGraphicPath(value, {
    files: state.project?.projectFiles || [],
    sourceFile,
    mainFile: state.project?.config?.mainTex || "",
    searchPaths: state.fastPreviewGraphicsPaths,
    command
  });
}

function fastPreviewFigureMarkup(source, envName, sourceFile) {
  const escapedEnvName = envName.endsWith("*") ? `${envName.slice(0, -1)}\\*` : envName;
  const body = String(source || "")
    .replace(new RegExp(`^\\\\begin\\{${escapedEnvName}\\}(?:\\[[^\\]]*\\])?\\s*`), "")
    .replace(new RegExp(`\\\\end\\{${escapedEnvName}\\}\\s*$`), "");
  const images = graphicsCommands(body)
    .filter((item) => item.command !== "graphicspath")
    .map((item) => fastPreviewFigurePath(item.value, sourceFile, item.command))
    .filter(Boolean);
  const minipages = [...body.matchAll(/\\begin\{minipage\}\{([^{}]*)\}/g)].length;
  const columns = Math.min(4, Math.max(1, minipages || images.length || 1));
  const alignment = /\\raggedright/.test(body) ? "left" : /\\raggedleft/.test(body) ? "right" : "center";
  const caption = extractLatexCommandArgument(body, "caption");
  const cells = images.length ? images.map((file) => {
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    const label = fastPreviewEscape(file);
    const url = `/api/project/file?path=${encodeURIComponent(file)}`;
    if (extension === ".pdf") {
      return `<div class="fast-preview-figure-cell pdf"><canvas class="fast-preview-pdf" data-pdf-url="${fastPreviewEscape(url)}" aria-label="${label}"></canvas><span>${label}</span></div>`;
    }
    if (extension === ".eps") {
      return `<div class="fast-preview-figure-cell pdf"><span class="fast-preview-figure-file-badge">EPS</span><span>${label}</span></div>`;
    }
    return `<div class="fast-preview-figure-cell"><img src="${url}" alt="${label}" loading="lazy"><span>${label}</span></div>`;
  }).join("") : `<div class="fast-preview-figure-cell empty"><span>未识别到图片命令</span></div>`;
  const sourceLabel = sourceFile ? ` data-source-file="${fastPreviewEscape(sourceFile)}"` : "";
  return `<figure class="fast-preview-figure ${envName.endsWith("*") ? "span" : ""}" style="--preview-columns:${columns};--preview-align:${alignment}"${sourceLabel}><div class="fast-preview-figure-grid">${cells}</div>${caption ? `<figcaption>${renderFastPreviewInline(caption)}</figcaption>` : ""}</figure>`;
}

function fastPreviewIsEscaped(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function fastPreviewFindClosingDollar(source, start, display) {
  const marker = display ? "$$" : "$";
  for (let index = start; index < source.length; index += 1) {
    if (source.startsWith(marker, index) && !fastPreviewIsEscaped(source, index)) return index;
  }
  return -1;
}

function fastPreviewFindClosingMarker(source, start, marker) {
  const index = source.indexOf(marker, start);
  return index >= 0 ? index : -1;
}

function renderFastPreviewMath(math, { display = false, envName = "" } = {}) {
  const escaped = fastPreviewEscape(math.trim());
  const classes = `math-pending${display ? " display" : ""}`;
  const label = envName ? ` data-env="${fastPreviewEscape(envName)}"` : "";
  return `<span class="${classes}" data-math="${escaped}"${label} title="双击定位到源码；正式 PDF 以 TeX 编译结果为准">${escaped}</span>`;
}

function renderFastPreviewInline(source) {
  const text = String(source || "");
  let html = "";
  let cursor = 0;
  const appendText = (end) => {
    if (end > cursor) html += renderFastPreviewText(text.slice(cursor, end));
    cursor = end;
  };

  while (cursor < text.length) {
    if (text.startsWith("$$", cursor) && !fastPreviewIsEscaped(text, cursor)) {
      const close = fastPreviewFindClosingDollar(text, cursor + 2, true);
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math, { display: true });
        cursor = close + 2;
        continue;
      }
    }
    if (text.startsWith("\\[", cursor)) {
      const close = fastPreviewFindClosingMarker(text, cursor + 2, "\\]");
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math, { display: true });
        cursor = close + 2;
        continue;
      }
    }
    if (text.startsWith("\\(", cursor)) {
      const close = fastPreviewFindClosingMarker(text, cursor + 2, "\\)");
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math);
        cursor = close + 2;
        continue;
      }
    }
    if (text[cursor] === "$" && !fastPreviewIsEscaped(text, cursor)) {
      const close = fastPreviewFindClosingDollar(text, cursor + 1, false);
      if (close >= 0) {
        const math = text.slice(cursor + 1, close);
        html += renderFastPreviewMath(math);
        cursor = close + 1;
        continue;
      }
    }
    const next = [
      text.indexOf("$$", cursor + 1),
      text.indexOf("\\[", cursor + 1),
      text.indexOf("\\(", cursor + 1),
      text.indexOf("$", cursor + 1)
    ].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? text.length;
    appendText(next);
  }
  return html;
}

function fastPreviewMathEnvironment(source, envName) {
  const body = source
    .replace(new RegExp(`^\\\\begin\\{${envName.replace("*", "\\*")}\\}[^\\n]*\\n?`), "")
    .replace(new RegExp(`\\n?\\\\end\\{${envName.replace("*", "\\*")}\\}\\s*$`), "")
    .trim();
  if (/^align|^flalign|^alignat/.test(envName)) return `\\begin{aligned}\n${body}\n\\end{aligned}`;
  if (/^gather/.test(envName)) return `\\begin{gathered}\n${body}\n\\end{gathered}`;
  return body;
}

function extractLatexCommandArgument(source, command) {
  const visible = String(source || "").split(/\r?\n/).map(fastPreviewVisibleLine).join("\n");
  const match = new RegExp(`\\\\${command}\\s*\\{`).exec(visible);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let cursor = start; cursor < visible.length; cursor += 1) {
    if (visible[cursor] === "{" && !fastPreviewIsEscaped(visible, cursor)) depth += 1;
    if (visible[cursor] === "}" && !fastPreviewIsEscaped(visible, cursor)) depth -= 1;
    if (depth === 0) return visible.slice(start, cursor).trim();
  }
  return "";
}

function fastPreviewPaperHeaderMarkup(source) {
  const title = extractLatexCommandArgument(source, "title");
  if (!title) return "";
  return `<header class="fast-preview-paper-header"><h1>${renderFastPreviewInline(title)}</h1></header>`;
}

function updateFastPreviewPaperHeader(documentNode, source) {
  if (!documentNode) return null;
  const markup = fastPreviewPaperHeaderMarkup(source);
  let header = documentNode.querySelector(".fast-preview-paper-header");
  if (!markup) {
    header?.remove();
    return null;
  }
  if (!header) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    header = template.content.firstElementChild;
    documentNode.querySelector(".fast-preview-meta")?.after(header);
  } else if (header.outerHTML !== markup) {
    header.outerHTML = markup;
    header = documentNode.querySelector(".fast-preview-paper-header");
  }
  return header;
}

function renderFastPreviewTable(source, envName = "table") {
  const table = parseLatexTable(source);
  if (!table?.rows?.length) {
    return `<div class="fast-preview-table fast-preview-table-empty"><span>未识别到表格内容</span></div>`;
  }
  const columns = Math.max(table.columns.length, ...table.rows.map((row) => row.length));
  const cells = table.rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? "th" : "td";
    return `<tr>${row.map((cell) => {
      const span = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
      const rowSpan = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
      return `<${tag}${span}${rowSpan}>${renderFastPreviewInline(cell.source)}</${tag}>`;
    }).join("")}</tr>`;
  }).join("");
  const caption = table.caption ? `<figcaption>${renderFastPreviewInline(table.caption)}</figcaption>` : "";
  return `<figure class="fast-preview-table ${envName.endsWith("*") ? "span" : ""}" style="--preview-table-columns:${columns}"><div class="fast-preview-table-scroll"><table>${cells}</table></div>${caption}</figure>`;
}

function renderFastPreviewBlock(block) {
  const source = block.source.trim();
  const section = source.match(/^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^{}]*)\}/);
  let html = "";
  if (/^\\documentclass|^\\usepackage|^\\newcommand|^\\renewcommand|^\\def|^\\title|^\\author|^\\date|^\\maketitle|^\\bibliography|^\\bibliographystyle|^\\begin\{document\}/.test(source)) {
    html = "";
  } else if (section) {
    const tag = section[1] === "chapter" || section[1] === "section" ? "h2" : section[1] === "subsection" ? "h3" : "h4";
    html = `<${tag}>${renderFastPreviewInline(section[2])}</${tag}>`;
  } else if (block.parentEnv === "abstract") {
    const first = /^\\begin\{abstract\}/.test(source);
    const body = source
      .replace(/^\\begin\{abstract\}[^\n]*\n?/, "")
      .replace(/\n?\\end\{abstract\}\s*$/, "")
      .trim();
    html = `<p class="fast-preview-abstract">${first ? '<strong class="fast-preview-abstract-label">Abstract—</strong>' : ""}${renderFastPreviewInline(body)}</p>`;
  } else if (/^\\begin\{/.test(source)) {
    const envName = source.match(/^\\begin\{([^{}]+)\}/)?.[1] || "environment";
    if (/^figure\*?$/.test(envName)) {
      html = fastPreviewFigureMarkup(source, envName, block.file);
    } else if (/^table\*?$/.test(envName) || /^tabular\*?$/.test(envName)) {
      html = renderFastPreviewTable(source, envName);
    } else if (/^(equation|align|gather|multline|alignat|flalign)\*?$/.test(envName)) {
      html = renderFastPreviewMath(fastPreviewMathEnvironment(source, envName), { display: true, envName });
    } else {
      html = `<div class="fast-preview-env"><strong>${fastPreviewEscape(envName)}</strong><br>${renderFastPreviewInline(source)}</div>`;
    }
  } else if (/^\\end\{document\}/.test(source)) {
    html = "";
  } else {
    html = `<p>${renderFastPreviewInline(source)}</p>`;
  }
  return {
    ...block,
    sourceHash: fastPreviewHash(block.source),
    htmlHash: fastPreviewHash(html),
    html
  };
}

const MARKDOWN_ALLOWED_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "IMG", "LI", "OL", "P", "PRE", "STRONG", "SUB", "SUP", "TABLE", "TBODY", "TD",
  "TH", "THEAD", "TR", "UL", "SPAN"
]);

function markdownProjectPath(value, sourceFile) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return "";
  try {
    const baseDir = String(sourceFile || "").replaceAll("\\", "/").split("/").slice(0, -1).join("/");
    const resolved = new URL(raw, `https://paperbridge.local/${baseDir ? `${baseDir}/` : ""}`);
    const relative = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
    const match = (state.project?.projectFiles || []).find((entry) => (
      entry.type === "file" && entry.path.toLowerCase() === relative.toLowerCase()
    ));
    return match?.path || "";
  } catch {
    return "";
  }
}

function prepareMarkdownPreview(html, sourceFile) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  for (const element of [...template.content.querySelectorAll("*")]) {
    if (!MARKDOWN_ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    if (element.classList.contains("markdown-math")) {
      const encoded = element.getAttribute("data-math-code") || "";
      let math = "";
      try {
        math = decodeURIComponent(encoded);
      } catch {
        math = encoded;
      }
      const display = element.classList.contains("display");
      element.replaceChildren();
      element.className = "markdown-math" + (display ? " display" : "");
      element.dataset.math = math;
      continue;
    }
    const href = element.getAttribute("href") || "";
    const src = element.getAttribute("src") || "";
    const alt = element.getAttribute("alt") || "";
    const title = element.getAttribute("title") || "";
    const languageClass = element.tagName === "CODE"
      ? [...element.classList].find((name) => /^language-[a-z0-9_-]+$/i.test(name)) || ""
      : "";
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (languageClass) element.className = languageClass;
    if (title) element.title = title;
    if (element.tagName === "IMG") {
      const projectPath = markdownProjectPath(src, sourceFile);
      if (projectPath) element.src = `/api/project/file?path=${encodeURIComponent(projectPath)}`;
      else if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) element.src = src;
      else element.replaceWith(document.createTextNode(alt || src || "图片"));
      if (element.isConnected || element.parentNode) element.alt = alt;
    }
    if (element.tagName === "A") {
      const projectPath = markdownProjectPath(href, sourceFile);
      if (projectPath && /\.(?:md|markdown)$/i.test(projectPath)) {
        element.href = "#";
        element.dataset.markdownFile = projectPath;
      } else if (/^https?:\/\//i.test(href)) {
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
      } else if (href.startsWith("#")) {
        element.href = href;
      }
    }
  }
  return template.content;
}

function markdownFormulaSource(value) {
  const source = String(value || "");
  let result = "";
  let cursor = 0;
  let fenced = false;
  const appendFormula = (math, display) => {
    const className = display ? "markdown-math display" : "markdown-math";
    return (display ? "\n\n" : "")
      + '<span class="' + className + '" data-math-code="' + encodeURIComponent(math) + '"></span>'
      + (display ? "\n\n" : "");
  };
  while (cursor < source.length) {
    const lineStart = cursor === 0 || source[cursor - 1] === "\n";
    const fenceMarker = String.fromCharCode(96).repeat(3);
    if (lineStart && (source.startsWith(fenceMarker, cursor) || source.startsWith("~~~", cursor))) {
      const lineEnd = source.indexOf("\n", cursor);
      const end = lineEnd < 0 ? source.length : lineEnd + 1;
      fenced = !fenced;
      result += source.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (fenced) {
      result += source[cursor++];
      continue;
    }
    const candidates = [
      ["$$", "$$", true],
      ["\\[", "\\]", true],
      ["[/", "]/", true],
      ["\\(", "\\)", false],
      ["$", "$", false]
    ];
    const candidate = candidates.find(([start]) => source.startsWith(start, cursor));
    if (!candidate) {
      result += source[cursor++];
      continue;
    }
    const [startMarker, endMarker, display] = candidate;
    const end = source.indexOf(endMarker, cursor + startMarker.length);
    if (end < 0 || (!display && source.slice(cursor + startMarker.length, end).includes("\n"))) {
      result += source[cursor++];
      continue;
    }
    const math = source.slice(cursor + startMarker.length, end).trim();
    result += appendFormula(math, display);
    cursor = end + endMarker.length;
  }
  return result;
}

function renderMarkdownMath(root) {
  root.querySelectorAll(".markdown-math").forEach((node) => {
    const math = node.dataset.math || "";
    if (!math) return;
    if (!window.katex?.renderToString) {
      node.textContent = math;
      node.classList.add("math-fallback");
      return;
    }
    try {
      node.innerHTML = window.katex.renderToString(math, {
        displayMode: node.classList.contains("display"),
        throwOnError: false,
        strict: "ignore",
        trust: false
      });
    } catch (error) {
      node.textContent = math;
      node.classList.add("math-fallback");
      node.title = error.message || "公式渲染失败";
    }
  });
}

function markdownLineCount(value) {
  return Math.max(1, String(value || "").split(/\r?\n/).length);
}

function markdownPreviewBlocks(source, sourceFile) {
  if (typeof marked?.lexer !== "function" || typeof marked?.parser !== "function") return null;
  const renderedSource = markdownFormulaSource(source);
  const tokens = marked.lexer(renderedSource, { gfm: true, breaks: false });
  const blocks = [];
  let startLine = 1;
  try {
    for (const token of tokens) {
      const raw = String(token.raw || "");
      const lineBreaks = (raw.match(/\n/g) || []).length;
      const endLine = startLine + lineBreaks;
      if (token.type !== "space") {
        const html = marked.parser([token], { gfm: true, breaks: false });
        const content = prepareMarkdownPreview(html, sourceFile);
        if (content.childNodes.length) {
          const block = document.createElement("div");
          block.className = "markdown-sync-block";
          block.dataset.sourceStartLine = String(startLine);
          block.dataset.sourceEndLine = String(Math.max(startLine, endLine));
          block.append(content);
          blocks.push(block);
        }
      }
      startLine = endLine;
    }
    return blocks;
  } catch {
    return null;
  }
}

function markdownPreviewAnchors() {
  const container = elements.pdfScroll;
  const containerRect = container.getBoundingClientRect();
  return [...container.querySelectorAll(".markdown-sync-block")].map((block) => {
    const rect = block.getBoundingClientRect();
    return {
      startLine: Number(block.dataset.sourceStartLine) || 1,
      endLine: Number(block.dataset.sourceEndLine) || 1,
      top: rect.top - containerRect.top + container.scrollTop,
      height: Math.max(1, rect.height)
    };
  });
}

function markdownSourceLineHeight() {
  const lineHeight = Number.parseFloat(getComputedStyle(elements.sourceEditor).lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  return Math.max(1, elements.sourceEditor.scrollHeight / markdownLineCount(elements.sourceEditor.value));
}

function markdownSyncAllowed(origin) {
  const sync = state.markdownScrollSync;
  const now = performance.now();
  if (sync.origin && sync.origin !== origin && sync.lockUntil > now) return false;
  sync.origin = origin;
  sync.lockUntil = now + 120;
  return true;
}

function markdownPreviewOffsetForLine(line, anchors) {
  if (!anchors.length) {
    const sourceMax = Math.max(0, elements.sourceEditor.scrollHeight - elements.sourceEditor.clientHeight);
    const previewMax = Math.max(0, elements.pdfScroll.scrollHeight - elements.pdfScroll.clientHeight);
    return sourceMax ? (elements.sourceEditor.scrollTop / sourceMax) * previewMax : 0;
  }
  const targetLine = Math.max(1, Number(line) || 1);
  for (const anchor of anchors) {
    if (targetLine > anchor.endLine) continue;
    const span = Math.max(1, anchor.endLine - anchor.startLine);
    const ratio = Math.max(0, Math.min(1, (targetLine - anchor.startLine) / span));
    return anchor.top + anchor.height * ratio;
  }
  const last = anchors.at(-1);
  return last.top + last.height;
}

function markdownSourceLineForPreviewOffset(offset, anchors) {
  if (!anchors.length) {
    const previewMax = Math.max(0, elements.pdfScroll.scrollHeight - elements.pdfScroll.clientHeight);
    const sourceMax = Math.max(0, elements.sourceEditor.scrollHeight - elements.sourceEditor.clientHeight);
    return sourceMax ? 1 + (offset / Math.max(1, previewMax)) * (sourceMax / markdownSourceLineHeight()) : 1;
  }
  let active = anchors[0];
  for (const anchor of anchors) {
    if (anchor.top > offset) break;
    active = anchor;
  }
  const span = Math.max(1, active.height);
  const ratio = Math.max(0, Math.min(1, (offset - active.top) / span));
  return active.startLine + (active.endLine - active.startLine) * ratio;
}

function syncMarkdownPreviewToSource() {
  if (state.previewMode !== "markdown" || !markdownSyncAllowed("source")) return;
  const lineHeight = markdownSourceLineHeight();
  const sourceLine = 1 + elements.sourceEditor.scrollTop / lineHeight;
  const target = markdownPreviewOffsetForLine(sourceLine, markdownPreviewAnchors());
  const maxScroll = Math.max(0, elements.pdfScroll.scrollHeight - elements.pdfScroll.clientHeight);
  elements.pdfScroll.scrollTop = Math.max(0, Math.min(maxScroll, target - 10));
}

function syncMarkdownSourceToPreview() {
  if (state.previewMode !== "markdown" || !markdownSyncAllowed("preview")) return;
  const offset = elements.pdfScroll.scrollTop + 10;
  const sourceLine = markdownSourceLineForPreviewOffset(offset, markdownPreviewAnchors());
  const target = (sourceLine - 1) * markdownSourceLineHeight();
  const maxScroll = Math.max(0, elements.sourceEditor.scrollHeight - elements.sourceEditor.clientHeight);
  elements.sourceEditor.scrollTop = Math.max(0, Math.min(maxScroll, target));
}

async function renderMarkdownPreview(file = state.sourceFile) {
  const sourceFile = String(file || state.sourceFile || "");
  if (!isMarkdownFile(sourceFile)) return;
  const token = ++state.fastPreviewToken;
  window.clearTimeout(state.fastPreviewTimer);
  state.fastPreviewTimer = 0;
  setPreviewMode("markdown");
  resetPdfRenderer();
  const source = state.sourceFile === sourceFile
    ? { file: sourceFile, content: elements.sourceEditor.value }
    : await api(`/api/source?file=${encodeURIComponent(sourceFile)}`);
  if (token !== state.fastPreviewToken) return;
  const documentNode = document.createElement("article");
  documentNode.className = "markdown-preview-document";
  const blocks = markdownPreviewBlocks(source.content, source.file);
  if (blocks) {
    documentNode.append(...blocks);
  } else {
    // Keep the marked options explicit for the Markdown preview contract: marked.parse(source.content, { gfm: true, breaks: false });
    const rendered = marked.parse(markdownFormulaSource(source.content), { gfm: true, breaks: false });
    const block = document.createElement("div");
    block.className = "markdown-sync-block";
    block.dataset.sourceStartLine = "1";
    block.dataset.sourceEndLine = String(markdownLineCount(source.content));
    block.append(prepareMarkdownPreview(rendered, source.file));
    documentNode.append(block);
  }
  renderMarkdownMath(documentNode);
  if (!documentNode.textContent.trim() && !documentNode.querySelector("img, .markdown-math")) {
    documentNode.innerHTML = '<p class="markdown-preview-empty">开始在左侧输入 Markdown，预览会在这里实时更新。</p>';
  }
  documentNode.querySelectorAll("a[data-markdown-file]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openProjectFile(link.dataset.markdownFile);
    });
  });
  elements.pdfScroll.replaceChildren(documentNode);
  state.fastPreviewFile = source.file;
  state.fastPreviewCache = [];
  const lines = source.content.split(/\r?\n/).length;
  elements.pageStatus.textContent = `Markdown 实时预览 · ${lines} 行`;
  syncMarkdownPreviewToSource();
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  elements.previewPanel.dataset.previewMode = mode;
  if (mode !== "pdf") elements.previewPanel.classList.remove("compile-failed", "compile-running");
  elements.previewTitle.textContent = mode === "markdown" ? "Markdown 预览" : "英文排版";
  elements.previewModeLabel.textContent = mode === "pdf" ? "正式 PDF" : mode === "markdown" ? "Markdown" : "快速预览";
  elements.pdfScroll.classList.toggle("fast-preview-scroll", mode === "fast");
  elements.pdfScroll.classList.toggle("pdf-preview-scroll", mode === "pdf");
  elements.pdfScroll.classList.toggle("markdown-preview-scroll", mode === "markdown");
  if (mode === "fast") {
    elements.visiblePage.textContent = "—";
    elements.pageStatus.textContent = "快速预览";
  } else if (mode === "markdown") {
    elements.visiblePage.textContent = "—";
    elements.pageStatus.textContent = "Markdown 实时预览";
  }
}

function resetPdfRenderer() {
  state.pdfRenderKey = "";
  state.pdfRenderToken += 1;
  state.pdfObserver?.disconnect();
  state.pdfObserver = null;
  state.fastPreviewFigureObserver?.disconnect();
  state.fastPreviewFigureObserver = null;
  for (const task of state.pdfPageRenderTasks.values()) task.cancel();
  state.pdfPageRenderTasks.clear();
  for (const entry of state.pdfTextLayers.values()) if (!entry.ready) entry.task.cancel();
  state.pdfTextLayers.clear();
  state.pdfDocument = null;
}

function renderCompileProgress() {
  setPreviewMode("pdf");
  elements.previewPanel.classList.remove("compile-failed");
  elements.previewPanel.classList.add("compile-running");
  elements.pageStatus.textContent = "正在编译全文";
  if (state.pdfDocument) return;
  resetPdfRenderer();
  invalidatePdfNavigationIndex();
  elements.visiblePage.textContent = "—";
  const stateNode = document.createElement("div");
  stateNode.className = "compile-progress-preview";
  stateNode.innerHTML = '<i data-lucide="loader-circle"></i><strong>正在生成 PDF</strong><span>完成后将在此显示正式 PDF。</span>';
  elements.pdfScroll.replaceChildren(stateNode);
  refreshIcons();
}

function renderCompileFailure(build = state.project?.lastBuild || {}) {
  setPreviewMode("pdf");
  resetPdfRenderer();
  invalidatePdfNavigationIndex();
  elements.previewPanel.classList.remove("compile-running");
  elements.previewPanel.classList.add("compile-failed");
  elements.pageStatus.textContent = "编译失败 · PDF 未更新";
  elements.visiblePage.textContent = "—";

  const errors = (build.errors || []).filter(Boolean);
  const locations = (build.locations || []).filter((item) => item?.file && item?.line);
  const card = document.createElement("section");
  card.className = "compile-failure-preview";
  const heading = document.createElement("div");
  heading.className = "compile-failure-heading";
  heading.innerHTML = '<i data-lucide="circle-x"></i><div><strong>本次编译失败</strong><span>旧 PDF 已停用，避免显示过期排版或跳转到错误位置。</span></div>';
  const errorList = document.createElement("div");
  errorList.className = "compile-failure-errors";
  for (const message of (errors.length ? errors : ["LaTeX 编译器没有生成可用 PDF，请查看完整编译信息。"]).slice(0, 4)) {
    const row = document.createElement("div");
    row.textContent = message;
    errorList.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "compile-failure-actions";
  for (const location of locations.slice(0, 4)) {
    const button = document.createElement("button");
    button.className = "button secondary compile-location-button";
    button.type = "button";
    button.innerHTML = '<i data-lucide="code-2"></i><span></span>';
    button.querySelector("span").textContent = `${location.file}:${location.line}`;
    button.title = location.message || "打开编译器报告的源码位置";
    button.addEventListener("click", () => void openSourceLocation(location.file, location.line));
    actions.append(button);
  }
  const detailsButton = document.createElement("button");
  detailsButton.className = "button primary";
  detailsButton.type = "button";
  detailsButton.innerHTML = '<i data-lucide="list-tree"></i><span>查看完整编译信息</span>';
  detailsButton.addEventListener("click", () => {
    state.dismissedBuildDrawerFingerprint = "";
    elements.buildDrawer.classList.remove("hidden");
  });
  actions.append(detailsButton);
  card.append(heading, errorList, actions);
  elements.pdfScroll.replaceChildren(card);
  refreshIcons();
}

async function fastPreviewSource(file = "") {
  const sourceFile = file || state.currentDocument?.file || state.sourceFile || state.project?.config?.mainTex || "";
  if (!sourceFile) throw new Error("尚未选择可预览的 TeX 文件。");
  const source = state.sourceDirty && state.sourceFile === sourceFile
    ? { file: sourceFile, content: elements.sourceEditor.value }
    : await api(`/api/source?file=${encodeURIComponent(sourceFile)}`);
  const mainTex = state.project?.config?.mainTex || "";
  if (sourceFile === mainTex) {
    source.parts = await resolveFastPreviewParts(source.file, source.content);
    source.graphicsPaths = graphicsSearchPaths(source.parts.map((part) => part.content).join("\n"));
  } else {
    let inherited = [];
    if (mainTex && graphicsCommands(source.content).some((item) => item.command !== "graphicspath")) {
      const mainSource = state.sourceDirty && state.sourceFile === mainTex
        ? { content: elements.sourceEditor.value }
        : await api(`/api/source?file=${encodeURIComponent(mainTex)}`);
      inherited = graphicsSearchPaths(mainSource.content);
    }
    source.graphicsPaths = graphicsSearchPaths(source.content, inherited);
  }
  return source;
}

function registerFastPreviewMath(root) {
  state.fastPreviewMathObserver?.disconnect();
  state.fastPreviewMathObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      const math = node.dataset.math || node.textContent || "";
      const displayMode = node.classList.contains("display");
      if (window.katex?.renderToString) {
        try {
          node.innerHTML = window.katex.renderToString(math, {
            displayMode,
            throwOnError: true,
            strict: "ignore",
            trust: false
          });
          node.classList.remove("math-pending");
          node.classList.add("math-rendered");
        } catch (error) {
          node.innerHTML = `
            <span class="math-fallback-label">公式暂未快速渲染 · 正式 PDF 以 TeX 为准</span>
            <code class="math-source">${fastPreviewEscape(math)}</code>
          `;
          node.classList.remove("math-pending");
          node.classList.add("math-rendered", "math-fallback");
          node.title = error.message || "KaTeX 无法渲染该公式";
        }
      } else {
        node.innerHTML = `
          <span class="math-fallback-label">KaTeX 未加载 · 显示原始公式</span>
          <code class="math-source">${fastPreviewEscape(math)}</code>
        `;
        node.classList.remove("math-pending");
        node.classList.add("math-rendered", "math-fallback");
      }
      state.fastPreviewMathObserver.unobserve(node);
    }
  }, { root: elements.pdfScroll, rootMargin: "100% 0px" });
  root.querySelectorAll(".math-pending").forEach((node) => state.fastPreviewMathObserver.observe(node));
}

function registerFastPreviewFigures(root) {
  state.fastPreviewFigureObserver?.disconnect();
  const nodes = [...root.querySelectorAll(".fast-preview-pdf[data-pdf-url]")];
  if (!nodes.length) return;
  const renderPdfFigure = async (canvas) => {
    const url = canvas.dataset.pdfUrl;
    try {
      const pdf = await pdfjsLib.getDocument({ url }).promise;
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const parentWidth = Math.max(180, canvas.parentElement?.clientWidth || 320);
      const scale = Math.min(1.5, Math.max(0.35, parentWidth / baseViewport.width));
      const deviceScale = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      const renderViewport = page.getViewport({ scale: scale * deviceScale });
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: renderViewport
      }).promise;
      canvas.closest(".fast-preview-figure-cell")?.classList.add("rendered");
    } catch (error) {
      const fallback = document.createElement("span");
      fallback.className = "fast-preview-figure-file-badge";
      fallback.textContent = "PDF";
      fallback.title = error.message || "PDF 快速预览失败";
      canvas.replaceWith(fallback);
    }
  };
  state.fastPreviewFigureObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      state.fastPreviewFigureObserver.unobserve(canvas);
      void renderPdfFigure(canvas);
    }
  }, { root: elements.pdfScroll, rootMargin: "100% 0px" });
  nodes.forEach((node) => state.fastPreviewFigureObserver.observe(node));
}

function applyFastPreviewPatches(nextBlocks) {
  const documentNode = elements.pdfScroll.querySelector(".fast-preview-document");
  if (!documentNode) return false;
  const oldById = new Map(state.fastPreviewCache.map((block) => [block.id, block]));
  const newIds = new Set(nextBlocks.map((block) => block.id));
  state.fastPreviewCache
    .filter((block) => !newIds.has(block.id))
    .forEach((block) => document.getElementById(block.id)?.remove());

  let anchor = documentNode.querySelector(".fast-preview-paper-header") || documentNode.querySelector(".fast-preview-meta");
  for (const block of nextBlocks) {
    if (!block.html) continue;
    const old = oldById.get(block.id);
    let node = document.getElementById(block.id);
    if (!node) {
      node = document.createElement("div");
      node.className = "fast-preview-block";
      node.id = block.id;
      anchor.after(node);
    }
    if (!old || old.htmlHash !== block.htmlHash) node.innerHTML = block.html;
    node.dataset.sourceFile = block.file || state.fastPreviewFile;
    node.dataset.sourceLine = String(block.startLine);
    node.dataset.endLine = String(block.endLine);
    if (node.previousElementSibling !== anchor) anchor.after(node);
    anchor = node;
  }
  state.fastPreviewCache = nextBlocks;
  registerFastPreviewMath(documentNode);
  registerFastPreviewFigures(documentNode);
  return true;
}

async function renderFastPreview(file = "") {
  const token = ++state.fastPreviewToken;
  window.clearTimeout(state.fastPreviewTimer);
  state.fastPreviewTimer = 0;
  setPreviewMode("pdf");
  resetPdfRenderer();
  const started = performance.now();
  if (!state.fastPreviewCache.length || state.fastPreviewFile !== (file || state.fastPreviewFile)) {
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">正在生成快速预览...</div>';
  }
  try {
    const source = await fastPreviewSource(file);
    if (token !== state.fastPreviewToken) return;
    state.fastPreviewGraphicsPaths = source.graphicsPaths || [];
    const fileChanged = state.fastPreviewFile && state.fastPreviewFile !== source.file;
    if (fileChanged) state.fastPreviewCache = [];
    const nextBlocks = splitFastPreviewSource(source).map(renderFastPreviewBlock);
    state.fastPreviewFile = source.file;
    updateFastPreviewPaperHeader(elements.pdfScroll.querySelector(".fast-preview-document"), source.content);
    const reused = applyFastPreviewPatches(nextBlocks);
    if (!reused) {
      const documentNode = document.createElement("div");
      documentNode.className = "fast-preview-document";
      const meta = document.createElement("div");
      meta.className = "fast-preview-meta";
      meta.textContent = `${source.file} · 快速 HTML 预览，正式排版请点击“编译全文”`;
      documentNode.append(meta);
      const headerMarkup = fastPreviewPaperHeaderMarkup(source.content);
      if (headerMarkup) {
        const template = document.createElement("template");
        template.innerHTML = headerMarkup;
        documentNode.append(template.content.firstElementChild);
      }
      for (const block of nextBlocks) {
        if (!block.html) continue;
        const node = document.createElement("div");
        node.className = "fast-preview-block";
        node.id = block.id;
        node.dataset.sourceFile = block.file || source.file;
        node.dataset.sourceLine = String(block.startLine);
        node.dataset.endLine = String(block.endLine);
        node.innerHTML = block.html;
        documentNode.append(node);
      }
      elements.pdfScroll.replaceChildren(documentNode);
      state.fastPreviewCache = nextBlocks;
      registerFastPreviewMath(documentNode);
      registerFastPreviewFigures(documentNode);
    }
    const meta = elements.pdfScroll.querySelector(".fast-preview-meta");
    if (meta) meta.textContent = `${source.file} · 快速 HTML 预览，正式排版请点击“编译全文”`;
    const elapsed = Math.round(performance.now() - started);
    elements.pageStatus.textContent = `快速预览 · ${nextBlocks.filter((block) => block.html).length} blocks · ${elapsed}ms`;
  } catch (error) {
    if (token !== state.fastPreviewToken) return;
    state.fastPreviewCache = [];
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">快速预览生成失败</div>';
    elements.pageStatus.textContent = "快速预览失败";
    toast(error.message, "error", 5200);
  }
}

async function renderPdf() {
  if (state.compileInFlight) {
    renderCompileProgress();
    return;
  }
  if (state.buildPreviewAvailable === false) {
    renderCompileFailure();
    return;
  }
  setPreviewMode("pdf");
  elements.previewPanel.classList.remove("compile-failed", "compile-running");
  state.fastPreviewMathObserver?.disconnect();
  state.fastPreviewFigureObserver?.disconnect();
  state.fastPreviewFigureObserver = null;
  const token = ++state.pdfRenderToken;
  window.clearTimeout(state.pdfRenderTimer);
  state.pdfRenderTimer = 0;
  state.pdfObserver?.disconnect();
  state.pdfObserver = null;
  for (const task of state.pdfPageRenderTasks.values()) task.cancel();
  state.pdfPageRenderTasks.clear();
  for (const entry of state.pdfTextLayers.values()) if (!entry.ready) entry.task.cancel();
  state.pdfTextLayers.clear();
  state.pdfDocument = null;
  elements.pdfScroll.innerHTML = '<div class="pdf-loading">正在渲染 PDF...</div>';
  try {
    const pdf = await pdfjsLib.getDocument({ url: `/api/pdf?t=${Date.now()}` }).promise;
    if (token !== state.pdfRenderToken) return;
    state.pdfDocument = pdf;
    state.reviewPdfVersion = state.project?.pdf?.updatedAt ? state.project.pdf.updatedAt + ":" + state.project.pdf.size : "";
    elements.pdfScroll.replaceChildren();
    const availableWidth = Math.max(280, elements.pdfScroll.clientWidth - 26);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (token !== state.pdfRenderToken) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = availableWidth / baseViewport.width;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.page = String(pageNumber);
      canvas.dataset.baseWidth = String(Math.floor(baseViewport.width * cssScale));
      canvas.dataset.baseHeight = String(Math.floor(baseViewport.height * cssScale));
      canvas.dataset.pageAspect = String(baseViewport.height / baseViewport.width);
      const zoomScale = state.pdfZoom / 100;
      canvas.style.width = `${Number(canvas.dataset.baseWidth) * zoomScale}px`;
      canvas.style.height = `${Number(canvas.dataset.baseHeight) * zoomScale}px`;
      const shell = document.createElement("div");
      shell.className = "pdf-page-shell";
      shell.dataset.page = String(pageNumber);
      shell.style.width = canvas.style.width;
      shell.style.height = canvas.style.height;
      const textLayer = document.createElement("div");
      textLayer.className = "pdf-text-layer textLayer";
      textLayer.setAttribute("aria-label", `PDF 第 ${pageNumber} 页文本`);
      shell.reviewPage = { page, viewport: baseViewport };
      shell.append(canvas, textLayer);
      elements.pdfScroll.append(shell);
    }
    state.pdfObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void renderPdfCanvas(entry.target).catch((error) => toast(`PDF 页面渲染失败：${error.message}`, "error"));
      }
    }, { root: elements.pdfScroll, rootMargin: "700px 0px" });
    elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => state.pdfObserver.observe(canvas));
    state.visiblePdfPage = 1;
    renderPdfReviews();
    elements.visiblePage.textContent = `1/${pdf.numPages}`;
    setPdfZoom(state.pdfZoom, { persist: false, preserveViewport: false });
  } catch (error) {
    if (token !== state.pdfRenderToken) return;
    state.pdfRenderKey = "";
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">PDF 渲染失败</div>';
    toast(error.message, "error");
  }
}

function updatePdf(pdf = state.project?.pdf) {
  if (state.previewMode !== "pdf") return;
  if (state.compileInFlight) {
    renderCompileProgress();
    return;
  }
  if (state.buildPreviewAvailable === false) {
    renderCompileFailure();
    return;
  }
  if (!pdf?.exists) {
    resetPdfRenderer();
    elements.previewPanel.classList.remove("compile-failed", "compile-running");
    elements.pageStatus.textContent = "PDF 未生成";
    elements.visiblePage.textContent = "—";
    elements.pdfScroll.replaceChildren();
    return;
  }
  elements.pageStatus.textContent = "";
  elements.previewPanel.classList.remove("compile-failed", "compile-running");
  const key = JSON.stringify([state.project?.config?.projectRoot, state.project?.config?.mainTex, pdf.updatedAt, pdf.size]);
  if (key === state.pdfRenderKey) return;
  state.pdfRenderKey = key;
  renderPdf();
}

function updateVisiblePdfPage() {
  const pages = [...elements.pdfScroll.querySelectorAll(".pdf-page")];
  if (!pages.length) return;
  const top = elements.pdfScroll.scrollTop + 18;
  let current = pages[0];
  for (const page of pages) {
    if (page.offsetTop <= top) current = page;
    else break;
  }
  state.visiblePdfPage = Number(current.dataset.page || 1);
  elements.visiblePage.textContent = `${state.visiblePdfPage}/${pages.length}`;
}

function movePdfPage(delta) {
  const pages = [...elements.pdfScroll.querySelectorAll(".pdf-page")];
  if (!pages.length) return;
  const targetNumber = Math.min(pages.length, Math.max(1, state.visiblePdfPage + delta));
  pages[targetNumber - 1].scrollIntoView({ behavior: "smooth", block: "start" });
  state.visiblePdfPage = targetNumber;
  elements.visiblePage.textContent = `${targetNumber}/${pages.length}`;
}

function flashSourceSelection() {
  window.clearTimeout(state.sourceHighlightTimer);
  const stage = elements.sourceEditor.closest(".source-editor-stage");
  elements.sourceEditor.classList.remove("source-located");
  stage?.classList.remove("source-located");
  void (stage || elements.sourceEditor).offsetWidth;
  elements.sourceEditor.classList.add("source-located");
  stage?.classList.add("source-located");
  state.sourceHighlightTimer = window.setTimeout(() => {
    elements.sourceEditor.classList.remove("source-located");
    stage?.classList.remove("source-located");
  }, 2600);
}

function updateWarnings(warnings = [], layoutChanges = [], errors = []) {
  const layoutWarnings = layoutChanges.map((change) => {
    const kind = change.type === "figure" ? "图" : "表";
    if (change.kind === "moved") return `${kind} ${change.label}：第 ${change.from} 页 → 第 ${change.to} 页`;
    if (change.kind === "added") return `${kind} ${change.label}：新增在第 ${change.to} 页`;
    return `${kind} ${change.label}：从第 ${change.from} 页消失`;
  });
  const combined = [
    ...errors.map((text) => ({ text, level: "error" })),
    ...layoutWarnings.map((text) => ({ text, level: "warning" })),
    ...warnings.map((text) => ({ text, level: "warning" }))
  ];
  state.warnings = combined.map((item) => item.text);
  elements.warningCount.textContent = String(combined.length);
  elements.warningCount.classList.toggle("hidden", combined.length === 0);
  elements.warningList.replaceChildren();
  if (!combined.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有编译错误或警告";
    elements.warningList.append(empty);
    return;
  }
  for (const item of combined) {
    const row = document.createElement("div");
    row.className = `warning-item ${item.level}`;
    row.textContent = item.text;
    elements.warningList.append(row);
  }
}

function clearCompileDiagnosis() {
  state.compileDiagnosisToken += 1;
  state.compileDiagnosisFingerprint = "";
  state.dismissedBuildDrawerFingerprint = "";
  elements.compileDiagnosis.classList.add("hidden");
  elements.compileDiagnosisStatus.textContent = "";
  elements.compileDiagnosisSummary.textContent = "";
  elements.compileDiagnosisList.replaceChildren();
}

function closeBuildDrawer() {
  state.dismissedBuildDrawerFingerprint = state.compileDiagnosisFingerprint || state.dismissedBuildDrawerFingerprint;
  elements.buildDrawer.classList.add("hidden");
}

function toggleBuildDrawer() {
  if (state.mode === "edit" && elements.buildDrawer.classList.contains("hidden")) {
    const build = state.project?.lastBuild;
    updateWarnings(build?.warnings || [], [], build?.success ? [] : build?.errors || []);
    updateTranslationBuildLabel(build);
  }
  const closed = elements.buildDrawer.classList.contains("hidden");
  if (closed) {
    state.dismissedBuildDrawerFingerprint = "";
    elements.buildDrawer.classList.remove("hidden");
  } else {
    closeBuildDrawer();
  }
}

async function openSourceLocation(file, line, { keepReferences = true } = {}) {
  const alreadyLoaded = state.mode === "source" && state.sourceFile === file;
  if (!alreadyLoaded && state.mode === "source" && state.sourceDirty && !confirmDiscardSourceChanges()) return false;
  if (!alreadyLoaded) {
    state.sourceFile = file;
    if (!setMode("source", { loadCurrent: false, keepReferences })) return false;
    if (!await loadSourceFile(file, { force: true })) return false;
  }
  const lines = elements.sourceEditor.value.split("\n");
  const targetLine = Math.min(lines.length, Math.max(1, Number(line) || 1));
  const start = lines.slice(0, targetLine - 1).reduce((total, value) => total + value.length + 1, 0);
  const end = start + (lines[targetLine - 1]?.length || 0);
  elements.sourceEditor.focus();
  elements.sourceEditor.setSelectionRange(start, end);
  scrollSourceOffsetIntoView(start);
  flashSourceSelection();
  updateSourceStatus();
  return true;
}

function renderCompileDiagnosis(diagnosis) {
  elements.compileDiagnosisSummary.textContent = diagnosis.summary || "AI 已完成编译错误分析。";
  elements.compileDiagnosisStatus.textContent = diagnosis.cached ? "已完成 · 缓存" : "已完成";
  elements.compileDiagnosisList.replaceChildren();
  for (const issue of diagnosis.issues || []) {
    const row = document.createElement("div");
    row.className = "diagnosis-issue";
    const meta = document.createElement("div");
    meta.className = "diagnosis-issue-meta";
    const location = document.createElement("button");
    location.className = "source-location-button";
    location.type = "button";
    location.innerHTML = '<i data-lucide="code-2"></i><span></span>';
    location.querySelector("span").textContent = `${issue.file}:${issue.line}`;
    location.title = "在 TeX 源码中打开";
    location.addEventListener("click", () => openSourceLocation(issue.file, issue.line));
    meta.append(location);
    const explanation = document.createElement("div");
    explanation.className = "diagnosis-explanation";
    explanation.textContent = issue.explanation;
    const suggestion = document.createElement("div");
    suggestion.className = "diagnosis-suggestion";
    suggestion.textContent = `建议：${issue.suggestion}`;
    row.append(meta, explanation, suggestion);
    if (issue.replacement) {
      const replacement = document.createElement("pre");
      replacement.className = "diagnosis-replacement";
      replacement.textContent = issue.replacement;
      row.append(replacement);
    }
    elements.compileDiagnosisList.append(row);
  }
  refreshIcons();
}

async function diagnoseBuild(build) {
  const errors = build.errors || [];
  const fingerprint = JSON.stringify([state.project?.config?.projectRoot, state.project?.config?.mainTex, errors, build.log || ""]);
  if (state.compileDiagnosisFingerprint === fingerprint && elements.compileDiagnosisStatus.textContent === "分析中") return;
  const token = ++state.compileDiagnosisToken;
  state.compileDiagnosisFingerprint = fingerprint;
  elements.compileDiagnosis.classList.remove("hidden");
  if (state.dismissedBuildDrawerFingerprint !== fingerprint) {
    elements.buildDrawer.classList.remove("hidden");
  }
  elements.compileDiagnosisStatus.textContent = "分析中";
  elements.compileDiagnosisSummary.textContent = "AI 正在定位错误...";
  elements.compileDiagnosisList.replaceChildren();
  try {
    const diagnosis = await api("/api/compile/diagnose", {
      method: "POST",
      body: JSON.stringify({ errors, log: build.log || "" })
    });
    if (token !== state.compileDiagnosisToken) return;
    renderCompileDiagnosis(diagnosis);
  } catch (error) {
    if (token !== state.compileDiagnosisToken) return;
    elements.compileDiagnosisStatus.textContent = "诊断失败";
    elements.compileDiagnosisSummary.textContent = error.message;
  }
}

function updateTranslationBuildLabel(build = state.project?.lastBuild) {
  const label = document.querySelector("#translationBuildLabel");
  if (state.compileInFlight) {
    label.textContent = "正在编译…";
    return;
  }
  const date = build?.updatedAt ? new Date(build.updatedAt) : null;
  const time = date && !Number.isNaN(+date)
    ? " " + date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const errors = build?.success ? 0 : build?.errors?.length || 0;
  const warnings = build?.warnings?.length || 0;
  label.textContent = build ? (build.success ? "已编译" : "编译失败") + time + " · " + errors + " 错误 · " + warnings + " 警告" : "未编译";
  const badge = document.querySelector("#warningCount");
  const count = errors + (state.mode === "edit" ? warnings : 0);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
}

function updateBuild(build) {
  if (!build) return;
  const usablePdf = build.previewAvailable === true && build.pdf?.exists !== false;
  const failed = !build.success && !usablePdf && !build.skipped;
  if (failed) state.buildPreviewAvailable = false;
  else if (typeof build.previewAvailable === "boolean") state.buildPreviewAvailable = build.previewAvailable;
  if (state.project && !build.skipped) {
    state.project.lastBuild = {
      success: Boolean(build.success || usablePdf),
      previewAvailable: Boolean(build.previewAvailable),
      recoverable: Boolean(build.recoverable),
      errors: build.errors || [],
      warnings: build.warnings || [],
      locations: build.locations || [],
      engine: build.engine || "",
      mode: build.mode || "",
      pdf: build.pdf || null,
      updatedAt: new Date().toISOString()
    };
  }
  if (build.pdf) {
    state.project.pdf = build.pdf;
    if (state.previewMode === "pdf" && !failed) updatePdf(build.pdf);
  }
  if (build.skipped) return;
  reviewCenter?.invalidate();
  updateWarnings([], [], failed ? build.errors || [] : []);
  updateTranslationBuildLabel();
  if (failed) {
    invalidatePdfNavigationIndex();
    renderCompileFailure(build);
    state.dismissedBuildDrawerFingerprint = "";
    elements.buildDrawer.classList.remove("hidden");
    const reason = String(build.errors?.[0] || "LaTeX 编译器没有生成可用 PDF").replace(/\s+/g, " ").slice(0, 180);
    toast(`编译失败：${reason}`, "error", 7600);
    void diagnoseBuild(build);
  } else if (!build.skipped) {
    elements.previewPanel.classList.remove("compile-failed", "compile-running");
    clearCompileDiagnosis();
  }
}

async function refreshProject({ preserveDocument = true, remoteName = state.gitRemoteName } = {}) {
  const previousRoot = state.project?.config?.projectRoot;
  const previousMainTex = state.project?.config?.mainTex;
  const query = remoteName ? `?remoteName=${encodeURIComponent(remoteName)}` : "";
  state.project = await api(`/api/bootstrap${query}`);
  reviewCenter?.invalidate();
  invalidatePdfNavigationIndex();
  const projectChanged = previousRoot && (
    state.project.config?.projectRoot !== previousRoot
    || state.project.config?.mainTex !== previousMainTex
  );
  if (projectChanged) {
    state.projectTreeInitialized = false;
    state.expandedProjectFolders.clear();
    state.sourceSearchContents.clear();
    state.sourceSearchMatches = [];
    state.buildPreviewAvailable = null;
    state.sourceFile = null;
    state.sourceHash = "";
    state.sourceEol = "\n";
    state.sourceSavedContent = "";
    state.sourceDirty = false;
    state.sourceMissing = false;
    state.fastPreviewFile = "";
    state.fastPreviewCache = [];
    invalidateReferences();
    clearCompileDiagnosis();
  }
  if (state.project.lastBuild && typeof state.project.lastBuild.previewAvailable === "boolean") {
    state.buildPreviewAvailable = state.project.lastBuild.previewAvailable;
  }
  if (state.project.setupRequired) {
    openSetup(state.project);
    return false;
  }
  updateProjectHeader();
  renderDocumentList();
  renderSectionList();
  renderSourceFileOptions(state.sourceDirty ? state.sourceFile : state.currentFile);
  if (state.previewMode === "pdf") updatePdf();
  if (state.mode === "source" && !state.sourceFile && elements.sourceFileSelect.value) {
    await loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (!preserveDocument && state.project.documents.length) {
    await loadDocument(state.project.documents[0].file);
  }
  await compileOpenedProject();
  return true;
}

async function applyProjectPayload(project, { preserveDocument = true } = {}) {
  if (!project) return false;
  const previousRoot = state.project?.config?.projectRoot;
  const previousMainTex = state.project?.config?.mainTex;
  state.project = project;
  reviewCenter?.invalidate();
  invalidatePdfNavigationIndex();
  const projectChanged = previousRoot && (
    state.project.config?.projectRoot !== previousRoot
    || state.project.config?.mainTex !== previousMainTex
  );
  if (projectChanged) {
    state.projectTreeInitialized = false;
    state.expandedProjectFolders.clear();
    state.sourceSearchContents.clear();
    state.sourceSearchMatches = [];
    state.buildPreviewAvailable = null;
    state.sourceFile = null;
    state.sourceHash = "";
    state.sourceEol = "\n";
    state.sourceSavedContent = "";
    state.sourceDirty = false;
    state.sourceMissing = false;
    state.fastPreviewFile = "";
    state.fastPreviewCache = [];
    invalidateReferences();
    clearCompileDiagnosis();
  }
  if (state.project.lastBuild && typeof state.project.lastBuild.previewAvailable === "boolean") {
    state.buildPreviewAvailable = state.project.lastBuild.previewAvailable;
  }
  updateProjectHeader();
  renderDocumentList();
  renderSectionList();
  renderSourceFileOptions(state.sourceDirty ? state.sourceFile : state.currentFile);
  if (!preserveDocument && state.project.documents?.length) {
    await loadDocument(state.project.documents[0].file);
    await compileOpenedProject();
    return true;
  }
  if (state.previewMode === "pdf") updatePdf();
  await compileOpenedProject();
  return true;
}

function scheduleProjectRefresh(delay = 160) {
  window.clearTimeout(state.projectRefreshTimer);
  state.projectRefreshTimer = window.setTimeout(async () => {
    state.projectRefreshTimer = 0;
    try {
      await refreshProject();
    } catch (error) {
      console.warn("Background project refresh failed:", error);
    }
  }, delay);
}

async function syncProjectFileTree(checkDisk = false) {
  const project = state.project;
  if (state.projectFileCheck || !project || project.setupRequired || document.hidden) return;
  const { projectRoot, mainTex } = project.config;
  if (!projectRoot || !mainTex) return;
  const params = new URLSearchParams({ revision: project.fileRevision ?? "", key: project.fileKey || "" });
  if (checkDisk) params.set("check", "1");
  state.projectFileCheck = true;
  try {
    const change = await api(`/api/project/files?${params}`);
    if (project !== state.project || change.projectRoot !== projectRoot || change.mainTex !== mainTex) return;
    project.fileRevision = change.fileRevision;
    if (!change.projectFiles) return;
    await applyProjectFileTree(project, change);
  } catch (error) {
    console.warn("Project file sync failed:", error.message);
  } finally {
    state.projectFileCheck = false;
  }
}

async function applyProjectFileTree(project, change) {
  const { fileKey, projectFiles, sourceFiles, texFiles, bibliographyFiles, documents, mainTexCandidates } = change;
  const previousPaths = new Set((project.projectFiles || []).map((entry) => entry.path));
  const nextPaths = new Set(projectFiles.map((entry) => entry.path));
  const missingMain = !texFiles.length;
  if (missingMain && !project.mainTexMissing) {
    toast(`主文件 ${project.config.mainTex} 已从项目移除，可在设置中选择新的主文件。`, "warning", 7200);
  }
  const existingDocuments = new Map((project.documents || []).map((document) => [document.file, document]));
  Object.assign(project, {
    fileKey, projectFiles, sourceFiles, texFiles, bibliographyFiles, mainTexCandidates, mainTexMissing: missingMain,
    documents: documents.map((document) => existingDocuments.get(document.file) || document)
  });
  for (const file of previousPaths) {
    if (!nextPaths.has(file)) {
      state.sourceSearchContents.delete(file);
      if (file) state.expandedProjectFolders.delete(file);
    }
  }
  const texOrBibChanged = (file) => /\.(?:tex|bib)$/i.test(file)
    && previousPaths.has(file) !== nextPaths.has(file);
  if ([...previousPaths, ...nextPaths].some(texOrBibChanged)) {
    invalidateReferences();
    invalidatePdfNavigationIndex();
  }

  const previewing = !elements.projectFilePreview.classList.contains("hidden");
  const previewRemoved = previewing && !nextPaths.has(elements.projectFilePreviewTitle.textContent);
  if (previewRemoved) {
    elements.projectFilePreviewBody.replaceChildren();
    showSourceEditor();
    updateTopbarCurrentFile();
  }

  const sourceWasMissing = state.sourceMissing;
  state.sourceMissing = Boolean(state.sourceFile && !sourceFiles.includes(state.sourceFile));
  if (state.sourceMissing) {
    window.clearTimeout(state.sourceAutosaveTimer);
    state.sourceAutosaveTimer = 0;
    if (state.sourceDirty || state.sourceSaveInFlight) {
      if (!sourceWasMissing) toast("当前源码文件已移除。未保存的文字保留在编辑器中。", "warning", 6000);
    } else {
      state.sourceMissing = false;
      state.sourceFile = null;
      state.sourceHash = "";
      state.sourceSavedContent = "";
      elements.sourceEditor.value = "";
    }
  }

  if (state.currentFile && !documents.some((item) => item.file === state.currentFile)) {
    ++state.documentLoadToken;
    const keepDraft = Array.from(elements.segmentList.querySelectorAll(".segment-textarea.changed"))
      .some((editor) => editor.closest(".segment-row")?.dataset.file === state.currentFile);
    const alreadyMissing = elements.segmentList.classList.contains("missing-project-source");
    for (const segment of state.currentDocument?.segments || []) clearSegmentSaveTimers(segment);
    if (keepDraft) {
      elements.segmentList.classList.add("missing-project-source");
      if (!alreadyMissing) toast("当前 TeX 文件已移除。未保存的段落仍可在编辑区复制。", "warning", 6000);
    } else {
      state.currentDocument = null;
      state.currentFile = null;
      state.currentSectionId = null;
      elements.segmentList.innerHTML = '<div class="empty-state">当前文件已从项目移除</div>';
      elements.currentFile.textContent = "";
      elements.fileMeta.textContent = "";
      updateTranslationDirection();
    }
  } else {
    elements.segmentList.classList.remove("missing-project-source");
  }

  const preferredSource = state.sourceFile || sourceFiles[0];
  renderSourceFileOptions(preferredSource);
  renderDocumentList();
  renderSectionList();
  updateModeButtons();
  if (sourceWasMissing || state.sourceMissing) setSourceDirty(state.sourceDirty);
  if (state.mode === "edit" && !state.currentFile && documents.length) {
    await loadDocument(documents[0].file);
  } else if (state.mode === "source" && !state.sourceFile && !(previewing && !previewRemoved) && preferredSource) {
    await loadSourceFile(preferredSource, { force: true });
  }
}

function clearMathDropTargets() {
  elements.segmentList.querySelectorAll(".math-drop-before, .math-drop-after").forEach((row) => {
    row.classList.remove("math-drop-before", "math-drop-after");
  });
}

function mathDropPosition(row, event) {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function attachMathDropTarget(row, target) {
  row.addEventListener("dragover", (event) => {
    if (!state.draggingMathBlock || state.draggingMathBlock.file !== target.file) return;
    if (target.type === "math" && target.id === state.draggingMathBlock.id) return;
    event.preventDefault();
    const position = mathDropPosition(row, event);
    row.classList.toggle("math-drop-before", position === "before");
    row.classList.toggle("math-drop-after", position === "after");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("math-drop-before", "math-drop-after");
  });
  row.addEventListener("drop", async (event) => {
    if (!state.draggingMathBlock || state.draggingMathBlock.file !== target.file) return;
    event.preventDefault();
    const dragged = state.draggingMathBlock;
    const position = mathDropPosition(row, event);
    clearMathDropTargets();
    try {
      const result = await api("/api/math-block/move", {
        method: "POST",
        body: JSON.stringify({
          file: dragged.file,
          id: dragged.id,
          sourceHash: dragged.sourceHash,
          startLine: dragged.startLine,
          target: { ...target, position },
          deferCompile: true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      toast("公式块已移动。", "success");
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      state.draggingMathBlock = null;
    }
  });
}

function segmentChineseSaveTimerKey(segment) {
  return `chinese:${segment.id}`;
}

function segmentEnglishSaveTimerKey(segment) {
  return `english:${segment.id}`;
}

function clearSegmentSaveTimers(segment) {
  for (const key of [segmentChineseSaveTimerKey(segment), segmentEnglishSaveTimerKey(segment)]) {
    window.clearTimeout(state.saveTimers.get(key));
    state.saveTimers.delete(key);
  }
}

function segmentTranslationKey(segment) {
  return `${segment.file}\0${segment.id || `${segment.index}:${segment.sourceHash}`}`;
}

function segmentTranslationLabel(segmentOrJob) {
  return `P${String(Number(segmentOrJob.index || 0) + 1).padStart(2, "0")}`;
}

function segmentTranslationJob(segment) {
  return state.segmentTranslationJobs.get(segmentTranslationKey(segment)) || null;
}

function paintSegmentTranslationRow(row, job) {
  const status = row.querySelector(".segment-status");
  const button = row.querySelector(".translate-button");
  const running = job.status === "running";
  row.dataset.translating = job.status;
  row.dataset.translateTarget = "en";
  status.textContent = job.status === "queued" ? "排队中" : running ? "正在翻译…" : "翻译失败";
  status.className = `segment-status ${job.status === "failed" ? "english-changed" : "pending"}`;
  status.title = job.message || "";
  button.title = job.status === "queued" ? "已加入翻译队列" : running ? "正在请求 AI 翻译" : "翻译失败，可修改后重试";
  setBusy(button, job.status !== "failed");
}

function updateSegmentTranslationRow(job) {
  if (state.currentDocument?.file !== job.file) return;
  const row = [...elements.segmentList.querySelectorAll(".segment-row")]
    .find((candidate) => candidate.dataset.file === job.file && candidate.dataset.segmentId === job.segmentId);
  if (!row) return;
  paintSegmentTranslationRow(row, job);
}

function applySegmentTranslationState(row, segment) {
  const job = segmentTranslationJob(segment);
  if (!job) return false;
  paintSegmentTranslationRow(row, job);
  return true;
}

function enqueueSegmentTranslation(segment, chinese, { silent = false } = {}) {
  const key = segmentTranslationKey(segment);
  const existing = state.segmentTranslationJobs.get(key);
  if (existing) {
    if (existing.status === "failed") {
      state.segmentTranslationJobs.delete(key);
    } else {
      if (!silent) toast(`${segmentTranslationLabel(existing)} 已在翻译队列中。`, "success", 2600);
      updateSegmentTranslationRow(existing);
      return false;
    }
  }
  const job = {
    key,
    segmentId: segment.id,
    file: segment.file,
    index: segment.index,
    sourceHash: segment.sourceHash,
    chinese,
    deferCompile: true,
    status: "queued",
    message: "已加入翻译队列，等待空闲翻译通道。"
  };
  state.segmentTranslationJobs.set(key, job);
  state.segmentTranslationQueue.push(key);
  updateSegmentTranslationRow(job);
  setFileTranslationProgress(0, Math.max(1, state.segmentTranslationJobs.size), `${segmentTranslationLabel(job)} · 已加入翻译队列`);
  if (!silent) toast(`${segmentTranslationLabel(job)} 已加入翻译队列。`, "success", 2800);
  runSegmentTranslationQueue();
  return true;
}

function runSegmentTranslationQueue() {
  while (
    state.activeSegmentTranslations < MAX_PARALLEL_SEGMENT_TRANSLATIONS
    && state.segmentTranslationQueue.length
  ) {
    const key = state.segmentTranslationQueue.shift();
    const job = state.segmentTranslationJobs.get(key);
    if (!job || job.status !== "queued") continue;
    void runSegmentTranslationJob(job);
  }
}

async function runSegmentTranslationJob(job) {
  state.activeSegmentTranslations += 1;
  job.status = "running";
  job.message = "正在请求 AI，完成后会写入英文 TeX。";
  updateSegmentTranslationRow(job);
  setFileTranslationProgress(1, 2, `${segmentTranslationLabel(job)} · 正在请求 AI 翻译...`);
  const slowTimer = window.setTimeout(() => {
    if (state.segmentTranslationJobs.get(job.key)?.status !== "running") return;
    job.message = "AI 仍在处理中；你可以继续把其他段落加入队列。";
    updateSegmentTranslationRow(job);
    setFileTranslationProgress(1, 2, `${segmentTranslationLabel(job)} · AI 仍在处理中，其他段落可以继续排队`, "warning");
  }, 15_000);
  try {
    const result = await api("/api/segment/translate", {
      method: "POST",
      body: JSON.stringify({
        file: job.file,
        index: job.index,
        sourceHash: job.sourceHash,
        chinese: job.chinese,
        deferCompile: job.deferCompile
      })
    });
    window.clearTimeout(slowTimer);
    state.segmentTranslationJobs.delete(job.key);
    if (state.currentFile === result.document.file) {
      state.currentDocument = result.document;
      renderSegments();
    }
    updateBuild(result.build);
    invalidateReferences();
    if (result.build && !result.build.skipped) {
      setFileTranslationProgress(2, 2, result.build.success ? `${segmentTranslationLabel(job)} · 英文与 PDF 已更新` : `${segmentTranslationLabel(job)} · 英文已写入 TeX，但编译存在错误`, result.build.success ? "" : "error");
      toast(result.build.success ? `${segmentTranslationLabel(job)} 英文段落和 PDF 已更新。` : `${segmentTranslationLabel(job)} 英文段落已写入 TeX，但 PDF 编译存在错误。`, result.build.success ? "success" : "error", 5600);
    } else {
      setFileTranslationProgress(2, 2, `${segmentTranslationLabel(job)} · 英文已写入 TeX，PDF 尚未重新编译`);
      toast(`${segmentTranslationLabel(job)} 英文段落已写入 TeX。`, "success", 4200);
    }
  } catch (error) {
    window.clearTimeout(slowTimer);
    const message = translationFailureMessage(error);
    job.status = "failed";
    job.message = message;
    updateSegmentTranslationRow(job);
    setFileTranslationProgress(0, 2, `${segmentTranslationLabel(job)} · 翻译失败：${message}`, "error");
    toast(message, "error", 6200);
    window.setTimeout(() => {
      if (state.segmentTranslationJobs.get(job.key) !== job) return;
      state.segmentTranslationJobs.delete(job.key);
      if (state.currentFile === job.file && state.currentDocument) renderSegments();
    }, 7000);
  } finally {
    window.clearTimeout(slowTimer);
    state.activeSegmentTranslations = Math.max(0, state.activeSegmentTranslations - 1);
    runSegmentTranslationQueue();
  }
}


function bindSegmentReading(row, editor, placeholder) {
  const surface = editor.closest(".segment-edit-surface");
  const syntax = surface.querySelector(".segment-syntax");
  const reader = surface.parentElement.querySelector(".segment-reading");
  const bindChips = () => reader.querySelectorAll("[data-citation-key]").forEach((chip) => citationTools.bindChip(chip, chip.dataset.citationKey));
  const updatePlaceholder = () => reader.toggleAttribute("data-empty", !editor.value);
  const render = () => {
    reader.replaceChildren(readingFragment(editor.value));
    updatePlaceholder();
    bindChips();
  };
  const highlight = () => {
    syntax.innerHTML = latexSourceHighlightHtml(editor.value, []);
    fitSegmentRow(row);
  };
  let selection = [0, 0];
  const selectionOffsets = () => {
    const current = document.getSelection();
    if (!current?.rangeCount) return selection;
    const range = current.getRangeAt(0);
    if (!reader.contains(range.startContainer) || !reader.contains(range.endContainer)) return selection;
    const source = readingSource(reader);
    selection = [source.offset(range.startContainer, range.startOffset), source.offset(range.endContainer, range.endOffset)];
    return selection;
  };
  Object.defineProperties(reader, {
    value: { get: () => editor.value },
    selectionStart: { get: () => selectionOffsets()[0] },
    selectionEnd: { get: () => selectionOffsets()[1] }
  });
  reader.setSelectionRange = (start, end) => {
    const source = readingSource(reader);
    const range = document.createRange();
    range.setStart(...source.point(start));
    range.setEnd(...source.point(end));
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    selection = [start, end];
  };
  reader.setRangeText = (text, start, end) => {
    reader.focus({ preventScroll: true });
    reader.setSelectionRange(start, end);
    const contents = document.createElement("div");
    contents.append(readingFragment(text));
    if (contents.childElementCount) document.execCommand("insertHTML", false, contents.innerHTML);
    else document.execCommand("insertText", false, text);
  };
  reader.latexOffsetFromPoint = (x, y) => {
    const range = document.caretRangeFromPoint(x, y);
    return range && reader.contains(range.startContainer)
      ? readingSource(reader).offset(range.startContainer, range.startOffset)
      : reader.selectionEnd;
  };
  reader.dataset.placeholder = placeholder;
  for (const name of ["copy", "cut"]) {
    reader.addEventListener(name, (event) => {
      const current = document.getSelection();
      if (!event.clipboardData || !current?.rangeCount || current.isCollapsed) return;
      const range = current.getRangeAt(0);
      if (!reader.contains(range.commonAncestorContainer)) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", readingSource(range.cloneContents()).value);
      if (name === "cut") document.execCommand("delete");
    });
  }
  reader.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text) reader.setRangeText(text, ...selectionOffsets());
  });
  reader.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertFromDrop") event.preventDefault();
  });
  let composing = false;
  const saveReading = () => {
    const next = readingSource(reader).value;
    if (editor.value === next) return;
    editor.value = next;
    updatePlaceholder();
    bindChips();
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  };
  reader.addEventListener("compositionstart", () => { composing = true; });
  reader.addEventListener("compositionend", () => {
    composing = false;
    saveReading();
  });
  reader.addEventListener("input", (event) => {
    if (!composing && !event.isComposing) saveReading();
  });
  const openSource = (focus = true) => {
    const [start, end] = selectionOffsets();
    reader.hidden = true;
    surface.hidden = false;
    highlight();
    editor.setSelectionRange(start, end);
    if (focus) editor.focus({ preventScroll: true });
  };
  const closeSource = (focus = true) => {
    if (surface.hidden) return;
    const { selectionStart: start, selectionEnd: end } = editor;
    if (readingSource(reader).value !== editor.value) render();
    surface.hidden = true;
    reader.hidden = false;
    if (focus) {
      reader.focus({ preventScroll: true });
      reader.setSelectionRange(start, end);
    }
  };
  editor.addEventListener("input", () => { if (!surface.hidden) highlight(); });
  attachCitationTarget(reader);
  attachCitationTarget(editor);
  render();
  return { reader, openSource, closeSource, render };
}

function translationLayout() {
  const layout = state.translationLayout;
  const toolbar = document.querySelector(".preview-toolbar");
  document.querySelectorAll("button[data-translation-layout]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.translationLayout === layout));
  });
  elements.workspace.dataset.translationLayout = layout;
  const editing = state.mode === "edit";
  if (editing) document.querySelector("#translationPdfToolbar").append(toolbar);
  else document.querySelector(".topbar").insertBefore(toolbar, document.querySelector(".top-actions"));
  setBilingualLayout(layout === "wide" ? "horizontal" : "vertical", { persist: false });
  updateTranslationBuildLabel();
  schedulePdfPanelResize();
}

function chooseTranslationLayout(layout) {
  state.translationLayout = layout;
  localStorage.setItem("paperBridge.translationLayout", layout);
  translationLayout();
}

function setTranslationExpanded(expanded) {
  if (state.translationExpanded === expanded) return;
  state.translationExpanded = expanded;
  elements.workspace.classList.toggle("translation-expanded", expanded);
  const button = document.querySelector("#translationExpandButton");
  button.title = expanded ? "恢复 PDF 预览" : "完全展开编辑区";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(expanded));
  button.querySelector("[data-lucide], svg").setAttribute("data-lucide", expanded ? "minimize-2" : "maximize-2");
  refreshIcons();
  schedulePdfPanelResize();
}

function applyReadingSettings() {
  for (const [name, css, unit] of [["Size", "size", "px"], ["Leading", "leading", ""], ["Width", "width", "em"], ["Font", "", ""]]) {
    const control = document.querySelector("#translationReading" + name);
    const value = localStorage.getItem("paperBridge.translationReading" + name);
    if ([...control.options].some((option) => option.value === value)) control.value = value;
    if (css) elements.workspace.style.setProperty("--reading-" + css, control.value === "full" ? "100%" : control.value + unit);
    else elements.workspace.dataset.readingFont = control.value;
  }
  fitAllSegmentRows();
}

function updateTranslationDirection() {
  const english = state.translationDirection === "en";
  elements.translateSectionButton.setAttribute("aria-pressed", String(english));
  document.querySelector("#translateFileButton").setAttribute("aria-pressed", String(!english));
  const action = document.querySelector("#translateScopeButton");
  const segments = state.currentDocument?.segments || [];
  const busy = !english && state.fileTranslationJobs.has(state.currentFile);
  action.disabled = !segments.length || busy || (english && !segments.some((segment) => belongsToTranslationSection(segment, state.currentSectionId)));
  const label = busy ? "翻译中…" : english ? "翻译本节" : "翻译当前文件";
  action.querySelector("span").textContent = label;
  action.title = label;
  action.setAttribute("aria-label", label);
}

function createSegmentRow(segment) {
  const row = document.createElement("article");
  row.className = "segment-row";
  row.dataset.segmentId = segment.id;
  row.dataset.file = segment.file;
  row.dataset.segmentIndex = String(segment.index);
  row.dataset.segmentSourceHash = segment.sourceHash;
  row.dataset.startLine = segment.startLine;
  row.dataset.endLine = segment.endLine;
  row.innerHTML = `
    <div class="segment-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status"></span>
      </div>
      <div class="segment-actions">
        <button class="mini-button translate-button" type="button" title="按所选方向翻译本段（Ctrl+Enter）"><i data-lucide="languages"></i><span>翻译</span></button>
        <details class="segment-menu">
          <summary class="mini-button" title="段落操作" aria-label="段落操作"><i data-lucide="ellipsis"></i></summary>
          <div class="segment-menu-items">
            <button class="mini-button locate-segment-button" type="button" title="高亮对应 PDF 位置（Alt+Enter）"><i data-lucide="locate-fixed"></i><span>定位到 PDF</span></button>
            <button class="mini-button segment-source-button" type="button" aria-pressed="false"><i data-lucide="code-xml"></i><span>编辑段落源码</span></button>
            <button class="mini-button add-paragraph-button" type="button" title="在此段下方插入（Alt+Insert）"><i data-lucide="plus"></i><span>在下方插入</span></button>
            <button class="mini-button save-english-button" type="button" title="保存英文到 TeX（Ctrl+S）"><i data-lucide="save"></i><span>保存英文</span></button>
            <button class="mini-button revert-button" type="button" title="恢复已加载的英文（Ctrl+Alt+R）"><i data-lucide="undo-2"></i><span>还原英文</span></button>
            <button class="mini-button delete-paragraph-button danger" type="button" title="删除本段（Alt+Shift+Delete），可用 Ctrl+Z 撤销"><i data-lucide="trash-2"></i><span>删除本段</span></button>
          </div>
        </details>
        <button class="translate-chinese-button" hidden type="button" aria-label="翻译本段到中文"></button>
      </div>
    </div>
    <div class="segment-columns">
      <div class="segment-editor">
        <span class="segment-language-label">中文工作稿</span>
        <div class="segment-reading chinese" lang="zh-CN" role="textbox" aria-multiline="true" aria-label="中文工作稿" contenteditable="true" spellcheck="false"></div>
        <div class="reading-skeleton" aria-hidden="true"></div>
        <div class="segment-edit-surface" hidden>
          <pre class="segment-syntax chinese" aria-hidden="true"></pre>
          <textarea class="segment-textarea chinese" lang="zh-CN" aria-label="中文工作稿" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="segment-editor">
        <span class="segment-language-label">英文 LaTeX</span>
        <div class="segment-reading english" lang="en" role="textbox" aria-multiline="true" aria-label="英文 LaTeX" contenteditable="true" spellcheck="false"></div>
        <div class="reading-skeleton" aria-hidden="true"></div>
        <div class="segment-edit-surface" hidden>
          <pre class="segment-syntax english" aria-hidden="true"></pre>
          <textarea class="segment-textarea english" lang="en" aria-label="英文 LaTeX" spellcheck="false"></textarea>
        </div>
      </div>
    </div>
    <div class="segment-draft-diff" hidden></div>
  `;

  const status = row.querySelector(".segment-status");
  const chinese = row.querySelector("textarea.chinese");
  const english = row.querySelector("textarea.english");
  const addParagraphButton = row.querySelector(".add-paragraph-button");
  const translateChineseButton = row.querySelector(".translate-chinese-button");
  const translateButton = row.querySelector(".translate-button");
  const saveEnglishButton = row.querySelector(".save-english-button");
  const revertButton = row.querySelector(".revert-button");
  const deleteParagraphButton = row.querySelector(".delete-paragraph-button");

  row.querySelector(".segment-index").textContent = `P${String(segment.index + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${segment.startLine}–${segment.endLine}`;
  status.textContent = statusLabel(segment.translationStatus);
  status.className = `segment-status ${segment.translationStatus}`;
  chinese.value = segment.chinese || "";
  english.value = segment.english;
  const chineseReading = bindSegmentReading(row, chinese, "点击填写中文工作稿");
  const englishReading = bindSegmentReading(row, english, "点击填写英文 LaTeX");
  const sourceButton = row.querySelector(".segment-source-button");
  let sourceOpen = false;
  const showSource = (open, focus = state.citationTarget?.element) => {
    const chineseFocused = focus === chinese || focus === chineseReading.reader;
    sourceOpen = open;
    sourceButton.setAttribute("aria-pressed", String(open));
    sourceButton.querySelector("span").textContent = open ? "返回段落编辑" : "编辑段落源码";
    if (open) {
      chineseReading.openSource(chineseFocused);
      englishReading.openSource(!chineseFocused);
    } else {
      chineseReading.closeSource(chineseFocused);
      englishReading.closeSource(!chineseFocused);
    }
  };
  sourceButton.addEventListener("click", () => showSource(!sourceOpen));
  chinese.activateCitationEditor = () => { if (!sourceOpen) showSource(true, chinese); };
  english.activateCitationEditor = () => { if (!sourceOpen) showSource(true, english); };
  const diff = row.querySelector(".segment-draft-diff");
  let baseline = segment.previousChinese;
  const updateDraftDiff = () => describeDraftDiff(diff, baseline, chinese.value);
  updateDraftDiff();
  const locate = (reveal) => void locateTranslationBlock(row, { reveal });
  row.querySelector(".locate-segment-button").addEventListener("click", () => locate(true));
  row.addEventListener("click", (event) => {
    if (!event.target.closest(".segment-actions, textarea") && document.getSelection()?.isCollapsed) locate(false);
  });
  row.addEventListener("keydown", (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key === "Enter") translateButton.click();
    else if (event.altKey && event.key === "Enter") locate(true);
    else if (event.altKey && event.key === "Insert") addParagraphButton.click();
    else if (command && event.altKey && event.key.toLowerCase() === "r") revertButton.click();
    else if (event.altKey && event.shiftKey && event.key === "Delete") deleteParagraphButton.click();
    else if (event.key === "Escape" && sourceOpen && event.target.matches(".segment-textarea")) showSource(false, event.target);
    else return;
    event.preventDefault();
  });
  const saveShortcut = (event) => {
    if (event.isComposing) return;
    if ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopPropagation();
    void saveEnglish(false);
  };
  english.addEventListener("keydown", saveShortcut);
  englishReading.reader.addEventListener("keydown", saveShortcut);
  const menu = row.querySelector(".segment-menu");
  menu.addEventListener("click", (event) => {
    if (event.target.closest("button")) menu.open = false;
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  if (segment.chinese) translateChineseButton.title = "重新翻译本段到中文";
  applySegmentTranslationState(row, segment);
  let englishSaveInFlight = false;
  let englishSavePending = false;
  const latestSourceHash = () => row.dataset.segmentSourceHash || segment.sourceHash;
  const markEnglishChanged = (message = "英文待保存") => {
    english.classList.add("changed");
    status.textContent = message;
    status.className = "segment-status english-changed";
  };
  const refreshSegmentSnapshot = (document) => {
    const nextSegment = document?.segments?.find((item) => item.index === segment.index);
    if (!nextSegment) return null;
    segment.id = nextSegment.id;
    segment.sourceHash = nextSegment.sourceHash;
    segment.english = nextSegment.english;
    segment.chinese = nextSegment.chinese;
    segment.translationStatus = nextSegment.translationStatus;
    baseline = nextSegment.previousChinese;
    updateDraftDiff();
    row.dataset.startLine = nextSegment.startLine;
    row.dataset.endLine = nextSegment.endLine;
    row.dataset.segmentId = nextSegment.id;
    row.dataset.segmentSourceHash = nextSegment.sourceHash;
    return nextSegment;
  };
  const scheduleEnglishAutosave = (delay = 950) => {
    const key = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(key));
    if (elements.segmentList.classList.contains("missing-project-source") && state.currentFile === segment.file) return;
    state.saveTimers.set(key, window.setTimeout(() => {
      state.saveTimers.delete(key);
      void saveEnglish(false, { automatic: true });
    }, delay));
  };

  translateChineseButton.addEventListener("click", async () => {
    row.dataset.translating = "running";
    row.dataset.translateTarget = "zh";
    status.textContent = "正在翻译…";
    status.className = "segment-status pending";
    setBusy(translateButton, true);
    setBusy(translateChineseButton, true);
    setFileTranslationProgress(0, 1, `P${String(segment.index + 1).padStart(2, "0")} · 正在翻译本段...`);
    try {
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          sectionId: segment.sectionId,
          segmentIds: [segment.id],
          force: true
        })
      });
      if (state.currentFile === result.document.file) {
        state.currentDocument = result.document;
        renderSegments();
      }
      const translated = result.progress?.translated || 0;
      setFileTranslationProgress(1, 1, translated ? "本段中文已生成" : "模型未返回本段翻译", translated ? "" : "warning");
      toast(translated ? "已仅翻译当前段落。" : "模型没有返回当前段落的有效中文翻译。", translated ? "success" : "error", 5200);
    } catch (error) {
      setFileTranslationProgress(0, 1, `本段翻译失败：${error.message}`, "error");
      toast(error.message, "error", 5600);
    } finally {
      delete row.dataset.translating;
      status.textContent = statusLabel(segment.translationStatus);
      status.className = "segment-status " + segment.translationStatus;
      setBusy(translateButton, false);
      setBusy(translateChineseButton, false);
    }
  });

  chinese.addEventListener("input", () => {
    updateHeaderSaveState("dirty");
    baseline ??= segment.chinese || "";
    updateDraftDiff();
    chinese.classList.add("changed");
    status.textContent = "需重译";
    status.className = "segment-status english-changed";
    if (elements.segmentList.classList.contains("missing-project-source") && state.currentFile === segment.file) return;
    const key = segmentChineseSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(key));
    state.saveTimers.set(key, window.setTimeout(async () => {
      state.saveTimers.delete(key);
      const requestedChinese = chinese.value;
      try {
        const saved = await api("/api/segment/chinese", {
          method: "POST",
          body: JSON.stringify({
            file: segment.file,
            index: segment.index,
            sourceHash: latestSourceHash(),
            chinese: requestedChinese
          })
        });
        if (!saved.stale) {
          if (chinese.value === requestedChinese) chinese.classList.remove("changed");
          segment.chinese = requestedChinese;
          segment.previousChinese = baseline;
          segment.translationStatus = "pending";
          if (state.currentFile === segment.file && state.currentDocument?.segments.includes(segment)) {
            const summary = state.project?.documents?.find((entry) => entry.file === segment.file);
            if (summary) summary.translated = state.currentDocument.segments.filter((item) => item.chinese).length;
            renderTranslationSections(state.currentDocument);
            updateTranslationProgress();
          }
        }
      } catch (error) {
        toast(error.message, "error");
      }
    }, 700));
  });

  const commentParagraph = async (trigger = null) => {
    const target = state.citationTarget?.element;
    const englishSelection = (target === english || target === englishReading.reader) && target.selectionEnd > target.selectionStart
      ? { selectionStart: target.selectionStart, selectionEnd: target.selectionEnd }
      : null;
    const chineseSelection = (target === chinese || target === chineseReading.reader) && target.selectionEnd > target.selectionStart;
    if (!englishSelection && chineseSelection) {
      toast("中文选区无法安全定位到 TeX 源码；请在右侧英文 LaTeX 中选择对应内容，或取消选择后注释整段。", "warning", 6200);
      return;
    }
    clearSegmentSaveTimers(segment);
    setBusy(trigger, true);
    try {
      const result = await api("/api/segment/comment", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash(),
          chinese: chinese.value,
          deferCompile: true,
          ...(englishSelection || {})
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      invalidateReferences();
      toast("本段已注释，TeX 源码仍然保留。", "success", 4600);
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(trigger, false);
    }
  };

  row.commentParagraphAction = commentParagraph;
  row.addEventListener("keydown", (event) => {
    if (event.isComposing || !event.target.matches(".segment-textarea, .segment-reading")) return;
    if (event.key !== "/" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    void commentParagraph();
  });

  english.addEventListener("input", () => {
    updateHeaderSaveState("dirty");
    fitSegmentRow(row);
    markEnglishChanged("英文待自动保存");
    englishSavePending = englishSaveInFlight;
    scheduleEnglishAutosave();
  });

  translateButton.addEventListener("click", () => {
    if (state.translationDirection === "zh") {
      translateChineseButton.click();
      return;
    }
    if (!chinese.value.trim()) {
      toast("请先填写中文工作稿。", "error");
      (sourceOpen ? chinese : chineseReading.reader).focus();
      return;
    }
    enqueueSegmentTranslation({ ...segment, sourceHash: latestSourceHash() }, chinese.value);
  });

  async function saveEnglish(force = false, options = {}) {
    const automatic = options.automatic === true;
    const timerKey = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(timerKey));
    state.saveTimers.delete(timerKey);
    if (englishSaveInFlight) {
      englishSavePending = true;
      if (!automatic) toast("英文正在保存，最新修改会继续写入 TeX。", "warning", 3000);
      return false;
    }

    const deferCompile = true;
    const requestedEnglish = english.value;
    let saved = false;
    englishSaveInFlight = true;
    setBusy(saveEnglishButton, true);
    status.textContent = automatic ? "英文自动保存中..." : "英文保存中...";
    status.className = "segment-status pending";
    try {
      const result = await api("/api/segment/english", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash(),
          english: requestedEnglish,
          chinese: chinese.value,
          deferCompile,
          force
        })
      });
      state.currentDocument = result.document;
      const nextSegment = refreshSegmentSnapshot(result.document);
      await refreshLoadedSourceFromDisk(result.document.file);
      updateBuild(result.build);
      invalidateReferences();
      if (english.value === requestedEnglish) {
        english.classList.remove("changed");
        const translationStatus = nextSegment?.translationStatus || segment.translationStatus;
        status.textContent = automatic && translationStatus === "synced" ? "英文已自动保存" : statusLabel(translationStatus);
        status.className = `segment-status ${translationStatus}`;
      } else {
        englishSavePending = true;
        markEnglishChanged("英文待继续保存");
      }
      if (!automatic && result.build && !result.build.skipped) {
        toast(result.build.success ? "英文修改已写入 TeX，PDF 已更新。" : "英文修改已写入 TeX，但编译仍有错误。", result.build.success ? "success" : "error");
      } else if (!automatic) {
        toast("英文修改已写入 TeX。需要更新 PDF 时请点击“编译全文”。", "success");
      }
      saved = true;
    } catch (error) {
      markEnglishChanged("英文保存失败");
      toast(error.message, "error", 5200);
    } finally {
      englishSaveInFlight = false;
      setBusy(saveEnglishButton, false);
      if (englishSavePending) {
        englishSavePending = false;
        scheduleEnglishAutosave(250);
      }
    }
    return saved;
  }

  saveEnglishButton.addEventListener("click", () => saveEnglish(false));
  addParagraphButton.addEventListener("click", () => openParagraphDialog(segment));
  revertButton.addEventListener("click", () => {
    const timerKey = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(timerKey));
    state.saveTimers.delete(timerKey);
    englishSavePending = false;
    if (!state.saveTimers.size && !state.pendingWrites) updateHeaderSaveState("saved");
    english.value = segment.english;
    englishReading.render();
    if (!english.closest(".segment-edit-surface").hidden) {
      english.closest(".segment-edit-surface").querySelector(".segment-syntax").innerHTML = latexSourceHighlightHtml(english.value, []);
    }
    fitSegmentRow(row);
    english.classList.remove("changed");
    status.textContent = statusLabel(segment.translationStatus);
    status.className = `segment-status ${segment.translationStatus}`;
  });
  deleteParagraphButton.addEventListener("click", async () => {
    const confirmed = window.confirm("删除当前段落会同时移除英文 TeX 内容和中文工作稿，可在之后按 Ctrl+Z 撤销。继续吗？");
    if (!confirmed) return;
    clearSegmentSaveTimers(segment);
    setBusy(deleteParagraphButton, true);
    try {
      const result = await api("/api/segment/delete", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash(),
          deferCompile: true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      invalidateReferences();
      state.sourceSearchContents.delete(segment.file);
      invalidatePdfNavigationIndex();
      toast("段落已删除。", "success");
    } catch (error) {
      toast(error.payload?.code === "LAST_PARAGRAPH" ? "每个文件至少需要保留一个可编辑正文段落。" : error.message, "error", 5200);
    } finally {
      setBusy(deleteParagraphButton, false);
    }
  });
  attachMathDropTarget(row, {
    type: "segment",
    file: segment.file,
    index: segment.index,
    sourceHash: latestSourceHash()
  });
  return row;
}

function fitMathBlockEditor(editor) {
  editor.style.height = "auto";
  editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 128), 420)}px`;
}

function createMathBlockRow(block) {
  const row = document.createElement("article");
  row.className = "math-row";
  row.dataset.file = block.file;
  row.dataset.mathId = block.id;
  row.dataset.mathStartLine = String(block.startLine);
  row.dataset.startLine = block.startLine;
  row.dataset.endLine = block.endLine;
  row.innerHTML = `
    <div class="segment-header math-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status synced">公式 TeX</span>
      </div>
      <div class="segment-actions">
        <button class="mini-button math-drag-handle" type="button" draggable="true" title="拖动公式到其他段落之间"><i data-lucide="grip-vertical"></i></button>
        <button class="mini-button save-math-button" type="button" title="保存公式 TeX"><i data-lucide="save"></i></button>
        <button class="mini-button revert-math-button" type="button" title="恢复已加载的公式"><i data-lucide="undo-2"></i></button>
      </div>
    </div>
    <button type="button" class="math-reading" title="展开编辑公式" aria-label="展开编辑公式" aria-expanded="false"></button>
    <div class="math-editor" hidden>
      <textarea class="math-source-editor" spellcheck="false" aria-label="公式 TeX 源码"></textarea>
    </div>
  `;

  const status = row.querySelector(".segment-status");
  const editor = row.querySelector(".math-source-editor");
  const dragHandle = row.querySelector(".math-drag-handle");
  const saveButton = row.querySelector(".save-math-button");
  const revertButton = row.querySelector(".revert-math-button");

  row.querySelector(".segment-index").textContent = `F${String((block.index || 0) + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${block.startLine}-${block.endLine}`;
  editor.value = block.source || "";
  const reader = row.querySelector(".math-reading");
  const mathEditor = row.querySelector(".math-editor");
  renderDisplayFormula(reader, editor.value);
  const toggle = (open) => {
    mathEditor.hidden = !open;
    reader.setAttribute("aria-expanded", String(open));
    reader.title = open ? "折叠公式编辑器" : "展开编辑公式";
    reader.setAttribute("aria-label", reader.title);
    if (open) {
      fitMathBlockEditor(editor);
      editor.focus({ preventScroll: true });
    } else {
      renderDisplayFormula(reader, editor.value);
    }
  };
  reader.addEventListener("click", () => toggle(mathEditor.hidden));
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      toggle(false);
      reader.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      saveButton.click();
    }
  });
  row.addEventListener("click", (event) => {
    if (!event.target.closest(".segment-actions, textarea")) void locateTranslationBlock(row);
  });

  dragHandle.addEventListener("dragstart", (event) => {
    state.draggingMathBlock = {
      file: block.file,
      id: block.id,
      sourceHash: block.sourceHash,
      startLine: block.startLine
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", block.id);
    row.classList.add("dragging");
  });

  dragHandle.addEventListener("dragend", () => {
    state.draggingMathBlock = null;
    row.classList.remove("dragging");
    clearMathDropTargets();
  });

  editor.addEventListener("input", () => {
    editor.classList.add("changed");
    status.textContent = "公式待保存";
    status.className = "segment-status english-changed";
    fitMathBlockEditor(editor);
  });

  revertButton.addEventListener("click", () => {
    editor.value = block.source || "";
    editor.classList.remove("changed");
    status.textContent = "公式 TeX";
    status.className = "segment-status synced";
    fitMathBlockEditor(editor);
  });

  saveButton.addEventListener("click", async () => {
    const deferCompile = true;
    setBusy(saveButton, true);
    try {
      const result = await api("/api/math-block", {
        method: "POST",
        body: JSON.stringify({
          file: block.file,
          id: block.id,
          sourceHash: block.sourceHash,
          startLine: block.startLine,
          source: editor.value,
          deferCompile
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      toast(
        result.build && !result.build.skipped
          ? result.build.success ? "公式已保存，PDF 已更新。" : "公式已保存，但编译仍有错误。"
          : "公式已保存。需要更新正式 PDF 时请点击“编译全文”。",
        result.build && !result.build.success ? "error" : "success",
        5200
      );
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(saveButton, false);
    }
  });

  attachMathDropTarget(row, {
    type: "math",
    file: block.file,
    id: block.id,
    sourceHash: block.sourceHash,
    startLine: block.startLine
  });
  return row;
}

function tableMatrix(block) {
  return (block.rows || []).map((row) => row.cells.map((cell) => cell.editableText ?? cell.text ?? ""));
}

function createEditableTable(matrix, className, { onContextMenu } = {}) {
  const table = document.createElement("table");
  table.className = `editable-paper-table ${className}`;
  const tbody = document.createElement("tbody");
  matrix.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    row.forEach((cell, columnIndex) => {
      const td = document.createElement("td");
      td.dataset.rowIndex = String(rowIndex);
      td.dataset.columnIndex = String(columnIndex);
      const textarea = document.createElement("textarea");
      textarea.value = cell;
      textarea.rows = 1;
      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(34, textarea.scrollHeight)}px`;
      });
      window.requestAnimationFrame(() => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(34, textarea.scrollHeight)}px`;
      });
      textarea.addEventListener("focus", () => {
        table.querySelectorAll("td.table-cell-selected").forEach((item) => item.classList.remove("table-cell-selected"));
        td.classList.add("table-cell-selected");
      });
      textarea.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        table.querySelectorAll("td.table-cell-selected").forEach((item) => item.classList.remove("table-cell-selected"));
        td.classList.add("table-cell-selected");
        onContextMenu?.({ event, rowIndex, columnIndex, table });
      });
      td.append(textarea);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  return table;
}

function readEditableTable(table) {
  if (!table) return [];
  return [...table.querySelectorAll("tr")].map((row) => (
    [...row.querySelectorAll("textarea")].map((textarea) => textarea.value.trim())
  ));
}

function closeTableContextMenu() {
  document.querySelector(".table-context-menu")?.remove();
}

function openTableContextMenu(event, { rowIndex, columnIndex, table, apply }) {
  closeTableContextMenu();
  const menu = document.createElement("div");
  menu.className = "table-context-menu citation-context-menu";
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 250)}px`;
  const actions = [
    ["row-before", "上方插入一行", "rows-3"],
    ["row-after", "下方插入一行", "rows-3"],
    ["row-delete", "删除这一行", "minus"],
    ["column-before", "左侧插入一列", "columns-3"],
    ["column-after", "右侧插入一列", "columns-3"],
    ["column-delete", "删除这一列", "columns-3"]
  ];
  for (const [action, label, icon] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
    button.addEventListener("click", () => {
      closeTableContextMenu();
      apply(action, rowIndex, columnIndex, table);
    });
    menu.append(button);
  }
  menu.addEventListener("pointerdown", (innerEvent) => innerEvent.stopPropagation());
  document.body.append(menu);
  refreshIcons();
  window.setTimeout(() => {
    document.addEventListener("pointerdown", closeTableContextMenu, { once: true });
    document.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Escape") closeTableContextMenu();
    }, { once: true });
  }, 0);
}

function createTableBlockRow(block) {
  const row = document.createElement("article");
  row.className = "table-row";
  row.dataset.file = block.file;
  row.dataset.tableId = block.id;
  row.innerHTML = `
    <div class="segment-header table-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status synced">表格</span>
      </div>
      <div class="segment-actions">
        <button class="mini-button save-table-button" type="button" title="保存表格"><i data-lucide="save"></i></button>
        <button class="mini-button revert-table-button" type="button" title="恢复已加载的表格"><i data-lucide="undo-2"></i></button>
      </div>
    </div>
    <div class="table-editor">
      <div class="table-editor-toolbar">
        <div class="table-editor-label">英文表格</div>
        <span class="table-editor-note">右键单元格可添加或删除行列</span>
      </div>
      <div class="table-editor-scroll english-table"></div>
    </div>
  `;
  const status = row.querySelector(".segment-status");
  const saveButton = row.querySelector(".save-table-button");
  const revertButton = row.querySelector(".revert-table-button");
  const englishShell = row.querySelector(".english-table");
  let workingRows = tableMatrix(block);

  const markTableDirty = () => {
    status.textContent = "表格待保存";
    status.className = "segment-status english-changed";
  };

  const updateTableShape = (action, rowIndex, columnIndex, table) => {
    const current = readEditableTable(table);
    const columnCount = Math.max(1, ...current.map((line) => line.length));
    const rows = current.map((line) => Array.from({ length: columnCount }, (_value, index) => line[index] || ""));
    if (action === "row-delete") {
      if (rows.length <= 1) return toast("表格至少需要保留一行。", "warning", 3200);
      rows.splice(rowIndex, 1);
    } else if (action === "row-before" || action === "row-after") {
      rows.splice(action === "row-before" ? rowIndex : rowIndex + 1, 0, Array(columnCount).fill(""));
    } else if (action === "column-delete") {
      if (columnCount <= 1) return toast("表格至少需要保留一列。", "warning", 3200);
      rows.forEach((line) => line.splice(columnIndex, 1));
    } else {
      const insertAt = action === "column-before" ? columnIndex : columnIndex + 1;
      rows.forEach((line) => line.splice(insertAt, 0, ""));
    }
    workingRows = rows;
    renderTables();
    markTableDirty();
  };

  const renderTables = () => {
    englishShell.replaceChildren(createEditableTable(workingRows, "english", { onContextMenu: ({ event, rowIndex, columnIndex, table }) => (
      openTableContextMenu(event, { rowIndex, columnIndex, table, apply: updateTableShape })
    ) }));
    status.textContent = "表格";
    status.className = "segment-status synced";
  };

  row.querySelector(".segment-index").textContent = `T${String((block.index || 0) + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${block.startLine}-${block.endLine}`;
  renderTables();
  row.addEventListener("input", (event) => {
    if (!event.target.closest(".table-editor")) return;
    markTableDirty();
  });

  revertButton.addEventListener("click", () => {
    workingRows = tableMatrix(block);
    renderTables();
  });

  saveButton.addEventListener("click", async () => {
    setBusy(saveButton, true);
    try {
      const result = await api("/api/table-block", {
        method: "POST",
        body: JSON.stringify({
          file: block.file,
          id: block.id,
          sourceHash: block.sourceHash,
          startLine: block.startLine,
          englishRows: readEditableTable(englishShell.querySelector("table")),
          deferCompile: true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      toast("表格已保存。", "success");
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(saveButton, false);
    }
  });
  return row;
}

function openParagraphDialog(segment) {
  state.paragraphAnchor = segment;
  elements.newParagraphChinese.value = "";
  document.querySelector('input[name="newParagraphPosition"][value="after"]').checked = true;
  document.querySelector("#paragraphAnchorLabel").textContent = `相对于 P${String(segment.index + 1).padStart(2, "0")} 插入`;
  if (!elements.paragraphDialog.open) elements.paragraphDialog.showModal();
  window.requestAnimationFrame(() => elements.newParagraphChinese.focus());
}

function closeParagraphDialog() {
  state.paragraphAnchor = null;
  if (elements.paragraphDialog.open) elements.paragraphDialog.close();
}

async function submitNewParagraph(event) {
  event.preventDefault();
  const anchor = state.paragraphAnchor;
  if (!anchor) return;
  const chinese = elements.newParagraphChinese.value.trim();
  if (!chinese) {
    toast("请先输入新增段落的中文或英文工作稿。", "error");
    elements.newParagraphChinese.focus();
    return;
  }
  const button = document.querySelector("#addParagraphSubmitButton");
  const position = document.querySelector('input[name="newParagraphPosition"]:checked').value;
  setBusy(button, true);
  try {
    const result = await api("/api/segment/add", {
      method: "POST",
      body: JSON.stringify({
        file: anchor.file,
        index: anchor.index,
        sourceHash: anchor.sourceHash,
        chinese,
        position
      })
    });
    state.currentDocument = result.document;
    closeParagraphDialog();
    renderSegments();
    updateBuild(result.build);
    invalidateReferences();
    scheduleProjectRefresh();
    toast("新段落已生成并插入。", "success");
  } catch (error) {
    toast(
      error.payload?.code === "INVALID_PARAGRAPH"
        ? "AI 没有返回可插入的英文正文段落，请重试或把新增内容写成一个完整段落。"
        : error.message,
      "error",
      6200
    );
  } finally {
    setBusy(button, false);
  }
}

function figureAnchorText(anchor) {
  if (!anchor) return "选择图片和排版位置";
  if (anchor.type === "source") return `${anchor.file} · 当前 TeX 光标位置`;
  return `${anchor.file} · P${String(Number(anchor.index || 0) + 1).padStart(2, "0")} 后方`;
}

function figureProjectImages() {
  return (state.project?.projectFiles || [])
    .filter((entry) => entry.type === "file")
    .filter((entry) => PROJECT_PREVIEW_EXTENSIONS.has(String(entry.extension || "").toLowerCase()) || String(entry.extension || "").toLowerCase() === ".eps")
    .map((entry) => entry.path);
}

function figureLayoutOptions() {
  return {
    span: elements.figureSpanInput.value,
    alignment: elements.figureAlignmentInput.value,
    arrangement: elements.figureArrangementInput.value,
    columns: Number(elements.figureColumnsInput.value || 1),
    position: elements.figurePositionInput.value
  };
}

function syncFigureImageInput() {
  elements.figureImagesInput.value = state.figureSlots.filter(Boolean).join("\n");
}

function renderInsertTableGrid() {
  const rows = Math.min(100, Math.max(1, Number(elements.insertTableRows?.value) || 1));
  const columns = Math.min(24, Math.max(1, Number(elements.insertTableColumns?.value) || 1));
  if (elements.insertTableRows) elements.insertTableRows.value = String(rows);
  if (elements.insertTableColumns) elements.insertTableColumns.value = String(columns);
  if (!elements.insertTableGrid) return;
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const row = document.createElement("tr");
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const cell = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.dataset.row = String(rowIndex);
      input.dataset.column = String(columnIndex);
      input.placeholder = `${rowIndex + 1}, ${columnIndex + 1}`;
      cell.append(input);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  elements.insertTableGrid.replaceChildren(table);
}

function readInsertTableRows() {
  const rows = [];
  elements.insertTableGrid?.querySelectorAll("tr").forEach((row) => {
    rows.push([...row.querySelectorAll("input")].map((input) => input.value));
  });
  return rows;
}

async function ensureFormulaEditor() {
  if (!elements.formulaMathfieldShell || state.formulaMathfield) return state.formulaMathfield;
  try {
    const module = await import("/vendor/mathlive/mathlive.min.mjs");
    if (!customElements.get("math-field") && module.MathfieldElement) customElements.define("math-field", module.MathfieldElement);
    const field = document.createElement("math-field");
    field.setAttribute("virtual-keyboard-mode", "manual");
    field.setAttribute("aria-label", "可视化公式编辑器");
    field.value = elements.insertFormulaLatex?.value || "x^2";
    field.addEventListener("input", () => {
      if (elements.insertFormulaLatex) elements.insertFormulaLatex.value = field.getValue?.() || field.value || "";
    });
    elements.formulaMathfieldShell.replaceChildren(field);
    state.formulaMathfield = field;
    const buttons = [
      ["分式", "\\frac{#@}{#?}"], ["根号", "\\sqrt{#0}"], ["上标", "#@^{#?}"], ["下标", "#@_{#?}"],
      ["积分", "\\int_{#?}^{#?} #0"], ["求和", "\\sum_{#?}^{#?} #0"], ["矩阵", "\\begin{bmatrix}#0 & #0\\\\#0 & #0\\end{bmatrix}"],
      ["×", "\\times"], ["≤", "\\le"], ["≥", "\\ge"]
    ];
    elements.formulaPalette?.replaceChildren(...buttons.map(([label, latex]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = latex;
      button.addEventListener("click", () => field.executeCommand?.(["insert", latex]));
      return button;
    }));
    field.addEventListener("focusin", () => {
      if (module.mathVirtualKeyboard) {
        module.mathVirtualKeyboard.layouts = ["numeric", "symbols", "greek"];
        module.mathVirtualKeyboard.visible = true;
      }
    });
    return field;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.className = "formula-fallback-editor";
    fallback.placeholder = "例如：\\frac{a}{b} + \\sqrt{x}";
    fallback.value = elements.insertFormulaLatex?.value || "";
    fallback.addEventListener("input", () => { if (elements.insertFormulaLatex) elements.insertFormulaLatex.value = fallback.value; });
    elements.formulaMathfieldShell.replaceChildren(fallback);
    state.formulaMathfield = fallback;
    return fallback;
  }
}

function syncStructureDialogType(type = elements.structureTypeInput?.value || "figure") {
  state.structureType = type;
  const isFigure = type === "figure";
  const isTable = type === "table";
  elements.figureOptions?.classList.toggle("hidden", !isFigure);
  elements.tableOptions?.classList.toggle("hidden", !isTable);
  elements.formulaOptions?.classList.toggle("hidden", type !== "formula");
  if (elements.structureDialogTitle) elements.structureDialogTitle.textContent = isFigure ? "插入图片" : isTable ? "插入表格" : "插入公式";
  if (elements.insertFigureSubmitButton) {
    elements.insertFigureSubmitButton.querySelector("span").textContent = `生成并插入${isFigure ? "" : isTable ? "表格" : "公式"}`;
  }
  if (type === "table") renderInsertTableGrid();
  if (type === "formula") void ensureFormulaEditor();
}

function renderFigureGrid() {
  if (!elements.figureGrid) return;
  const rawCount = String(elements.figureImageCountInput.value || "").trim();
  const count = Math.min(MAX_FIGURE_IMAGE_COUNT, Math.max(1, Number(rawCount) || 1));
  const arrangement = elements.figureArrangementInput.value;
  const columns = arrangement === "stack"
    ? 1
    : Math.min(4, Math.max(1, Number(elements.figureColumnsInput.value) || 1));
  const slotCount = Math.min(MAX_FIGURE_IMAGE_COUNT, Math.max(count, Math.ceil(count / columns) * columns));
  const rows = Math.ceil(slotCount / columns);
  elements.figureImageCountInput.value = String(count);
  elements.figureColumnsInput.value = String(columns);
  elements.figureGrid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  state.figureSlots = Array.from({ length: slotCount }, (_value, index) => state.figureSlots[index] || "");
  const available = figureProjectImages();
  elements.figureGrid.replaceChildren();
  for (let index = 0; index < slotCount; index += 1) {
    const select = document.createElement("select");
    select.className = `figure-slot ${state.figureSlots[index] ? "selected" : ""}`;
    select.dataset.slot = String(index);
    select.setAttribute("aria-label", `第 ${index + 1} 个图片位置`);
    select.append(new Option("点击选择图片", ""));
    for (const file of available) select.append(new Option(file, file));
    select.value = state.figureSlots[index] || "";
    select.addEventListener("focus", () => {
      state.figureSelectedSlot = index;
    });
    select.addEventListener("change", () => {
      state.figureSelectedSlot = index;
      const wasSelected = Boolean(state.figureSlots[index]);
      if (select.value && !wasSelected && state.figureSlots.filter(Boolean).length >= count) {
        select.value = "";
        toast(`当前设置只需要 ${count} 张图片。`, "warning", 2800);
        return;
      }
      state.figureSlots[index] = select.value;
      select.classList.toggle("selected", Boolean(select.value));
      syncFigureImageInput();
    });
    elements.figureGrid.append(select);
  }
  syncFigureImageInput();
  const mode = state.project?.layoutMode === "double" ? "双栏模板" : "单栏模板";
  elements.figureLayoutSummary.textContent = `${mode} · ${count} 张图片 · ${rows} 行 × ${columns} 列，共 ${slotCount} 个位置 · 规则生成 LaTeX，不调用 AI。`;
}

function focusFigureCountInput(event) {
  // Selecting the default value prevents typing "2" from becoming "12" and
  // then being clamped to the maximum number of layout slots.
  const input = event.currentTarget;
  state.figureNumberInputChanged = false;
  input.select();
  window.requestAnimationFrame(() => {
    if (document.activeElement === input && !state.figureNumberInputChanged) input.select();
  });
}

function figureNumberInput(eventOrInput) {
  return eventOrInput?.currentTarget || eventOrInput || elements.figureImageCountInput;
}

function handleFigureNumberInput(event) {
  const input = figureNumberInput(event);
  state.figureNumberInputChanged = true;
  if (!String(input?.value || "").trim()) return;
  renderFigureGrid();
}

function commitFigureNumberInput(eventOrInput) {
  const input = figureNumberInput(eventOrInput);
  if (!input) return;
  if (!String(input.value || "").trim()) {
    input.value = "1";
  }
  renderFigureGrid();
}

async function uploadFigureFile(file, { overwrite = false, conflictMode = "" } = {}) {
  const params = new URLSearchParams({ name: file.name });
  if (overwrite) params.set("overwrite", "1");
  if (conflictMode) params.set("conflictMode", conflictMode);
  const response = await fetch(`/api/figure/upload?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `图片上传失败：${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function openFigureDialog(anchor) {
  state.figureAnchor = anchor;
  if (elements.structureTypeInput) elements.structureTypeInput.value = "figure";
  state.figureSlots = [];
  state.figureSelectedSlot = 0;
  elements.figureImagesInput.value = "";
  elements.figurePlacementInput.value = anchor?.type === "source" ? "插入当前位置附近" : "插入本段之后";
  elements.figureSpanInput.value = "column";
  elements.figureAlignmentInput.value = "center";
  elements.figureArrangementInput.value = "side-by-side";
  elements.figureImageCountInput.value = "1";
  elements.figureColumnsInput.value = "1";
  elements.figurePositionInput.value = "top";
  elements.figureCaptionInput.value = "";
  elements.figureLabelInput.value = "";
  elements.figureAnchorMeta.textContent = figureAnchorText(anchor);
  if (elements.insertTableCaption) elements.insertTableCaption.value = "";
  if (elements.insertTableLabel) elements.insertTableLabel.value = "";
  if (elements.insertFormulaLabel) elements.insertFormulaLabel.value = "";
  if (elements.insertFormulaLatex) elements.insertFormulaLatex.value = "";
  state.formulaMathfield = null;
  elements.formulaMathfieldShell?.replaceChildren();
  renderFigureGrid();
  syncStructureDialogType("figure");
  if (!elements.figureDialog.open) elements.figureDialog.showModal();
  window.requestAnimationFrame(() => elements.figureGrid?.querySelector("select")?.focus());
}

function closeFigureDialog() {
  state.figureAnchor = null;
  if (elements.figureDialog.open) elements.figureDialog.close();
}

async function openSourceFigureDialog() {
  if (!state.sourceFile) {
    toast("请先选择一个 TeX 文件。", "error");
    return;
  }
  if (!state.sourceFile.toLowerCase().endsWith(".tex")) {
    toast("图片只能插入 TeX 文件，不能插入 Bib 文件。", "error");
    return;
  }
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  openFigureDialog({
    type: "source",
    file: state.sourceFile,
    sourceHash: state.sourceHash,
    cursorOffset: elements.sourceEditor.selectionStart || 0
  });
}

function applyFigureInsertionResult(result) {
  if (result.source && result.source.file === state.sourceFile) {
    state.sourceHash = result.source.sourceHash;
    state.sourceEol = result.source.eol || state.sourceEol;
    elements.sourceEditor.value = result.source.content;
    state.sourceSavedContent = elements.sourceEditor.value;
    state.sourceDirty = false;
    updateSourceLineNumbers();
    setSourceDirty(false);
    refreshSourceSearch();
    renderSectionList();
  }
  if (result.document && result.document.file === state.currentFile) {
    state.currentDocument = result.document;
    renderSegments();
  }
  updateBuild(result.build);
  invalidateReferences();
  scheduleProjectRefresh();
}

async function submitFigureInsertion(event) {
  event.preventDefault();
  commitFigureNumberInput(elements.figureImageCountInput);
  const anchor = state.figureAnchor;
  if (!anchor) return;
  if (state.sourceDirty && state.sourceFile === anchor.file) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
    if (anchor.type === "source") anchor.sourceHash = state.sourceHash;
  }
  if (state.structureType === "table" || state.structureType === "formula") {
    setBusy(elements.insertFigureSubmitButton, true);
    try {
      const latex = state.structureType === "table"
        ? createTableLatex({
            rows: readInsertTableRows(),
            caption: elements.insertTableCaption?.value || "",
            label: elements.insertTableLabel?.value || "",
            span: elements.insertTableSpan?.value === "span",
            grid: elements.insertTableBorder?.value === "grid"
          })
        : createFormulaLatex({
            latex: elements.insertFormulaLatex?.value || state.formulaMathfield?.getValue?.() || state.formulaMathfield?.value || "",
            numbered: elements.insertFormulaNumbered?.value !== "none",
            label: elements.insertFormulaLabel?.value || ""
          });
      const result = await api("/api/structure/insert", {
        method: "POST",
        body: JSON.stringify({
          file: anchor.file,
          anchor,
          kind: state.structureType,
          latex,
          deferCompile: true
        })
      });
      closeFigureDialog();
      applyFigureInsertionResult(result);
      toast(`已插入${state.structureType === "table" ? "表格" : "公式"}。`, "success", 4200);
    } catch (error) {
      toast(error.message, "error", 6200);
    } finally {
      setBusy(elements.insertFigureSubmitButton, false);
    }
    return;
  }
  syncFigureImageInput();
  const images = elements.figureImagesInput.value.trim();
  if (!images) {
    toast("请先在图片方框中选择至少一张图片。", "error");
    elements.figureGrid?.querySelector("select")?.focus();
    return;
  }
  setBusy(elements.insertFigureSubmitButton, true);
  try {
    const result = await api("/api/figure/insert", {
      method: "POST",
      body: JSON.stringify({
        file: anchor.file,
        anchor,
        images,
        description: elements.figurePlacementInput.value.trim(),
        caption: elements.figureCaptionInput.value.trim(),
        label: elements.figureLabelInput.value.trim(),
        layout: figureLayoutOptions(),
        deferCompile: true
      })
    });
    closeFigureDialog();
    applyFigureInsertionResult(result);
    const copied = (result.assets || []).filter((asset) => asset.copied).length;
    toast(`已插入 ${result.assets?.length || 0} 张图片${copied ? `，并复制到项目内 ${copied} 张` : ""}。`, "success", 5600);
  } catch (error) {
    toast(error.message, "error", 6800);
  } finally {
    setBusy(elements.insertFigureSubmitButton, false);
  }
}

function openStructureDialog(type, anchor) {
  if (type === "figure") {
    openFigureDialog(anchor);
    return;
  }
  state.figureAnchor = anchor;
  if (elements.structureTypeInput) elements.structureTypeInput.value = type;
  elements.figureAnchorMeta.textContent = figureAnchorText(anchor);
  if (type === "table") {
    if (elements.insertTableRows) elements.insertTableRows.value = "3";
    if (elements.insertTableColumns) elements.insertTableColumns.value = "3";
    if (elements.insertTableCaption) elements.insertTableCaption.value = "";
    if (elements.insertTableLabel) elements.insertTableLabel.value = "";
    renderInsertTableGrid();
  } else {
    if (elements.insertFormulaLabel) elements.insertFormulaLabel.value = "";
    if (elements.insertFormulaLatex) elements.insertFormulaLatex.value = "";
    state.formulaMathfield = null;
    elements.formulaMathfieldShell?.replaceChildren();
  }
  syncStructureDialogType(type);
  if (!elements.figureDialog.open) elements.figureDialog.showModal();
}

async function handleExternalFigureFiles() {
  const files = [...(elements.figureExternalInput?.files || [])];
  if (!files.length) return;
  const requestedCount = Math.min(MAX_FIGURE_IMAGE_COUNT, Math.max(1, Number(elements.figureImageCountInput.value) || 1));
  setBusy(elements.chooseExternalFigureButton, true);
  try {
    for (const file of files) {
      const nextSlot = Math.min(state.figureSelectedSlot, Math.max(0, state.figureSlots.length - 1));
      if (!state.figureSlots[nextSlot] && state.figureSlots.filter(Boolean).length >= requestedCount) {
        toast(`当前设置只需要 ${requestedCount} 张图片，未继续添加更多文件。`, "warning", 3600);
        break;
      }
      let result;
      try {
        result = await uploadFigureFile(file);
      } catch (error) {
        if (error.status !== 409 || error.payload?.code !== "FIGURE_NAME_CONFLICT") throw error;
        const overwrite = window.confirm("当前图片已存在，是否选择覆盖？\n选择“取消”将保留原图片，并把新文件另存为带 (2) 的名称。")
          ? true
          : false;
        result = await uploadFigureFile(file, overwrite ? { overwrite: true } : { conflictMode: "suffix" });
      }
      const slot = nextSlot;
      state.figureSlots[slot] = result.relativePath;
      state.figureSelectedSlot = Math.min(slot + 1, Math.max(0, state.figureSlots.length - 1));
      const extension = result.relativePath.slice(result.relativePath.lastIndexOf(".")).toLowerCase();
      state.project.projectFiles = [
        ...(state.project.projectFiles || []).filter((entry) => entry.path !== result.relativePath),
        { path: result.relativePath, type: "file", extension, previewable: PROJECT_PREVIEW_EXTENSIONS.has(extension), size: file.size }
      ].sort((left, right) => left.path.localeCompare(right.path));
      renderDocumentList();
      renderFigureGrid();
    }
    toast(`已添加 ${files.length} 个项目外图片。`, "success");
  } catch (error) {
    toast(error.message, "error", 6200);
  } finally {
    elements.figureExternalInput.value = "";
    setBusy(elements.chooseExternalFigureButton, false);
  }
}

function renderTranslationSections(documentPayload) {
  const sections = summarizeTranslationSections(documentPayload.segments);
  const documents = [...(state.project?.documents || [])];
  const current = documents.find((item) => item.file === documentPayload.file);
  if (current) current.sections = sections;
  else documents.push({ file: documentPayload.file, sections });
  if (!sections.some((section) => section.id === state.currentSectionId)) state.currentSectionId = sections[0]?.id || null;

  return sections;
}

function updateTranslateSectionButton() {
  updateTranslationDirection();
}

function translateCurrentSection() {
  if (!state.currentDocument || !state.currentSectionId) return;
  const segments = state.currentDocument.segments.filter((segment) => belongsToTranslationSection(segment, state.currentSectionId));
  let queued = 0;
  let missingChinese = 0;
  for (const segment of segments) {
    const chinese = String(segment.chinese || "").trim();
    if (!chinese) {
      missingChinese += 1;
      continue;
    }
    if (enqueueSegmentTranslation(segment, chinese, { silent: true })) queued += 1;
  }
  if (!queued) {
    toast(
      missingChinese
        ? "本节还没有可用于更新英文的中文工作稿，请先填写或生成中文。"
        : "本节段落已经在翻译队列中。",
      missingChinese ? "warning" : "success",
      4200
    );
    return;
  }
  toast(
    `本节已有 ${queued} 个段落加入翻译队列${missingChinese ? `，另有 ${missingChinese} 段缺少中文工作稿` : ""}。`,
    missingChinese ? "warning" : "success",
    4600
  );
}

function renderSegments() {
  const documentPayload = state.currentDocument;
  const summary = state.project?.documents?.find((item) => item.file === documentPayload.file);
  if (summary) {
    summary.segments = documentPayload.segments.length;
    summary.translated = documentPayload.segments.filter((segment) => segment.chinese).length;
    summary.stale = documentPayload.segments.filter((segment) => ["english-changed", "pending"].includes(segment.translationStatus)).length;
  }
  const sections = renderTranslationSections(documentPayload);
  const mathBlocks = documentPayload.mathBlocks || [];
  const tableBlocks = documentPayload.tableBlocks || [];
  const items = [
    ...documentPayload.segments.map((segment) => ({ type: "segment", startLine: segment.startLine, item: segment })),
    ...mathBlocks.map((block) => ({ type: "math", startLine: block.startLine, item: block })),
    ...tableBlocks.map((block) => ({ type: "table", startLine: block.startLine, item: block }))
  ].sort((left, right) => (
    Number(left.startLine || 0) - Number(right.startLine || 0)
    || (left.type === "segment" ? -1 : left.type === "math" ? 0 : 1)
  ));
  elements.currentFile.textContent = fileLabel(documentPayload.file);
  elements.fileMeta.textContent = `${documentPayload.segments.length} 段 · ${mathBlocks.length} 公式 · ${tableBlocks.length} 表格 · ${sections.length} 节`;
  elements.currentFile.title = elements.currentFile.textContent + " · " + elements.fileMeta.textContent;
  elements.segmentList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "此文件没有检测到可编辑的正文段落、公式或表格";
    elements.segmentList.append(empty);
  } else {
    let previousHeadingPath = [];
    for (const entry of items) {
      const headingPath = Array.isArray(entry.item.headingPath) ? entry.item.headingPath : [];
      let commonLength = 0;
      while (
        commonLength < previousHeadingPath.length
        && commonLength < headingPath.length
        && previousHeadingPath[commonLength].id === headingPath[commonLength].id
      ) commonLength += 1;
      for (const heading of headingPath.slice(commonLength)) {
        const node = document.createElement("div");
        node.className = `segment-heading level-${heading.level}`;
        const title = document.createElement("strong");
        title.className = "segment-heading-title";
        title.textContent = heading.title;
        const line = document.createElement("span");
        line.className = "segment-heading-line";
        line.textContent = `L${heading.line}`;
        node.append(title, line);
        elements.segmentList.append(node);
      }
      const row = entry.type === "segment"
        ? createSegmentRow(entry.item)
        : entry.type === "math" ? createMathBlockRow(entry.item) : createTableBlockRow(entry.item);
      row.dataset.startLine = entry.item.startLine;
      row.dataset.endLine = entry.item.endLine;
      if (entry.type === "table") row.addEventListener("click", (event) => {
        if (!event.target.closest(".segment-actions, textarea, button")) void locateTranslationBlock(row);
      });
      elements.segmentList.append(row);
      previousHeadingPath = headingPath;
    }
  }
  fitAllSegmentRows();
  renderDocumentList();
  renderSectionList();
  updateTranslateFileButton();
  updateTranslateSectionButton();
  reviewCenter?.decorateRows(elements.segmentList);
  refreshIcons();
}

async function loadDocument(file) {
  const token = ++state.documentLoadToken;
  state.currentFile = file;
  updateTopbarCurrentFile(file);
  state.currentDocument = null;
  state.currentSectionId = null;
  elements.segmentList.classList.remove("missing-project-source");
  renderFileTranslationProgress(file);
  elements.segmentList.innerHTML = '<div class="empty-state">正在读取段落...</div>';
  try {
    const document = await api(`/api/document?file=${encodeURIComponent(file)}`);
    if (token !== state.documentLoadToken) return false;
    state.currentDocument = document;
    renderSegments();
    if (state.mode === "source") {
      const loaded = await loadSourceFile(file);
      if (!loaded) renderSourceFileOptions(state.sourceFile);
    } else if (!state.sourceDirty) {
      renderSourceFileOptions(file);
    }
    return true;
  } catch (error) {
    if (token !== state.documentLoadToken) return false;
    toast(error.message, "error");
    return false;
  }
}

function ensureSourceSearchControls() {
  if (elements.sourceSearchInput) return;
  const toolbar = document.querySelector(".source-tool-fields")
    || elements.sourceFileSelect.closest(".toolbar-actions");
  const search = document.createElement("div");
  search.className = "source-search";
  search.setAttribute("role", "search");
  search.innerHTML = [
    '<div class="source-search-row">',
    '<i data-lucide="search"></i>',
    '<input id="sourceSearchInput" type="search" autocomplete="off" aria-label="全局搜索 TeX 和 Markdown" placeholder="搜索整个项目" disabled>',
    '<span id="sourceSearchCount" aria-live="polite">0 / 0</span>',
    '<button class="icon-button small" id="sourceSearchPreviousButton" type="button" title="上一个匹配" disabled><i data-lucide="chevron-up"></i></button>',
    '<button class="icon-button small" id="sourceSearchNextButton" type="button" title="下一个匹配" disabled><i data-lucide="chevron-down"></i></button>',
    '</div>',
    '<div class="source-replace-row hidden" id="sourceReplacePanel">',
    '<i data-lucide="replace"></i>',
    '<input id="sourceReplaceInput" type="text" autocomplete="off" aria-label="替换内容" placeholder="替换为">',
    '<button class="button secondary" id="sourceSearchReplaceButton" type="button" title="替换当前匹配">替换</button>',
    '<button class="button secondary" id="sourceSearchReplaceAllButton" type="button" title="替换整个项目中的所有匹配">全部替换</button>',
    '</div>',
    '<div class="source-search-results" id="sourceSearchResults" aria-live="polite"></div>'
  ].join("");
  toolbar.append(search);
  elements.sourceSearchInput = search.querySelector("#sourceSearchInput");
  elements.sourceReplaceInput = search.querySelector("#sourceReplaceInput");
  elements.sourceReplacePanel = search.querySelector("#sourceReplacePanel");
  elements.sourceSearchResults = search.querySelector("#sourceSearchResults");
  elements.sourceSearchReplaceButton = search.querySelector("#sourceSearchReplaceButton");
  elements.sourceSearchReplaceAllButton = search.querySelector("#sourceSearchReplaceAllButton");
  elements.sourceSearchCount = search.querySelector("#sourceSearchCount");
  elements.sourceSearchPreviousButton = search.querySelector("#sourceSearchPreviousButton");
  elements.sourceSearchNextButton = search.querySelector("#sourceSearchNextButton");
}

function sourceLineCount() {
  return elements.sourceEditor.value.split(/\r?\n/).length;
}

function sourceSyntaxEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isMarkdownFile(file = state.sourceFile) {
  return /\.(?:md|markdown)$/i.test(String(file || ""));
}

function sourceHighlightDecorations(file, content) {
  const normalizedFile = String(file || "").replaceAll("\\", "/");
  const sourceLength = String(content || "").length;
  const decorations = [];
  for (const item of reviewCenter?.all() || []) {
    if (item.anchor?.file !== state.sourceFile) continue;
    const start = Math.max(0, Math.min(sourceLength, item.anchor.start || 0));
    const end = Math.max(start, Math.min(sourceLength, item.anchor.end || 0));
    if (end > start) decorations.push({ start, end, className: "source-annotation", title: "批注 · " + (item.text || item.quote) });
  }
  for (const match of state.sourceSearchMatches || []) {
    if (match.file !== normalizedFile) continue;
    const start = Math.max(0, Math.min(sourceLength, Number(match.start) || 0));
    const end = Math.max(start, Math.min(sourceLength, Number(match.end) || 0));
    if (end > start) decorations.push({ start, end, className: "source-search-match", title: "搜索匹配" });
  }
  return decorations.sort((left, right) => left.start - right.start || right.end - left.end);
}

function sourceDecorateToken(className, token, offset, decorations) {
  const source = String(token || "");
  if (!source || !decorations.length) {
    const escaped = sourceSyntaxEscape(source);
    return className ? '<span class="' + className + '">' + escaped + '</span>' : escaped;
  }
  const boundaries = new Set([0, source.length]);
  for (const decoration of decorations) {
    if (decoration.end <= offset || decoration.start >= offset + source.length) continue;
    boundaries.add(Math.max(0, decoration.start - offset));
    boundaries.add(Math.min(source.length, decoration.end - offset));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const part = source.slice(start, end);
    const escaped = sourceSyntaxEscape(part);
    const syntax = className ? '<span class="' + className + '">' + escaped + '</span>' : escaped;
    const decoration = decorations.find((candidate) => candidate.start <= offset + start && candidate.end >= offset + end);
    if (!decoration) return syntax;
    const title = sourceSyntaxEscape(decoration.title).replaceAll("\"", "&quot;");
    return '<mark class="' + decoration.className + '" title="' + title + '">' + syntax + '</mark>';
  }).join("");
}

function latexSourceHighlightHtml(value, decorations = sourceHighlightDecorations(state.sourceFile, value)) {
  const source = String(value || "").replace(/\r\n/g, "\n");
  let html = "";
  let cursor = 0;
  let mathMarker = "";
  const append = (className, token) => {
    html += sourceDecorateToken(className, token, cursor, decorations);
  };
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\" && !fastPreviewIsEscaped(source, cursor)) {
      const citation = CITATION_SOURCE_TOKEN.exec(source.slice(cursor));
      if (citation) {
        append("syntax-citation", citation[0]);
        cursor += citation[0].length;
        continue;
      }
    }
    if (char === "%" && !fastPreviewIsEscaped(source, cursor)) {
      const end = source.indexOf("\n", cursor);
      const commentEnd = end < 0 ? source.length : end;
      append("syntax-comment", source.slice(cursor, commentEnd));
      cursor = commentEnd;
      continue;
    }
    if (char === "\\") {
      const command = source.slice(cursor).match(/^\\(?:[A-Za-z@]+\*?|.)/)?.[0] || "\\";
      append("syntax-command", command);
      cursor += command.length;
      continue;
    }
    if (char === "$" && !fastPreviewIsEscaped(source, cursor)) {
      const marker = source.startsWith("$$", cursor) ? "$$" : "$";
      append("syntax-math-delimiter", marker);
      mathMarker = mathMarker === marker ? "" : marker;
      cursor += marker.length;
      continue;
    }
    if (char === "@" && /^(?:@[A-Za-z]+)/.test(source.slice(cursor))) {
      const token = source.slice(cursor).match(/^@[A-Za-z]+/)?.[0] || "@";
      append("syntax-bib-type", token);
      cursor += token.length;
      continue;
    }
    const linePrefix = source.slice(source.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1, cursor);
    if (!mathMarker && /^[\t ]*$/.test(linePrefix)) {
      const field = source.slice(cursor).match(/^[A-Za-z][A-Za-z0-9_-]*(?=\s*=)/)?.[0];
      if (field) {
        append("syntax-bib-field", field);
        cursor += field.length;
        continue;
      }
    }
    if ("{}[]".includes(char)) {
      append("syntax-brace", char);
      cursor += 1;
      continue;
    }
    if (/\d/.test(char)) {
      const number = source.slice(cursor).match(/^\d+(?:\.\d+)?/)?.[0] || char;
      append(mathMarker ? "syntax-math" : "syntax-number", number);
      cursor += number.length;
      continue;
    }
    const specials = ["%", "\\", "$", "@", "{", "}", "[", "]"];
    let end = cursor + 1;
    while (end < source.length && !specials.includes(source[end]) && !/\d/.test(source[end])) end += 1;
    append(mathMarker ? "syntax-math" : "", source.slice(cursor, end));
    cursor = end;
  }
  return `${html}\u200b`;
}

function markdownSourceHighlightHtml(value) {
  let fenced = false;
  const source = String(value || "").replace(/\r\n/g, "\n");
  const decorations = sourceHighlightDecorations(state.sourceFile, source);
  let offset = 0;
  const lines = source.split("\n");
  const html = lines.map((line) => {
    const lineHtml = (className) => sourceDecorateToken(className, line, offset, decorations);
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return lineHtml("syntax-markdown-code");
    }
    if (fenced) return lineHtml("syntax-markdown-code");
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return lineHtml("syntax-markdown-heading");
    if (/^\s*>/.test(line)) return lineHtml("syntax-markdown-quote");
    if (/^\s*(?:[-+*]|\d+\.)\s+/.test(line)) return lineHtml("syntax-markdown-list");
    if (/^\s*\|.*\|\s*$/.test(line)) return lineHtml("syntax-markdown-table");
    return lineHtml("");
  }).join("\n");
  return html + "\u200b";
}

function updateSourceSyntaxHighlight() {
  const code = elements.sourceHighlightLayer?.querySelector("code");
  if (!code) return;
  const html = isMarkdownFile()
    ? markdownSourceHighlightHtml(elements.sourceEditor.value)
    : latexSourceHighlightHtml(elements.sourceEditor.value);
  if (code.sourceHtml === html) return;
  code.sourceHtml = html;
  // Keep unchanged syntax nodes so one character edit does not relayout the full layer.
  const template = document.createElement("template");
  template.innerHTML = html;
  const previous = [...code.childNodes];
  const next = [...template.content.childNodes];
  let start = 0;
  while (start < previous.length && start < next.length && previous[start].isEqualNode(next[start])) start += 1;
  let previousEnd = previous.length - 1;
  let nextEnd = next.length - 1;
  while (previousEnd >= start && nextEnd >= start && previous[previousEnd].isEqualNode(next[nextEnd])) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  const replacement = document.createDocumentFragment();
  for (let index = start; index <= nextEnd; index += 1) replacement.append(next[index]);
  for (let index = start; index <= previousEnd; index += 1) previous[index].remove();
  code.insertBefore(replacement, previous[previousEnd + 1] || null);
}

function syncSourceEditorLayers() {
  if (!elements.sourceHighlightLayer) return;
  elements.sourceHighlightLayer.scrollTop = elements.sourceEditor.scrollTop;
  elements.sourceHighlightLayer.scrollLeft = elements.sourceEditor.scrollLeft;
  elements.sourceLineNumbers.scrollTop = elements.sourceEditor.scrollTop;
}

function sourceCursorPosition() {
  const value = elements.sourceEditor.value.slice(0, elements.sourceEditor.selectionStart || 0);
  const lines = value.split(/\r?\n/);
  return {
    line: lines.length,
    column: (lines.at(-1) || "").length + 1
  };
}

function updateSourceLineNumbers({ highlight = true } = {}) {
  const count = sourceLineCount();
  if (elements.sourceLineNumbers.dataset.count !== String(count)) {
    elements.sourceLineNumbers.dataset.count = String(count);
    elements.sourceLineNumbers.textContent = Array.from({ length: count }, (_value, index) => index + 1).join("\n");
  }
  if (highlight) updateSourceSyntaxHighlight();
}

function scheduleSourceEditorRefresh() {
  if (state.sourceEditorRefreshFrame) return;
  state.sourceEditorRefreshFrame = window.requestAnimationFrame(() => {
    state.sourceEditorRefreshFrame = 0;
    updateSourceLineNumbers({ highlight: false });
    void refreshSourceSearch({ keepIndex: true });
    renderSectionList();
  });
}

function toggleSourceLineComments() {
  const editor = elements.sourceEditor;
  const value = editor.value;
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
    ? selectionEnd - 1
    : selectionEnd;
  const rangeStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const nextBreak = value.indexOf("\n", effectiveEnd);
  const rangeEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(rangeStart, rangeEnd).split("\n");
  const contentLines = lines.filter((line) => line.trim());
  const markdown = isMarkdownFile();
  const uncomment = contentLines.length > 0 && contentLines.every((line) => (
    markdown ? /^\s*<!--(?:\s|$).*?-->\s*$/.test(line) : /^\s*%/.test(line)
  ));
  const replacement = lines.map((line) => {
    if (!line.trim()) return line;
    if (markdown) {
      return uncomment
        ? line.replace(/^(\s*)<!--\s?(.*?)\s?-->\s*$/, "$1$2")
        : line.replace(/^(\s*)(.*)$/, "$1<!-- $2 -->");
    }
    return uncomment
      ? line.replace(/^(\s*)%\s?/, "$1")
      : line.replace(/^(\s*)/, "$1% ");
  }).join("\n");
  editor.setRangeText(replacement, rangeStart, rangeEnd, "select");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function shouldProtectSourceBoundaryBackspace(editor) {
  if (!editor || editor.selectionStart !== editor.selectionEnd) return false;
  const cursor = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const line = editor.value.slice(lineStart, editor.value.indexOf("\n", cursor) < 0 ? editor.value.length : editor.value.indexOf("\n", cursor));
  const column = cursor - lineStart;
  if (column !== line.search(/\S|$/)) return false;
  const previousLineEnd = lineStart - 1;
  if (previousLineEnd < 0) return false;
  const previousLineStart = editor.value.lastIndexOf("\n", previousLineEnd - 1) + 1;
  const previousLine = editor.value.slice(previousLineStart, previousLineEnd);
  if (!previousLine.trim()) return false;
  return /^\s*\\end\s*\{(?:table\*?|tabular\*?|tabularx|longtable|equation\*?|align\*?|gather\*?|multline\*?)\}/.test(line);
}

function updateSourceStatus() {
  if (state.sourceMissing) {
    elements.sourceStatus.textContent = "磁盘文件已移除 · 未保存文字可复制";
    elements.sourceStatus.title = state.sourceFile || "";
    return;
  }
  if (!state.sourceFile || elements.sourceEditor.disabled) return;
  const lines = sourceLineCount();
  const cursor = sourceCursorPosition();
  elements.sourceStatus.textContent = state.sourceSaveInFlight ? "自动保存中" : state.sourceDirty ? "等待自动保存" : "已自动保存";
  elements.sourceStatus.title = `${lines} 行 · 第 ${cursor.line} 行，第 ${cursor.column} 列`;
}

function setSourceDirty(dirty) {
  state.sourceDirty = dirty;
  elements.sourceStatus.classList.toggle("clean", !dirty && Boolean(state.sourceFile));
  elements.sourceStatus.classList.toggle("dirty", dirty);
  elements.sourceStatus.classList.toggle("error", state.sourceMissing);
  elements.saveSourceButton.disabled = !dirty || state.sourceMissing;
  updateHeaderSaveState(state.sourceMissing ? "error" : dirty ? "dirty" : "saved");
  updateSourceStatus();
}

function setSourceSearchEnabled(enabled) {
  if (!elements.sourceSearchInput) return;
  elements.sourceSearchInput.disabled = !enabled;
  const hasMatches = enabled && state.sourceSearchMatches.length > 0;
  elements.sourceSearchPreviousButton.disabled = !hasMatches;
  elements.sourceSearchNextButton.disabled = !hasMatches;
  if (elements.sourceSearchReplaceButton) elements.sourceSearchReplaceButton.disabled = !hasMatches;
  if (elements.sourceSearchReplaceAllButton) elements.sourceSearchReplaceAllButton.disabled = !hasMatches;
}

function focusSourceSearch() {
  if (!elements.sourceSearchInput || state.mode !== "source" || !state.sourceFile) return;
  elements.sourceView.classList.add("search-open");
  document.querySelector("#toggleSourceSearchButton").setAttribute("aria-expanded", "true");
  elements.sourceSearchInput.disabled = false;
  elements.sourceSearchInput.focus();
  elements.sourceSearchInput.select();
  refreshSourceSearch({ keepIndex: true });
}

function closeSourceSearch() {
  elements.sourceView.classList.remove("search-open");
  document.querySelector("#toggleSourceSearchButton").setAttribute("aria-expanded", "false");
  elements.sourceEditor.focus();
}

function sourceSearchFiles() {
  return (state.project?.sourceFiles || []).filter((file) => /\.(?:tex|md|markdown)$/i.test(String(file || "")));
}

function renderSourceSearchResults() {
  if (!elements.sourceSearchResults) return;
  elements.sourceSearchResults.replaceChildren();
  const matches = state.sourceSearchMatches || [];
  if (!matches.length) return;
  const limit = Math.min(matches.length, 80);
  for (let index = 0; index < limit; index += 1) {
    const match = matches[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-search-result" + (index === state.sourceSearchIndex ? " active" : "");
    const line = String(match.content || "").slice(0, match.start).split(/\r?\n/).length;
    const lineText = String(match.content || "").split(/\r?\n/)[line - 1] || "";
    button.textContent = match.file + ":" + line + "  " + lineText.trim();
    button.title = button.textContent;
    button.addEventListener("click", () => void selectSourceSearchMatch(index));
    elements.sourceSearchResults.append(button);
  }
  if (matches.length > limit) {
    const note = document.createElement("div");
    note.className = "source-search-more";
    note.textContent = "还有 " + (matches.length - limit) + " 个匹配";
    elements.sourceSearchResults.append(note);
  }
}

async function refreshSourceSearch({ keepIndex = false } = {}) {
  if (!elements.sourceSearchInput) return;
  const query = elements.sourceSearchInput.value;
  const token = ++state.sourceSearchRequest;
  state.sourceSearchQuery = query;
  state.sourceSearchMatches = [];
  state.sourceSearchIndex = keepIndex ? state.sourceSearchIndex : -1;
  renderSourceSearchResults();
  if (!query) {
    elements.sourceSearchCount.textContent = "0 / 0";
    setSourceSearchEnabled(Boolean(state.sourceFile));
    updateSourceSyntaxHighlight();
    return;
  }
  if (state.sourceFile) {
    state.sourceSearchContents.set(state.sourceFile, {
      content: elements.sourceEditor.value,
      sourceHash: state.sourceHash,
      eol: state.sourceEol
    });
  }
  const files = sourceSearchFiles();
  const sources = await Promise.all(files.map(async (file) => {
    const cached = state.sourceSearchContents.get(file);
    if (cached) return { file, ...cached };
    try {
      const source = await api("/api/source?file=" + encodeURIComponent(file));
      const entry = { content: source.content, sourceHash: source.sourceHash, eol: source.eol || String.fromCharCode(10) };
      state.sourceSearchContents.set(file, entry);
      return { file, ...entry };
    } catch {
      return null;
    }
  }));
  if (token !== state.sourceSearchRequest) return;
  const needle = query.toLowerCase();
  for (const source of sources.filter(Boolean)) {
    const content = String(source.content || "");
    const lower = content.toLowerCase();
    let position = 0;
    while (needle && position <= lower.length) {
      const index = lower.indexOf(needle, position);
      if (index < 0) break;
      state.sourceSearchMatches.push({ file: source.file, content, start: index, end: index + query.length });
      position = index + Math.max(needle.length, 1);
    }
  }
  if (state.sourceSearchMatches.length && state.sourceSearchIndex >= state.sourceSearchMatches.length) {
    state.sourceSearchIndex = state.sourceSearchMatches.length - 1;
  }
  const current = state.sourceSearchIndex >= 0 ? state.sourceSearchIndex + 1 : 0;
  elements.sourceSearchCount.textContent = current + " / " + state.sourceSearchMatches.length;
  setSourceSearchEnabled(Boolean(state.sourceFile));
  renderSourceSearchResults();
  updateSourceSyntaxHighlight();
}

function scrollSourceOffsetIntoView(offset) {
  const editor = elements.sourceEditor;
  const style = getComputedStyle(editor);
  const mirror = document.createElement("div");
  for (const property of [
    "font-family", "font-size", "font-style", "font-weight", "font-variant",
    "letter-spacing", "line-height", "text-align", "text-indent", "text-transform",
    "direction", "tab-size", "padding", "white-space", "overflow-wrap", "word-break"
  ]) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: "fixed", top: "0", left: "0", visibility: "hidden",
    pointerEvents: "none", boxSizing: "border-box", width: `${editor.clientWidth}px`
  });
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(document.createTextNode(editor.value.slice(0, offset)), marker,
    document.createTextNode(editor.value.slice(offset)));
  document.body.append(mirror);
  const targetTop = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
  mirror.remove();
  editor.scrollTop = Math.max(0, targetTop - editor.clientHeight * 0.28);
  syncSourceEditorLayers();
}

async function selectSourceSearchMatch(index) {
  const matches = state.sourceSearchMatches;
  if (!matches.length) {
    elements.sourceSearchCount.textContent = "0 / 0";
    toast("没有找到匹配内容。", "error", 2600);
    return;
  }
  state.sourceSearchIndex = (index + matches.length) % matches.length;
  const match = matches[state.sourceSearchIndex];
  if (state.sourceFile !== match.file) {
    const loaded = await loadSourceFile(match.file);
    if (!loaded) return;
  }
  elements.sourceEditor.focus();
  elements.sourceEditor.setSelectionRange(match.start, match.end);
  scrollSourceOffsetIntoView(match.start);
  elements.sourceSearchCount.textContent = (state.sourceSearchIndex + 1) + " / " + matches.length;
  flashSourceSelection();
  updateSourceStatus();
  renderSourceSearchResults();
}

async function moveSourceSearch(direction) {
  if (!elements.sourceSearchInput.value) {
    elements.sourceSearchInput.focus();
    return;
  }
  if (elements.sourceSearchInput.value !== state.sourceSearchQuery) await refreshSourceSearch();
  const nextIndex = state.sourceSearchIndex < 0 ? 0 : state.sourceSearchIndex + direction;
  await selectSourceSearchMatch(nextIndex);
}

function focusSourceReplace() {
  if (!elements.sourceReplaceInput || state.mode !== "source") return;
  focusSourceSearch();
  elements.sourceReplacePanel?.classList.remove("hidden");
  elements.sourceReplaceInput.focus();
  elements.sourceReplaceInput.select();
}

function replaceAllText(value, query, replacement) {
  const source = String(value || "");
  const needle = String(query || "").toLowerCase();
  if (!needle) return source;
  const lower = source.toLowerCase();
  let result = "";
  let position = 0;
  while (position <= lower.length) {
    const index = lower.indexOf(needle, position);
    if (index < 0) return result + source.slice(position);
    result += source.slice(position, index) + replacement;
    position = index + needle.length;
  }
  return result;
}

async function replaceCurrentSourceMatch() {
  const match = state.sourceSearchMatches[state.sourceSearchIndex];
  if (!match) return;
  await selectSourceSearchMatch(state.sourceSearchIndex);
  const replacement = elements.sourceReplaceInput?.value || "";
  elements.sourceEditor.setRangeText(replacement, match.start, match.end, "select");
  elements.sourceEditor.dispatchEvent(new Event("input", { bubbles: true }));
  await refreshSourceSearch({ keepIndex: true });
}

async function replaceAllSourceMatches() {
  const query = elements.sourceSearchInput?.value || "";
  if (!query || !state.sourceSearchMatches.length) return;
  const replacement = elements.sourceReplaceInput?.value || "";
  setBusy(elements.sourceSearchReplaceAllButton, true);
  try {
    const files = [...new Set(state.sourceSearchMatches.map((match) => match.file))];
    for (const file of files) {
      const source = state.sourceSearchContents.get(file);
      if (!source) continue;
      const nextContent = replaceAllText(file === state.sourceFile ? elements.sourceEditor.value : source.content, query, replacement);
      if (file === state.sourceFile && state.sourceDirty) {
        elements.sourceEditor.value = nextContent;
        elements.sourceEditor.dispatchEvent(new Event("input", { bubbles: true }));
        continue;
      }
      const result = await api("/api/source", {
        method: "POST",
        body: JSON.stringify({
          file,
          content: nextContent,
          sourceHash: source.sourceHash,
          deferCompile: true,
          refreshDocument: file.toLowerCase().endsWith(".tex")
        })
      });
      state.sourceSearchContents.set(file, {
        content: result.source.content,
        sourceHash: result.source.sourceHash,
        eol: result.source.eol || source.eol
      });
      if (file === state.sourceFile) await loadSourceFile(file, { force: true });
    }
    scheduleProjectRefresh(80);
    await refreshSourceSearch({ keepIndex: false });
    toast("已替换 " + files.length + " 个文件中的匹配内容。", "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(elements.sourceSearchReplaceAllButton, false);
  }
}

function confirmDiscardSourceChanges() {
  return !state.sourceDirty || window.confirm("当前源码有未保存修改。放弃这些修改吗？");
}

function applySourceInlineFormat(kind, editor = elements.sourceEditor) {
  if (!editor || editor.disabled || editor.readOnly) return;
  const markdown = editor === elements.sourceEditor && isMarkdownFile();
  const format = kind === "bold"
    ? (markdown ? ["**", "**"] : ["\\textbf{", "}"])
    : (markdown ? ["*", "*"] : ["\\textit{", "}"]);
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const replacement = format[0] + selected + format[1];
  editor.focus({ preventScroll: true });
  if (!document.execCommand("insertText", false, replacement)) {
    editor.setRangeText(replacement, start, end, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selected) editor.setSelectionRange(start, start + replacement.length);
  if (!selected) editor.setSelectionRange(start + format[0].length, start + format[0].length);
}

function applySourceFileKind(file = state.sourceFile) {
  const markdown = isMarkdownFile(file);
  const bibliography = /\.bib$/i.test(String(file || ""));
  elements.sourceView.classList.toggle("markdown-source", markdown);
  elements.sourceViewTitle.textContent = markdown ? "Markdown 原文" : "TeX / Bib 源码";
  elements.sourceFileControl.title = markdown
    ? "选择要编辑的 Markdown 文件"
    : "选择要编辑的 TeX、Bib 或 Markdown 文件";
  elements.sourceEditor.setAttribute("aria-label", markdown ? "Markdown 原文编辑器" : "TeX 或 Bib 源码编辑器");
  elements.sourceFocusButton.title = markdown ? "专注编辑 Markdown" : "专注编辑源码";
  elements.sourceFocusButton.setAttribute("aria-label", elements.sourceFocusButton.title);
  const saveLabel = elements.saveSourceButton.querySelector("span");
  if (saveLabel) saveLabel.textContent = markdown ? "保存 Markdown" : bibliography ? "保存 Bib" : "保存 TeX";
}

function renderSourceFileOptions(preferredFile = "") {
  const files = state.project?.sourceFiles || state.project?.texFiles || [];
  const requested = String(preferredFile || "").replaceAll("\\", "/");
  const currentDocumentFile = String(state.currentFile || state.currentDocument?.file || "").replaceAll("\\", "/");
  let preferred = files.includes(requested) ? requested : "";
  if (!preferred && !state.sourceDirty && files.includes(currentDocumentFile)) preferred = currentDocumentFile;
  if (!preferred && files.includes(state.sourceFile)) preferred = state.sourceFile;
  if (!preferred && files.includes(state.project?.config?.mainTex)) preferred = state.project.config.mainTex;
  if (!preferred) preferred = files[0];
  elements.sourceFileSelect.replaceChildren();
  if (state.sourceMissing && state.sourceFile && !files.includes(state.sourceFile)) {
    const removed = document.createElement("option");
    removed.value = state.sourceFile;
    removed.textContent = `${state.sourceFile}（已从磁盘移除）`;
    removed.disabled = true;
    elements.sourceFileSelect.append(removed);
    preferred = state.sourceFile;
  }
  for (const file of files) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file === state.project.config.mainTex
      ? `${file}（主文件）`
      : file.toLowerCase().endsWith(".bib")
        ? `${file}（参考文献）`
        : isMarkdownFile(file) ? `${file}（Markdown）` : file;
    elements.sourceFileSelect.append(option);
  }
  elements.sourceFileSelect.disabled = files.length === 0;
  elements.sourceEditor.disabled = !state.sourceMissing && files.length === 0;
  elements.sourceFileSelect.value = preferred || "";
  setSourceSearchEnabled(files.length > 0);
  if (!files.length && !state.sourceMissing) {
    applySourceFileKind("");
    elements.sourceEditor.value = "";
    elements.sourceLineNumbers.dataset.count = "1";
    elements.sourceLineNumbers.textContent = "1";
    state.sourceSearchMatches = [];
    state.sourceSearchIndex = -1;
    if (elements.sourceSearchCount) elements.sourceSearchCount.textContent = "0 / 0";
    elements.sourceStatus.classList.remove("clean", "dirty", "error");
    elements.sourceStatus.textContent = "没有可编辑的源码文件";
    elements.saveSourceButton.disabled = true;
    updateSourceSyntaxHighlight();
  }
  const structure = state.project?.structure;
  elements.modularizeButton.title = structure?.eligible
    ? `预览将 ${structure.sections.length} 个章节拆分为独立文件`
    : structure?.reason || "检查论文是否适合按章节拆分";
}

async function loadSourceFile(file, { force = false } = {}) {
  if (!file) return false;
  if (!force && file !== state.sourceFile && !confirmDiscardSourceChanges()) return false;
  elements.sourceStatus.classList.remove("clean", "dirty", "error");
  elements.sourceStatus.textContent = "正在读取源码...";
  showSourceEditor();
  updateTopbarCurrentFile(file);
  elements.sourceEditor.disabled = true;
  try {
    const source = await api(`/api/source?file=${encodeURIComponent(file)}`);
    state.sourceFile = source.file;
    state.sourceHash = source.sourceHash;
    state.sourceEol = source.eol || "\n";
    state.sourceDirty = false;
    state.sourceMissing = false;
    elements.sourceFileSelect.value = source.file;
    elements.sourceEditor.value = source.content;
    state.sourceSavedContent = elements.sourceEditor.value;
    state.sourceSearchContents.set(source.file, {
      content: source.content,
      sourceHash: source.sourceHash,
      eol: state.sourceEol
    });
    elements.sourceEditor.disabled = false;
    applySourceFileKind(source.file);
    state.reviewSelection = null;
    updateTopbarCurrentFile(source.file);
    updateModeButtons();
    renderReviewSourceGutter();
    updateSourceLineNumbers();
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
    renderSectionList();
    refreshSourceSearch();
    return true;
  } catch (error) {
    elements.sourceStatus.classList.remove("clean", "dirty");
    elements.sourceStatus.classList.add("error");
    elements.sourceStatus.textContent = "源码读取失败";
    updateHeaderSaveState("error");
    toast(error.message, "error", 5200);
    return false;
  }
}

async function refreshLoadedSourceFromDisk(file) {
  if (!file || state.sourceFile !== file || state.sourceDirty || state.sourceSaveInFlight) return false;
  try {
    const source = await api(`/api/source?file=${encodeURIComponent(file)}`);
    if (state.sourceFile !== file || state.sourceDirty || state.sourceSaveInFlight) return false;
    state.sourceHash = source.sourceHash;
    state.sourceEol = source.eol || "\n";
    elements.sourceEditor.value = source.content;
    state.sourceSavedContent = source.content;
    updateSourceLineNumbers();
    setSourceDirty(false);
    refreshSourceSearch({ keepIndex: true });
    renderSectionList();
    return true;
  } catch (error) {
    console.warn("Unable to refresh the loaded source file:", error);
    return false;
  }
}

function scheduleSourceAutosave(delay = 850) {
  window.clearTimeout(state.sourceAutosaveTimer);
  if (state.sourceMissing) {
    state.sourceAutosaveTimer = 0;
    return;
  }
  state.sourceAutosaveTimer = window.setTimeout(() => {
    state.sourceAutosaveTimer = 0;
    void saveSourceFile({ quiet: true, automatic: true });
  }, delay);
}

async function saveSourceFile(options = {}) {
  const deferCompile = options.deferCompile ?? true;
  const quiet = options.quiet === true;
  if (!state.sourceFile || !state.sourceDirty) return true;
  if (state.sourceMissing) {
    if (!quiet) toast("无法保存已从项目移除的源码。可先复制编辑区中的文字。", "warning");
    return false;
  }
  if (state.sourceSaveInFlight) {
    state.sourceSavePending = true;
    return false;
  }
  window.clearTimeout(state.sourceAutosaveTimer);
  state.sourceAutosaveTimer = 0;
  const requestedFile = state.sourceFile;
  const requestedContent = elements.sourceEditor.value;
  const requestedHash = state.sourceHash;
  const button = elements.saveSourceButton;
  let saveSucceeded = false;
  let saveFailed = false;
  state.sourceSaveInFlight = true;
  elements.sourceStatus.classList.add("saving");
  updateSourceStatus();
  updateHeaderSaveState("saving");
  setBusy(button, true);
  try {
    const result = await api("/api/source", {
      method: "POST",
      body: JSON.stringify({
        file: requestedFile,
        content: state.sourceEol === "\r\n"
          ? requestedContent.replace(/\n/g, "\r\n")
          : requestedContent,
        sourceHash: requestedHash,
        deferCompile,
        refreshDocument: options.refreshDocument === true || requestedFile.toLowerCase().endsWith(".tex")
      })
    });
    if (state.sourceFile === requestedFile) {
      state.sourceHash = result.source.sourceHash;
      state.sourceEol = result.source.eol || state.sourceEol;
      state.sourceSavedContent = requestedContent;
      state.sourceDirty = elements.sourceEditor.value !== requestedContent;
    }

    updateBuild(result.build);
    const savedFile = result.source.file;
    if (result.project) state.project = result.project;
    invalidateReferences();
    if (result.document && savedFile === state.currentFile) {
      state.currentDocument = result.document;
      renderSegments();
    }
    if (!quiet) {
      const kind = isMarkdownFile(requestedFile) ? "Markdown" : requestedFile.toLowerCase().endsWith(".bib") ? "Bib" : "TeX";
      toast(
        result.build
          ? result.build.skipped
            ? `${kind} 源码已保存。`
            : result.build.success ? `${kind} 源码已保存，PDF 已更新。` : `${kind} 源码已保存，但编译仍有错误。`
          : `${kind} 源码已保存。需要更新 PDF 时请点击“编译全文”。`,
        !result.build || result.build.success || result.build.skipped ? "success" : "error",
        5200
      );
    }
    saveSucceeded = true;
    return true;
  } catch (error) {
    if (error.status === 409 && error.payload?.code === "SOURCE_CHANGED") {
      const reload = window.confirm("该源码文件已在其他位置发生变化。是否放弃当前修改并重新载入？");
      if (reload) await loadSourceFile(state.sourceFile, { force: true });
    } else {
      saveFailed = true;
      elements.sourceStatus.classList.add("error");
      elements.sourceStatus.textContent = "保存失败 · 修改仍保留在编辑器中";
      updateHeaderSaveState("error");
      toast(error.message, "error", 6200);
    }
    return false;
  } finally {
    state.sourceSaveInFlight = false;
    setBusy(button, false);
    elements.sourceStatus.classList.remove("saving");
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
    if (saveFailed) {
      elements.sourceStatus.classList.add("error");
      elements.sourceStatus.textContent = "自动保存失败";
      updateHeaderSaveState("error");
    }
    if (saveSucceeded && (state.sourceSavePending || state.sourceDirty)) {
      state.sourceSavePending = false;
      scheduleSourceAutosave(220);
    } else if (!saveSucceeded) {
      state.sourceSavePending = false;
    }
  }
}

function texHeadingOptions(source) {
  return String(source.content || "").split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^\s*\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/);
    if (!match) return [];
    const depth = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"].indexOf(match[1]);
    return [{ line: index + 1, title: `${"　".repeat(Math.max(0, depth))}${match[2].trim()}` }];
  });
}

function createFileExtension(value = elements.newTexFileName?.value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  const base = normalized.split("/").at(-1) || "";
  const match = base.match(/\.([A-Za-z0-9_-]+)$/);
  return match ? `.${match[1].toLowerCase()}` : ".tex";
}

function updateCreateFileDialogKind() {
  const extension = createFileExtension();
  const isTex = extension === ".tex";
  const insertionField = elements.newTexInsertion?.closest(".field");
  insertionField?.classList.toggle("hidden", !isTex);
  if (!isTex) {
    elements.newTexInsertion.value = "none";
    elements.newTexInsertionNote.textContent = `${extension === ".md" || extension === ".markdown" ? "Markdown" : extension.slice(1).toUpperCase()} 文件不会自动写入主 TeX。`;
  } else {
    elements.newTexInsertionNote.textContent = "选择章节时，会在该章节内容末尾写入 \\input{文件名}。";
  }
  const heading = elements.createTexDialog.querySelector("h2");
  if (heading) heading.textContent = isTex ? "新建 TeX 文件" : "新建 Markdown 文件";
}

async function openCreateTexDialog() {
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  elements.newTexFileName.value = "sections/new-section.tex";
  updateCreateFileDialogKind();
  elements.newTexInsertion.replaceChildren();
  const options = [
    { value: "none", label: "只创建文件，不插入主 TeX" },
    { value: "end", label: `插入到 ${state.project?.config?.mainTex || "main.tex"} 末尾` }
  ];
  try {
    const mainTex = state.project?.config?.mainTex;
    if (mainTex) {
      const source = await api(`/api/source?file=${encodeURIComponent(mainTex)}`);
      elements.createTexDialog.dataset.mainSourceHash = source.sourceHash;
      for (const heading of texHeadingOptions(source)) {
        options.push({ value: `after-section:${heading.line}`, label: `插入到“${heading.title}”章节末尾` });
      }
    }
  } catch (error) {
    elements.createTexDialog.dataset.mainSourceHash = "";
    toast(`无法读取主 TeX 的章节位置：${error.message}`, "error", 5200);
  }
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    elements.newTexInsertion.append(option);
  }
  elements.newTexInsertion.value = options.some((item) => item.value.startsWith("after-section:"))
    ? options.find((item) => item.value.startsWith("after-section:")).value
    : "end";
  elements.createTexDialog.showModal();
  refreshIcons();
  window.setTimeout(() => elements.newTexFileName.focus(), 0);
}

function closeCreateTexDialog() {
  elements.createTexDialog.close();
}

async function createTexFile(event) {
  event.preventDefault();
  const prepared = elements.newTexFileName.value.trim();
  if (!prepared) return;
  const selected = elements.newTexInsertion.value;
  const insertion = selected.startsWith("after-section:")
    ? { mode: "after-section", line: Number(selected.split(":")[1]), sourceHash: elements.createTexDialog.dataset.mainSourceHash || "" }
    : { mode: selected === "end" ? "end" : "none", sourceHash: elements.createTexDialog.dataset.mainSourceHash || "" };
  setBusy(elements.submitCreateTexButton, true);
  setBusy(elements.createTexFileButton, true);
  setBusy(elements.sourceCreateTexButton, true);
  try {
    const result = await api("/api/source/create", {
      method: "POST",
      body: JSON.stringify({ file: prepared, insertion })
    });
    state.project = result.project;
    closeCreateTexDialog();
    if (state.mode !== "source") setMode("source", { loadCurrent: false });
    renderDocumentList();
    renderSourceFileOptions(result.source.file);
    await loadSourceFile(result.source.file, { force: true });
    const extension = createFileExtension(prepared);
    const kind = extension === ".tex" ? "TeX" : "Markdown";
    toast(result.insertion ? `${kind} 文件已创建，并已写入 ${result.insertion.mainTex}。` : `${kind} 文件已创建。`, "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(elements.submitCreateTexButton, false);
    setBusy(elements.createTexFileButton, false);
    setBusy(elements.sourceCreateTexButton, false);
  }
}

function structureStage(scope, title, files, detail) {
  const row = document.createElement("div");
  row.className = `structure-stage ${scope}`;
  const marker = document.createElement("span");
  marker.className = "structure-stage-marker";
  marker.textContent = scope === "global" ? "1" : scope === "local" ? "2" : "3";
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const fileText = document.createElement("span");
  fileText.textContent = files.length ? files.join("、") : "当前未引用文件";
  const description = document.createElement("small");
  description.textContent = detail;
  body.append(heading, fileText, description);
  row.append(marker, body);
  return row;
}

function renderStructurePreview(preview) {
  const migration = preview.bibliographyMigration;
  const canMigrateBibliography = preview.mode === "bibliography-required" && migration?.eligible;
  const bibliographyFiles = canMigrateBibliography
    ? migration.files.map((file) => file.file)
    : preview.workflow.references.files;
  state.structurePreview = preview;
  elements.structureSummary.textContent = canMigrateBibliography
    ? `检测到 ${migration.entries.length} 条内嵌参考文献。先迁移到 ${bibliographyFiles.join("、")}，即可继续拆分章节。`
    : preview.eligible
      ? `将 ${preview.mainTex} 中的 ${preview.sections.length} 个章节拆成独立 TeX 文件，并在写入后重新编译。`
      : preview.reason;
  elements.structureFlow.replaceChildren(
    structureStage("global", "整体格式", [preview.workflow.global.file], preview.workflow.global.responsibilities.join("、")),
    structureStage("local", "章节局部格式", preview.workflow.local.files, preview.workflow.local.responsibilities.join("、")),
    structureStage("references", "参考文献库", bibliographyFiles, preview.workflow.references.responsibilities.join("、"))
  );
  elements.structureFileList.replaceChildren();
  const files = [
    { kind: "GLOBAL", file: preview.mainTex, detail: "保留全局排版、宏包和 Bib 调用" },
    ...preview.sections.map((section) => ({
      kind: "LOCAL",
      file: section.file,
      detail: `${section.title} · 原第 ${section.startLine}-${section.endLine} 行`
    })),
    ...bibliographyFiles.map((file) => ({
      kind: "BIB",
      file,
      detail: canMigrateBibliography ? "将从内嵌参考文献创建" : "保持独立，不由格式模型重写"
    }))
  ];
  for (const item of files) {
    const row = document.createElement("div");
    row.className = "structure-file-row";
    const kind = document.createElement("span");
    kind.className = `structure-file-kind ${item.kind.toLowerCase()}`;
    kind.textContent = item.kind;
    const file = document.createElement("strong");
    file.textContent = item.file;
    const detail = document.createElement("span");
    detail.textContent = item.detail;
    row.append(kind, file, detail);
    elements.structureFileList.append(row);
  }
  elements.structureWarning.textContent = canMigrateBibliography
    ? "迁移会保留全部引用键和原始文献文本，写入失败时自动恢复。完成后请点击“编译全文”更新 PDF。"
    : preview.eligible
      ? "拆分会保留正文、公式、图片、表格和 Bib 条目，写入失败时自动恢复。完成后请点击“编译全文”更新 PDF。"
      : preview.reason;
  elements.structureWarning.classList.toggle("hidden", !elements.structureWarning.textContent);
  elements.structureWarning.classList.toggle("error", !preview.eligible && !canMigrateBibliography);
  elements.migrateBibliographyButton.classList.toggle("hidden", !canMigrateBibliography);
  elements.migrateBibliographyButton.disabled = !canMigrateBibliography;
  elements.applyStructureButton.disabled = !preview.eligible;
  refreshIcons();
}

async function migrateInlineBibliography(preview) {
  const migration = preview?.bibliographyMigration;
  if (!migration?.eligible) throw new Error(migration?.reason || "当前参考文献不能自动迁移。");
  const result = await api("/api/project/bibliography/migrate", {
    method: "POST",
    body: JSON.stringify({ confirmed: true, fingerprint: migration.fingerprint })
  });
  updateBuild(result.build);
  await refreshProject({ preserveDocument: false });
  return result;
}

async function migrateBibliographyForStructure() {
  const preview = state.structurePreview;
  if (!preview?.bibliographyMigration?.eligible) return;
  setBusy(elements.migrateBibliographyButton, true);
  elements.applyStructureButton.disabled = true;
  try {
    const result = await migrateInlineBibliography(preview);
    if (state.mode === "source" && state.sourceFile) await loadSourceFile(state.sourceFile, { force: true });
    const nextPreview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
    renderStructurePreview(nextPreview);
    toast(`参考文献迁移完成：${result.entries.length} 条文献已写入 ${result.files.map((file) => file.file).join("、")}。`, "success", 6800);
  } catch (error) {
    if (error.payload?.details?.errors) updateBuild(error.payload.details);
    toast(error.message, "error", 7600);
  } finally {
    setBusy(elements.migrateBibliographyButton, false);
    elements.applyStructureButton.disabled = !state.structurePreview?.eligible;
  }
}

async function previewPaperStructure() {
  if (state.sourceDirty) {
    toast("请先保存或放弃当前源码修改，再预览章节拆分。", "error", 5200);
    return;
  }
  setBusy(elements.modularizeButton, true);
  try {
    const preview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
    renderStructurePreview(preview);
    elements.structureDialog.showModal();
  } catch (error) {
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.modularizeButton, false);
  }
}

async function applyPaperStructure(event) {
  event.preventDefault();
  const preview = state.structurePreview;
  if (!preview?.eligible) return;
  setBusy(elements.applyStructureButton, true);
  try {
    const result = await api("/api/project/modularize/apply", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, fingerprint: preview.fingerprint })
    });
    elements.structureDialog.close();
    state.structurePreview = null;
    updateBuild(result.build);
    await refreshProject({ preserveDocument: false });
    setMode("source");
    await loadSourceFile(state.project.config.mainTex, { force: true });
    toast(`章节拆分完成：${result.sections.length} 个章节文件，Bib 文件保持独立。`, "success", 6200);
  } catch (error) {
    if (error.payload?.details?.errors) updateBuild(error.payload.details);
    toast(error.message, "error", 7600);
  } finally {
    setBusy(elements.applyStructureButton, false);
  }
}

async function compileOpenedProject() {
  if (!state.compileOnOpenPending || state.project?.setupRequired || !state.project?.config?.mainTex || state.compileInFlight) return;
  state.compileOnOpenPending = false;
  await compilePaper({ quiet: true });
}

async function compilePaper({ quiet = false } = {}) {
  if (state.compileInFlight) return;
  if (state.project?.mainTexMissing) {
    if (!quiet) toast("请先在设置中选择现有的主 TeX 文件。", "warning");
    return;
  }
  while (state.sourceSaveInFlight) await new Promise((resolve) => window.setTimeout(resolve, 50));
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  const buttons = [document.querySelector("#compileButton"), elements.previewCompileButton];
  buttons.forEach((button) => setBusy(button, true));
  const previousPreviewAvailable = state.buildPreviewAvailable;
  const previousBuild = state.project?.lastBuild || null;
  state.compileInFlight = true;
  updateTranslationBuildLabel();
  renderCompileProgress();
  try {
    const build = await api("/api/compile", { method: "POST", body: "{}" });
    state.compileInFlight = false;
    updateBuild(build);
    invalidateReferences();
    await refreshProject();
    if ((build.success || build.previewAvailable) && !quiet) toast("英文 PDF 已重新编译。", "success");
  } catch (error) {
    state.compileInFlight = false;
    state.buildPreviewAvailable = previousPreviewAvailable;
    if (state.project) state.project.lastBuild = previousBuild;
    updatePdf();
    toast(error.message, "error");
  } finally {
    state.compileInFlight = false;
    updateTranslationBuildLabel();
    buttons.forEach((button) => setBusy(button, false));
    if (state.compileOnOpenPending) void compileOpenedProject();
  }
}

async function changeGitRemoteTarget(event) {
  const remoteName = String(event.currentTarget.value || "");
  if (!remoteName || remoteName === state.gitRemoteName) return;
  const selectedLabel = event.currentTarget.selectedOptions[0]?.textContent || remoteName;
  event.currentTarget.disabled = true;
  try {
    await api("/api/projects/git/default", {
      method: "POST",
      body: JSON.stringify({ projectRoot: state.project.config.projectRoot, remoteName })
    });
    await refreshProject({ remoteName });
    toast(`默认同步目标已切换为 ${selectedLabel}。`, "success", 3600);
  } catch (error) {
    updateProjectHeader();
    toast(error.message, "error", 5200);
  }
}

async function pullPaper() {
  if (state.sourceDirty) {
    toast("请先保存或放弃源码修改，再拉取远端版本。", "error", 5200);
    return;
  }
  const button = document.querySelector("#pullButton");
  const remoteName = state.gitRemoteName;
  const remoteLabel = state.project.git.remoteLabel || "远端仓库";
  setBusy(button, true);
  try {
    const result = await api("/api/git/pull", {
      method: "POST",
      body: JSON.stringify({ remoteName })
    });
    if (result.project) await applyProjectPayload(result.project, { preserveDocument: false });
    else await refreshProject({ preserveDocument: false });
    toast(`已从 ${remoteLabel} 拉取最新版本。`, "success");
  } catch (error) {
    if (await resolveGitSyncConflictFromError(error, "pull")) return;
    toast(error.message, "error", 5200);
  } finally {
    setBusy(button, false);
  }
}

function updateGitPushSelectionCount() {
  const checkboxes = [...elements.gitPushList.querySelectorAll('input[type="checkbox"]')];
  const selected = checkboxes.filter((input) => input.checked).length;
  document.querySelector("#gitPushFileCount").textContent = `已选择 ${selected} / ${checkboxes.length}`;
}

function finishGitPushSelection(value) {
  const resolve = state.gitPushResolver;
  state.gitPushResolver = null;
  if (elements.gitPushDialog.open) elements.gitPushDialog.close();
  if (resolve) resolve(value);
}

function chooseGitPushFiles(preview) {
  elements.gitPushList.replaceChildren();
  for (const item of preview.files || []) {
    const label = document.createElement("label");
    label.className = "git-push-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(item.recommended);
    checkbox.disabled = Boolean(item.committed);
    checkbox.dataset.file = item.file;
    checkbox.dataset.recommended = item.recommended ? "true" : "false";
    checkbox.addEventListener("change", updateGitPushSelectionCount);
    const file = document.createElement("span");
    file.className = "git-push-path";
    file.textContent = item.file;
    const kind = document.createElement("span");
    kind.className = `git-push-kind ${item.recommended ? "recommended" : ""}`;
    kind.textContent = item.committed ? "已有提交" : item.recommended ? "推荐" : item.tracked ? "已跟踪" : "其他";
    label.append(checkbox, file, kind);
    elements.gitPushList.append(label);
  }
  document.querySelector("#selectRecommendedGitFiles").checked = true;
  updateGitPushSelectionCount();
  if (!elements.gitPushDialog.open) elements.gitPushDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.gitPushResolver = resolve;
  });
}

function finishGitConflictSelection(value) {
  const resolve = state.gitConflictResolver;
  state.gitConflictResolver = null;
  if (elements.gitConflictDialog.open) elements.gitConflictDialog.close();
  if (resolve) resolve(value);
}

function renderConflictSnippet(title, snippet, className = "") {
  const panel = document.createElement("div");
  panel.className = `git-conflict-snippet ${className}`.trim();
  const label = document.createElement("div");
  label.className = "git-conflict-snippet-title";
  label.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = snippet || "（没有可预览的文本内容）";
  panel.append(label, pre);
  return panel;
}

function chooseGitSyncConflict(details = {}) {
  const files = details.files || [];
  const autoResolved = details.autoResolvedFiles || [];
  elements.gitConflictList.replaceChildren();
  elements.gitConflictMeta.textContent = autoResolved.length
    ? `已按更新时间自动处理 ${autoResolved.length} 个文件；还有 ${files.length} 个文件需要手动选择`
    : `${details.remoteLabel || "Overleaf"} 与本地共有 ${files.length} 个冲突文件，无法按更新时间判断`;
  files.forEach((item, index) => {
    const row = document.createElement("section");
    row.className = "git-conflict-row";
    row.dataset.file = item.file;
    const header = document.createElement("div");
    header.className = "git-conflict-row-header";
    const pathNode = document.createElement("div");
    pathNode.className = "git-conflict-path";
    pathNode.textContent = item.file;
    const sizeNode = document.createElement("div");
    sizeNode.className = "git-conflict-size";
    const timeNote = item.localUpdatedAt || item.remoteUpdatedAt
      ? ` · 本地 ${item.localUpdatedAt || "未知"} / ${details.remoteLabel || "Overleaf"} ${item.remoteUpdatedAt || "未知"}`
      : "";
    sizeNode.textContent = `本地 ${item.localBytes || 0} B / ${details.remoteLabel || "Overleaf"} ${item.remoteBytes || 0} B${timeNote}`;
    header.append(pathNode, sizeNode);

    const options = document.createElement("div");
    options.className = "git-conflict-options";
    const localOption = document.createElement("label");
    const localRadio = document.createElement("input");
    localRadio.type = "radio";
    localRadio.name = `git-conflict-${index}`;
    localRadio.value = "local";
    localRadio.checked = true;
    localOption.append(localRadio, document.createTextNode("保留本地版本"));
    const remoteOption = document.createElement("label");
    const remoteRadio = document.createElement("input");
    remoteRadio.type = "radio";
    remoteRadio.name = `git-conflict-${index}`;
    remoteRadio.value = "remote";
    remoteOption.append(remoteRadio, document.createTextNode(`保留 ${details.remoteLabel || "Overleaf"} 版本`));
    options.append(localOption, remoteOption);

    const snippets = document.createElement("div");
    snippets.className = "git-conflict-snippets";
    if (item.diffSnippet) snippets.append(renderConflictSnippet("冲突位置", item.diffSnippet, "wide"));
    snippets.append(
      renderConflictSnippet("本地版本", item.localSnippet, "local"),
      renderConflictSnippet(`${details.remoteLabel || "Overleaf"} 版本`, item.remoteSnippet, "remote")
    );

    row.append(header, options, snippets);
    elements.gitConflictList.append(row);
  });
  if (!elements.gitConflictDialog.open) elements.gitConflictDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.gitConflictResolver = resolve;
  });
}

async function resolveGitSyncConflictFromError(error, operation) {
  if (error.status !== 409 || error.payload?.code !== "GIT_SYNC_CONFLICT") return false;
  const details = error.payload.details || {};
  const choices = await chooseGitSyncConflict(details);
  if (!choices) {
    toast("已取消冲突合并。本地内容和远端内容都没有被覆盖。", "error", 5600);
    return true;
  }
  toast("正在按你的选择合并冲突...", "success", 3600);
  const result = await api("/api/git/resolve-conflict", {
    method: "POST",
    body: JSON.stringify({
      operation: details.operation || operation,
      files: choices,
      remoteName: details.remoteName || state.gitRemoteName,
      message: operation === "push"
        ? "Resolve remote conflict before pushing"
        : "Resolve remote conflict after pulling"
    })
  });
  updateBuild(result.build);
  if (result.project) await applyProjectPayload(result.project, { preserveDocument: false });
  else await refreshProject({ preserveDocument: false });
  toast(
    operation === "push"
      ? (result.pushed ? `已按选择合并并推送到 ${details.remoteLabel || "远端仓库"}。` : "已按选择合并，没有新的提交需要推送。")
      : `已按选择合并 ${details.remoteLabel || "远端仓库"} 的修改。`,
    "success",
    6200
  );
  return true;
}

function summarizeChangedGitFiles(files = [], limit = 3) {
  const names = files.map((file) => String(file || "").replace(/^[ MADRCU?!]{1,2}\s+/, "").trim()).filter(Boolean);
  if (names.length <= limit) return names.join("、");
  return `${names.slice(0, limit).join("、")} 等`;
}

async function pushPaper() {
  if (state.sourceDirty) {
    toast("请先保存源码修改，再推送论文。", "error", 5200);
    return;
  }
  const button = document.querySelector("#pushButton");
  const remoteName = state.gitRemoteName;
  const remoteLabel = state.project.git.remoteLabel || "远端仓库";
  let selection = null;
  setBusy(button, true);
  try {
    toast("正在检查待推送文件...", "success", 2400);
    const preview = await api(`/api/git/push-preview?remoteName=${encodeURIComponent(remoteName)}`);
    if (preview.required) {
      toast("首次推送需要确认上传文件，请在弹窗中点击“确认并推送”。", "success", 5200);
      selection = await chooseGitPushFiles(preview);
      if (!selection) {
        toast("已取消推送，本地文件没有上传。", "error", 4200);
        return;
      }
    }
    toast(`正在提交并推送到 ${remoteLabel}...`, "success", 4200);
    const result = await api("/api/git/push", {
      method: "POST",
      body: JSON.stringify({
        message: "Update bilingual paper draft",
        confirmed: Boolean(selection),
        files: selection || [],
        remoteName
      })
    });
    updateBuild(result.build);
    if (result.project) await applyProjectPayload(result.project);
    else await refreshProject();
    const git = result.project?.git || result.status || state.project?.git;
    const pending = git?.changedFiles?.length || 0;
    if (pending) {
      const examples = summarizeChangedGitFiles(git.changedFiles);
      toast(
        result.pushed
          ? `已推送远端，但仍有 ${pending} 个本地文件未提交：${examples}`
          : `没有新的提交被推送，仍有 ${pending} 个本地文件未提交：${examples}`,
        "error",
        7600
      );
    } else {
      toast(result.pushed ? `已推送至 ${remoteLabel}。` : `没有需要推送到 ${remoteLabel} 的修改。`, "success", 5200);
    }
  } catch (error) {
    updateBuild(error.payload?.details);
    if (await resolveGitSyncConflictFromError(error, "push")) return;
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

async function translateCurrentFile() {
  if (!state.currentFile || !state.currentDocument) return;
  const translationFile = state.currentFile;
  if (state.fileTranslationJobs.has(translationFile)) {
    state.visibleTranslationJobFile = translationFile;
    renderFileTranslationProgress(translationFile);
    toast(`${translationFile} 正在后台翻译，可以继续查看或编辑其他 TeX。`, "success", 4200);
    return;
  }
  const pendingIds = state.currentDocument.segments
    .map((segment) => segment.id);
  if (!pendingIds.length) {
    toast("当前 TeX 文件没有可翻译的段落。", "success");
    return;
  }
  const currentFileLabel = translationFile;
  const total = pendingIds.length;
  const job = {
    file: translationFile,
    total,
    completed: 0,
    translated: 0,
    skipped: 0,
    label: `${currentFileLabel} · 正在提取术语表...`,
    statusClass: ""
  };
  state.fileTranslationJobs.set(translationFile, job);
  state.visibleTranslationJobFile = translationFile;
  renderFileTranslationProgress(translationFile);
  try {
    const terminology = await api("/api/file/terminology", {
      method: "POST",
      body: JSON.stringify({ file: translationFile })
    });
    job.label = `${currentFileLabel} · 术语表 ${terminology.entries?.length || 0} 条，正在准备翻译...`;
    renderFileTranslationProgress(translationFile);
    const batchSize = 8;
    for (let offset = 0; offset < pendingIds.length; offset += batchSize) {
      const segmentIds = pendingIds.slice(offset, offset + batchSize);
      const end = Math.min(offset + segmentIds.length, total);
      job.label = `${currentFileLabel} · 正在翻译第 ${offset + 1}-${end} 段...`;
      renderFileTranslationProgress(translationFile);
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({ file: translationFile, segmentIds, force: true })
      });
      if (state.currentFile === translationFile) {
        state.currentDocument = result.document;
        renderSegments();
      }
      job.completed += result.progress?.attempted ?? segmentIds.length;
      job.translated += result.progress?.translated ?? 0;
      job.skipped += result.progress?.skipped ?? 0;
      job.label = `${currentFileLabel} · 已处理 ${job.completed} 个段落`;
      renderFileTranslationProgress(translationFile);
    }
    scheduleProjectRefresh();
    if (job.skipped) {
      finishFileTranslationJob(translationFile, {
        label: `${currentFileLabel} · 翻译完成，${job.skipped} 段未收到有效结果`,
        statusClass: "warning"
      });
      toast(`${currentFileLabel} 中文工作稿已更新，模型没有返回其中 ${job.skipped} 个段落的有效翻译。`, "error", 5600);
    } else {
      finishFileTranslationJob(translationFile, {
        label: `${currentFileLabel} · 翻译完成，共更新 ${job.translated} 个段落`,
        statusClass: ""
      });
      toast(`${currentFileLabel} 的中文工作稿已更新。`, "success");
    }
  } catch (error) {
    if (state.currentFile === translationFile && state.currentDocument) renderSegments();
    finishFileTranslationJob(translationFile, {
      label: `${currentFileLabel} · 翻译中断：${error.message}`,
      statusClass: "error"
    });
    toast(error.message, "error", 5600);
  }
}

async function exportPdf() {
  if (state.compileInFlight || state.buildPreviewAvailable === false) {
    elements.buildDrawer.classList.remove("hidden");
    toast(
      state.compileInFlight
        ? "PDF 仍在编译，完成后才能导出。"
        : "本次编译失败，旧 PDF 已停用，不能导出。请先修复错误并重新编译。",
      "error",
      5200
    );
    return;
  }
  const name = state.project?.config?.mainTex?.replace(/\.tex$/i, ".pdf") || "paper.pdf";
  const exportToken = ++state.pdfExportToken;
  const previousStatus = elements.pageStatus.textContent;
  const exportStatuses = new Set(["正在保存 PDF...", "PDF 已保存", "已取消保存 PDF", "PDF 下载已开始", "PDF 保存失败"]);
  setBusy(elements.exportPdfButton, true);
  elements.pageStatus.textContent = "正在保存 PDF...";
  try {
    if (window.paperBridgeDesktop) {
      const destination = await window.paperBridgeDesktop.exportPdf(name);
      if (destination) {
        elements.pageStatus.textContent = "PDF 已保存";
        toast(`PDF 已导出到 ${destination}`, "success", 5200);
      } else {
        elements.pageStatus.textContent = "已取消保存 PDF";
        toast("已取消保存 PDF。", "success", 2600);
      }
      return;
    }
    const link = document.createElement("a");
    link.href = "/api/pdf";
    link.download = name;
    link.click();
    elements.pageStatus.textContent = "PDF 下载已开始";
    toast("PDF 下载已开始。", "success", 3200);
  } catch (error) {
    elements.pageStatus.textContent = "PDF 保存失败";
    toast(error.message, "error");
  } finally {
    setBusy(elements.exportPdfButton, false);
    window.setTimeout(() => {
      if (state.pdfExportToken === exportToken && exportStatuses.has(elements.pageStatus.textContent)) {
        elements.pageStatus.textContent = previousStatus;
      }
    }, 2200);
  }
}

function updateModeButtons() {
  const bilingual = document.querySelector('#fileEditorModes [data-mode="edit"]');
  bilingual.disabled = state.mode === "source" && (!/\.tex$/i.test(state.sourceFile || "") || !elements.projectFilePreview.classList.contains("hidden"));
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.mode === "references"
      ? state.referencesOpen
      : button.dataset.mode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setReferencesOpen(open) {
  const anchor = state.pdfDocument ? capturePdfViewportAnchor() : null;
  state.referencesOpen = Boolean(open);
  if (state.referencesOpen) setSourceFocus(false);
  elements.workspace.classList.toggle("references-open", state.referencesOpen);
  elements.referencesView.classList.toggle("hidden", !state.referencesOpen);
  updateModeButtons();
  if (state.referencesOpen) void loadReferences();
  schedulePdfPanelResize(anchor);
  return true;
}

function setSourceFocus(focused) {
  const active = Boolean(focused) && state.mode === "source";
  elements.workspace.classList.toggle("source-focused", active);
  if (!elements.sourceFocusButton) return;
  elements.sourceFocusButton.setAttribute("aria-pressed", String(active));
  elements.sourceFocusButton.title = active ? "退出专注编辑" : "专注编辑源码";
  elements.sourceFocusButton.setAttribute("aria-label", elements.sourceFocusButton.title);
  const icon = elements.sourceFocusButton.querySelector("[data-lucide], svg");
  if (icon) icon.setAttribute("data-lucide", active ? "minimize-2" : "maximize-2");
  refreshIcons();
}

function setMode(mode, { loadCurrent = true, keepReferences = true } = {}) {
  const translationFile = state.mode === "source" && /\.tex$/i.test(state.sourceFile || "")
    ? state.sourceFile : state.currentFile || state.project?.texFiles?.[0];
  if (mode === "references") return setReferencesOpen(!state.referencesOpen);
  if (state.referencesOpen && !keepReferences) setReferencesOpen(false);
  if (state.mode === "source" && mode !== "source" && state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    elements.sourceEditor.value = state.sourceSavedContent;
    updateSourceLineNumbers();
    setSourceDirty(false);
  }
  state.mode = mode;
  elements.workspace.dataset.mode = mode;
  translationLayout();
  document.querySelector(mode === "edit" ? "#translationModeSlot" : "#sourceModeSlot").prepend(document.querySelector("#fileEditorModes"));
  state.reviewSelection = null;
  if (mode !== "source") setSourceFocus(false);
  updateModeButtons();
  elements.editView.classList.toggle("hidden", mode !== "edit");
  elements.sourceView.classList.toggle("hidden", mode !== "source");
  if (mode === "source") {
    renderSourceFileOptions(loadCurrent ? state.currentFile : state.sourceFile);
    if (loadCurrent) void loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (mode === "edit" && translationFile && loadCurrent) void loadDocument(translationFile);
  return true;
}

function providerMarkup(prefix) {
  return `
    <label class="field">
      <span>接口类型</span>
      <select id="${prefix}Type">
        <option value="openai-compatible">OpenAI-compatible</option>
        <option value="anthropic">Anthropic Messages</option>
        <option value="gemini">Gemini GenerateContent</option>
      </select>
    </label>
    <label class="field">
      <span>模型</span>
      <input id="${prefix}Model" type="text" autocomplete="off">
    </label>
    <label class="field wide">
      <span>Base URL</span>
      <input id="${prefix}BaseUrl" type="text" autocomplete="off">
    </label>
    <label class="field">
      <span>API Key</span>
      <input id="${prefix}ApiKey" type="password" autocomplete="new-password">
      <small class="field-note provider-key-status" id="${prefix}ApiKeyStatus"></small>
    </label>
    <label class="field">
      <span>自定义路径</span>
      <input id="${prefix}ApiPath" type="text" autocomplete="off" placeholder="可留空">
    </label>
    <label class="field wide">
      <span>附加 Headers (JSON)</span>
      <input id="${prefix}ExtraHeaders" type="text" autocomplete="off" placeholder='{"X-Provider-Key":"..."}'>
    </label>
    <label class="toggle-row field wide">
      <input id="${prefix}JsonMode" type="checkbox">
      <span>接口支持 JSON response_format</span>
    </label>
  `;
}

function fillProvider(prefix, profile) {
  document.querySelector(`#${prefix}Type`).value = profile.type || "openai-compatible";
  document.querySelector(`#${prefix}Model`).value = profile.model || "";
  document.querySelector(`#${prefix}BaseUrl`).value = profile.baseUrl || "";
  document.querySelector(`#${prefix}ApiKey`).value = "";
  document.querySelector(`#${prefix}ApiKey`).placeholder = profile.hasApiKey ? "已保存，留空保持不变" : "";
  const keyStatus = document.querySelector(`#${prefix}ApiKeyStatus`);
  keyStatus.textContent = profile.hasApiKey ? "已保存 API Key" : "尚未配置 API Key";
  keyStatus.classList.toggle("missing", !profile.hasApiKey);
  document.querySelector(`#${prefix}ApiPath`).value = profile.apiPath || "";
  document.querySelector(`#${prefix}ExtraHeaders`).value = profile.extraHeaders || "";
  document.querySelector(`#${prefix}JsonMode`).checked = Boolean(profile.jsonMode);
}

function collectProvider(prefix) {
  return {
    type: document.querySelector(`#${prefix}Type`).value,
    model: document.querySelector(`#${prefix}Model`).value.trim(),
    baseUrl: document.querySelector(`#${prefix}BaseUrl`).value.trim(),
    apiKey: document.querySelector(`#${prefix}ApiKey`).value.trim(),
    apiPath: document.querySelector(`#${prefix}ApiPath`).value.trim(),
    extraHeaders: document.querySelector(`#${prefix}ExtraHeaders`).value.trim(),
    jsonMode: document.querySelector(`#${prefix}JsonMode`).checked
  };
}

function openSettings() {
  const config = state.project.config;
  state.storageRootSelected = false;
  document.querySelector("#storageRootInput").value = config.storageRoot || config.suggestedStorageRoot || "";
  document.querySelector("#chooseStorageFolderButton").disabled = config.canChangeStorage === false;
  document.querySelector("#migrateStorageButton").disabled = true;
  document.querySelector("#projectRootInput").value = config.projectRoot;
  document.querySelector("#projectNameInput").value = config.projectName || fileLabel(config.projectRoot || "论文项目");
  const overleafToken = document.querySelector("#overleafTokenInput");
  overleafToken.value = "";
  overleafToken.placeholder = config.hasOverleafToken ? "已保存，留空保持不变" : "用于自动拉取和推送";
  document.querySelector("#clearOverleafTokenButton").disabled = !config.hasOverleafToken;
  document.querySelector("#gitUsernameInput").value = config.gitUsername || "";
  const gitToken = document.querySelector("#gitTokenInput");
  gitToken.value = "";
  gitToken.placeholder = config.hasGitToken ? "已保存，留空保持不变" : "私有仓库使用 Personal Access Token";
  document.querySelector("#mainTexInput").value = config.mainTex;
  const mainTexCandidates = document.querySelector("#mainTexCandidates");
  mainTexCandidates.replaceChildren();
  for (const file of state.project.mainTexCandidates || []) {
    const option = document.createElement("option");
    option.value = file;
    mainTexCandidates.append(option);
  }
  document.querySelectorAll(".provider-grid").forEach((container) => {
    const prefix = container.dataset.provider;
    container.innerHTML = providerMarkup(prefix);
    fillProvider(prefix, config[prefix]);
  });
  updateStorageMigrationButton();
  refreshIcons();
  elements.settingsDialog.showModal();
}

function updateStorageMigrationButton() {
  const config = state.project?.config || {};
  const input = document.querySelector("#storageRootInput");
  const migrateButton = document.querySelector("#migrateStorageButton");
  const note = document.querySelector("#storageMigrationNote");
  const value = input.value.trim();
  const canChange = config.canChangeStorage !== false;
  const changed = state.storageRootSelected && value && value !== config.storageRoot;
  migrateButton.disabled = !canChange || !changed;
  if (!canChange) {
    note.textContent = "当前运行方式不支持在软件内迁移数据目录。";
  } else if (changed) {
    note.textContent = "已选择新的数据位置。确认无误后，点击“迁移数据目录”执行迁移；仅保存设置不会迁移数据。";
  } else {
    note.textContent = "选择新的空文件夹后，点击“迁移数据目录”才会迁移配置、中文工作稿、备份和 PaperBridge 导入的项目；外部本地项目不会移动。";
  }
}

async function migrateStorageFromSettings() {
  const previous = state.project.config;
  const storageRoot = document.querySelector("#storageRootInput").value.trim();
  const storageChanged = state.storageRootSelected && storageRoot && storageRoot !== previous.storageRoot;
  if (!storageChanged) {
    toast("请先选择一个新的数据保存位置。", "warning");
    return false;
  }
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    state.sourceDirty = false;
  }
  const confirmed = window.confirm([
    "PaperBridge 将把配置、中文工作稿、备份和已导入的项目迁移到新位置。",
    "外部打开的本地论文文件夹不会移动。迁移完成前请勿关闭程序。",
    "",
    `新位置：${storageRoot}`
  ].join("\n"));
  if (!confirmed) return false;
  const button = document.querySelector("#migrateStorageButton");
  setBusy(button, true);
  try {
    const oldProjectRoot = previous.projectRoot;
    let projectRoot = document.querySelector("#projectRootInput").value.trim();
    const result = await api("/api/storage/migrate", {
      method: "POST",
      body: JSON.stringify({ storageRoot })
    });
    state.project = result.project;
    const nextConfig = state.project.config;
    if (projectRoot === oldProjectRoot) projectRoot = nextConfig.projectRoot;
    document.querySelector("#storageRootInput").value = nextConfig.storageRoot;
    document.querySelector("#projectRootInput").value = projectRoot;
    state.storageRootSelected = false;
    updateStorageMigrationButton();
    await refreshProject({ preserveDocument: false });
    if (result.migration.cleanupWarning) toast(result.migration.cleanupWarning, "error", 7000);
    toast("数据目录迁移完成。", "success");
    return true;
  } catch (error) {
    toast(error.message, "error", 7000);
    return false;
  } finally {
    setBusy(button, false);
    updateStorageMigrationButton();
  }
}

async function clearOverleafToken() {
  const button = document.querySelector("#clearOverleafTokenButton");
  if (!state.project.config?.hasOverleafToken && !document.querySelector("#overleafTokenInput").value.trim()) {
    toast("当前没有已保存的 Overleaf Token。", "warning");
    return;
  }
  if (!window.confirm("确定清除已保存的 Overleaf Git Token 吗？清除后，Overleaf 拉取和推送需要重新填写 Token。")) return;
  setBusy(button, true);
  try {
    const next = await api("/api/config/clear-overleaf-token", { method: "POST", body: "{}" });
    state.project.config = { ...state.project.config, ...next };
    const input = document.querySelector("#overleafTokenInput");
    input.value = "";
    input.placeholder = "用于自动拉取和推送";
    button.disabled = true;
    toast("已清除保存的 Overleaf Token。", "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(button, false);
  }
}

async function saveSettings({ close = true } = {}) {
  let previous = state.project.config;
  let projectRoot = document.querySelector("#projectRootInput").value.trim();
  const mainTex = document.querySelector("#mainTexInput").value.trim();
  const projectName = document.querySelector("#projectNameInput").value.trim();
  const storageRoot = document.querySelector("#storageRootInput").value.trim();
  const storageChanged = state.storageRootSelected && storageRoot && storageRoot !== previous.storageRoot;
  if ((projectRoot !== previous.projectRoot || mainTex !== previous.mainTex) && state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    state.sourceDirty = false;
  }
  if (storageChanged) {
    toast("数据目录不会随“保存设置”自动迁移。请点击“迁移数据目录”按钮执行迁移。", "warning", 6500);
    return false;
  }
  const next = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      autoCompile: false,
      overleafToken: document.querySelector("#overleafTokenInput").value.trim(),
      gitUsername: document.querySelector("#gitUsernameInput").value.trim(),
      gitToken: document.querySelector("#gitTokenInput").value.trim(),
      translation: collectProvider("translation"),
      diagnosis: collectProvider("diagnosis")
    })
  });
  if (projectRoot !== previous.projectRoot || mainTex !== previous.mainTex) {
    await api("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ projectRoot, mainTex })
    });
  }
  await api("/api/project/name", {
    method: "POST",
    body: JSON.stringify({ projectRoot, mainTex, name: projectName })
  });
  state.project.config = next;
  await refreshProject({ preserveDocument: false });
  if (close) elements.settingsDialog.close();
  toast("设置已保存。", "success");
}

async function testProvider(purpose, button) {
  setBusy(button, true);
  try {
    await saveSettings({ close: false });
    const result = await api("/api/provider/test", {
      method: "POST",
      body: JSON.stringify({ purpose })
    });
    toast(result.ok ? "接口连接成功。" : `接口已响应：${result.response}`, result.ok ? "success" : "error");
  } catch (error) {
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  ensureSourceSearchControls();
  document.querySelectorAll("[data-sidebar-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.dataset.sidebarPanel;
      const closing = !state.referencesOpen && state.sidebarPanel === panel;
      setSourceFocus(false);
      setSidebarPanel(closing ? "" : panel);
    });
  });
  document.querySelector("#closeSidebarButton").addEventListener("click", () => {
    document.querySelector(`[data-sidebar-panel="${state.sidebarPanel}"]`)?.focus();
    setSidebarPanel("");
  });
  document.querySelectorAll('input[name="bilingualLayout"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) chooseTranslationLayout(input.value === "horizontal" ? "wide" : "compare");
    });
  });
  document.querySelector("#closeSettingsButton").addEventListener("click", () => elements.settingsDialog.close());
  document.querySelector("#toggleSourceSearchButton").addEventListener("click", () => {
    if (elements.sourceView.classList.contains("search-open")) closeSourceSearch();
    else focusSourceSearch();
  });
  document.querySelectorAll("#syncPopover button").forEach((button) => {
    button.addEventListener("click", () => document.querySelector("#syncPopover").hidePopover());
  });
  elements.undoButton.addEventListener("click", () => void undoLastChange());
  document.querySelector("#compileButton").addEventListener("click", compilePaper);
  elements.previewCompileButton.addEventListener("click", compilePaper);
  elements.gitRemoteSelect.addEventListener("change", changeGitRemoteTarget);
  document.querySelector("#closeGitManagerButton").addEventListener("click", closeGitManager);
  document.querySelector("#addGitRemoteButton").addEventListener("click", () => showGitRemoteForm());
  document.querySelector("#cancelGitRemoteButton").addEventListener("click", hideGitRemoteForm);
  document.querySelector("#testGitRemoteButton").addEventListener("click", testGitRemoteForm);
  elements.gitRemoteProvider.addEventListener("change", () => updateGitRemoteProviderForm({ preserveCredential: false }));
  elements.gitRemoteForm.addEventListener("submit", saveGitRemote);
  document.querySelector("#addGitCredentialButton").addEventListener("click", () => showGitCredentialForm());
  document.querySelector("#cancelGitCredentialButton").addEventListener("click", hideGitCredentialForm);
  elements.gitCredentialProvider.addEventListener("change", updateGitCredentialProviderForm);
  elements.gitCredentialForm.addEventListener("submit", saveGitCredential);
  elements.gitManagerDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeGitManager();
  });
  document.querySelector("#pullButton").addEventListener("click", pullPaper);
  document.querySelector("#pushButton").addEventListener("click", pushPaper);
  for (const [button, direction] of [[elements.translateSectionButton, "en"], [document.querySelector("#translateFileButton"), "zh"]]) {
    button.addEventListener("click", () => {
      state.translationDirection = direction;
      localStorage.setItem("paperBridge.translationDirection", direction);
      updateTranslationDirection();
    });
  }
  document.querySelector("#translateScopeButton").addEventListener("click", () => {
    if (state.translationDirection === "zh") void translateCurrentFile();
    else translateCurrentSection();
  });
  document.querySelectorAll("button[data-translation-layout]").forEach((button) => {
    button.addEventListener("click", () => chooseTranslationLayout(button.dataset.translationLayout));
  });
  document.querySelector("#translationExpandButton").addEventListener("click", () => setTranslationExpanded(!state.translationExpanded));
  for (const name of ["Size", "Leading", "Width", "Font"]) {
    document.querySelector("#translationReading" + name).addEventListener("change", (event) => {
      localStorage.setItem("paperBridge.translationReading" + name, event.currentTarget.value);
      applyReadingSettings();
    });
  }
  elements.terminologyButton.addEventListener("click", openTerminologyDialog);
  document.querySelector("#closeTerminologyButton").addEventListener("click", closeTerminologyDialog);
  document.querySelector("#cancelTerminologyButton").addEventListener("click", closeTerminologyDialog);
  elements.terminologyDialog.addEventListener("cancel", (event) => {
    if (!state.terminologyDirty) return;
    if (!window.confirm("术语表有未保存修改，确定关闭吗？")) event.preventDefault();
  });
  elements.terminologyDialog.addEventListener("close", () => {
    state.terminologyFile = null;
    state.terminologyEntries = [];
    state.terminologyDirty = false;
  });
  elements.terminologySearch.addEventListener("input", renderTerminologyEntries);
  elements.addTerminologyButton.addEventListener("click", addTerminologyEntry);
  elements.saveTerminologyButton.addEventListener("click", saveTerminology);
  elements.regenerateTerminologyButton.addEventListener("click", regenerateTerminology);
  elements.applyTerminologyDefinitionsButton.addEventListener("click", applyTerminologyDefinitions);
  elements.closeReferencesButton.addEventListener("click", () => setReferencesOpen(false));
  document.querySelector("#closeReferenceInsertButton").addEventListener("click", closeReferenceInsertDialog);
  document.querySelector("#cancelReferenceInsertButton").addEventListener("click", closeReferenceInsertDialog);
  elements.referenceInsertDialog.addEventListener("cancel", () => closeCitationContextMenu());
  elements.referenceInsertForm.addEventListener("submit", (event) => event.preventDefault());
  elements.sidebarResizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    elements.sidebarResizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-resizing");
    event.preventDefault();
  });
  elements.sidebarResizeHandle.addEventListener("pointermove", (event) => {
    if (elements.sidebarResizeHandle.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX);
  });
  const finishSidebarResize = (event) => {
    if (elements.sidebarResizeHandle.hasPointerCapture(event.pointerId)) elements.sidebarResizeHandle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("sidebar-resizing");
    applySidebarWidth();
  };
  elements.sidebarResizeHandle.addEventListener("pointerup", finishSidebarResize);
  elements.sidebarResizeHandle.addEventListener("pointercancel", finishSidebarResize);
  elements.sidebarResizeHandle.addEventListener("lostpointercapture", () => {
    document.body.classList.remove("sidebar-resizing");
  });
  elements.sidebarResizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    state.sidebarWidth = event.key === "Home" ? 160 : Math.min(480, Math.max(120, state.sidebarWidth + (event.key === "ArrowRight" ? 10 : -10)));
    applySidebarWidth();
  });
  elements.sidebarResizeHandle.addEventListener("dblclick", () => {
    state.sidebarWidth = 160;
    applySidebarWidth();
  });
  elements.workspaceSplitHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    elements.workspaceSplitHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-split-dragging");
    setWorkspaceSplit(event.clientX);
    event.preventDefault();
  });
  elements.workspaceSplitHandle.addEventListener("pointermove", (event) => {
    if (!elements.workspaceSplitHandle.hasPointerCapture(event.pointerId)) return;
    setWorkspaceSplit(event.clientX);
  });
  const finishWorkspaceSplit = (event) => {
    if (elements.workspaceSplitHandle.hasPointerCapture(event.pointerId)) {
      elements.workspaceSplitHandle.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("workspace-split-dragging");
    applyWorkspaceSplit();
  };
  elements.workspaceSplitHandle.addEventListener("pointerup", finishWorkspaceSplit);
  elements.workspaceSplitHandle.addEventListener("pointercancel", finishWorkspaceSplit);
  elements.workspaceSplitHandle.addEventListener("lostpointercapture", () => {
    document.body.classList.remove("workspace-split-dragging");
    applyWorkspaceSplit();
  });
  elements.workspaceSplitHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    state.workspaceSplit = Math.min(72, Math.max(32, state.workspaceSplit + (event.key === "ArrowRight" ? 2 : -2)));
    applyWorkspaceSplit();
  });
  elements.workspaceSplitHandle.addEventListener("dblclick", () => {
    state.workspaceSplit = 54;
    applyWorkspaceSplit();
  });
  elements.splitHandle.addEventListener("pointerdown", (event) => {
    elements.splitHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("split-dragging");
    setBilingualSplit(event.clientX);
  });
  elements.splitHandle.addEventListener("pointermove", (event) => {
    if (!elements.splitHandle.hasPointerCapture(event.pointerId)) return;
    setBilingualSplit(event.clientX);
  });
  elements.splitHandle.addEventListener("pointerup", (event) => {
    if (elements.splitHandle.hasPointerCapture(event.pointerId)) elements.splitHandle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("split-dragging");
    localStorage.setItem("paperBridge.bilingualSplit", String(state.bilingualSplit));
  });
  elements.splitHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    state.bilingualSplit = Math.min(70, Math.max(30, state.bilingualSplit + (event.key === "ArrowRight" ? 2 : -2)));
    applyEditorPreferences();
  });
  document.querySelector("#settingsButton").addEventListener("click", openSettings);
  document.querySelector("#addProjectButton").addEventListener("click", () => openSetup(state.project, { switching: true }));
  elements.openProjectFolderButton.title = projectFolderActionLabel();
  elements.openProjectFolderButton.setAttribute("aria-label", elements.openProjectFolderButton.title);
  elements.openProjectFolderButton.addEventListener("click", () => void openProjectFolder(state.project?.config?.projectRoot));
  document.querySelector("#closeSetupButton").addEventListener("click", () => elements.setupDialog.close());
  document.querySelectorAll('input[name="setupSource"]').forEach((input) => input.addEventListener("change", updateSetupSource));
  document.querySelector("#setupConnectGit").addEventListener("change", updateOptionalGitFields);
  document.querySelector("#setupProviderType").addEventListener("change", updateSetupProviderDefaults);
  document.querySelector("#setupModel").addEventListener("change", updateSetupCustomModel);
  document.querySelector("#chooseZipButton").addEventListener("click", () => chooseDesktopPath("zip", document.querySelector("#setupZipPath")));
  document.querySelector("#chooseLocalButton").addEventListener("click", () => chooseDesktopPath("folder", document.querySelector("#setupLocalPath")));
  document.querySelector("#chooseSetupStorageButton").addEventListener("click", () => chooseStoragePath(document.querySelector("#setupStorageRoot")));
  document.querySelector("#chooseStorageFolderButton").addEventListener("click", async () => {
    if (await chooseStoragePath(document.querySelector("#storageRootInput"))) {
      state.storageRootSelected = true;
      updateStorageMigrationButton();
    }
  });
  document.querySelector("#migrateStorageButton").addEventListener("click", migrateStorageFromSettings);
  document.querySelector("#storageRootInput").addEventListener("input", () => {
    state.storageRootSelected = true;
    updateStorageMigrationButton();
  });
  document.querySelector("#chooseSettingsFolderButton").addEventListener("click", async () => {
    const input = document.querySelector("#projectRootInput");
    await chooseDesktopPath("folder", input);
    if (input.value) document.querySelector("#mainTexInput").value = "";
  });
  const openOverleafTokenPage = () => {
    const url = "https://cn.overleaf.com/user/settings";
    if (window.paperBridgeDesktop) window.paperBridgeDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };
  document.querySelector("#openOverleafTokenButton").addEventListener("click", openOverleafTokenPage);
  document.querySelector("#openSettingsOverleafTokenButton").addEventListener("click", openOverleafTokenPage);
  document.querySelector("#clearOverleafTokenButton").addEventListener("click", clearOverleafToken);
  document.querySelector("#setupTestButton").addEventListener("click", testSetupProvider);
  elements.setupForm.addEventListener("submit", submitSetup);
  elements.mainTexForm.addEventListener("submit", (event) => {
    event.preventDefault();
    finishMainTexSelection();
  });
  elements.mainTexDialog.addEventListener("cancel", (event) => event.preventDefault());
  elements.paragraphForm.addEventListener("submit", submitNewParagraph);
  document.querySelector("#closeParagraphButton").addEventListener("click", closeParagraphDialog);
  document.querySelector("#cancelParagraphButton").addEventListener("click", closeParagraphDialog);
  elements.paragraphDialog.addEventListener("close", () => {
    state.paragraphAnchor = null;
  });
  elements.insertFigureSourceButton.addEventListener("click", () => {
    const menu = elements.sourceInsertMenu;
    const open = menu?.classList.toggle("hidden") === false;
    elements.insertFigureSourceButton.setAttribute("aria-expanded", String(open));
  });
  elements.sourceInsertMenu?.querySelectorAll("[data-insert-kind]").forEach((button) => {
    button.addEventListener("click", async () => {
      elements.sourceInsertMenu.classList.add("hidden");
      elements.insertFigureSourceButton.setAttribute("aria-expanded", "false");
      if (button.dataset.insertKind === "figure") {
        await openSourceFigureDialog();
        return;
      }
      if (!state.sourceFile) {
        toast("请先选择一个 TeX 文件。", "error");
        return;
      }
      if (!state.sourceFile.toLowerCase().endsWith(".tex")) {
        toast("表格和公式只能插入 TeX 文件。", "error");
        return;
      }
      if (state.sourceDirty) {
        const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
        if (!saved) return;
      }
      openStructureDialog(button.dataset.insertKind, {
        type: "source",
        file: state.sourceFile,
        sourceHash: state.sourceHash,
        cursorOffset: elements.sourceEditor.selectionStart || 0
      });
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".source-insert-menu")) {
      elements.sourceInsertMenu?.classList.add("hidden");
      elements.insertFigureSourceButton?.setAttribute("aria-expanded", "false");
    }
  });
  elements.structureTypeInput?.addEventListener("change", () => syncStructureDialogType());
  [elements.insertTableRows, elements.insertTableColumns].filter(Boolean).forEach((input) => {
    input.addEventListener("input", renderInsertTableGrid);
    input.addEventListener("focus", () => input.select());
  });
  elements.figureForm.addEventListener("submit", submitFigureInsertion);
  [
    elements.figureSpanInput,
    elements.figureAlignmentInput,
    elements.figureArrangementInput,
    elements.figurePositionInput
  ].filter(Boolean).forEach((input) => input.addEventListener("input", renderFigureGrid));
  [
    elements.figureSpanInput,
    elements.figureAlignmentInput,
    elements.figureArrangementInput,
    elements.figurePositionInput
  ].filter(Boolean).forEach((input) => input.addEventListener("change", renderFigureGrid));
  [elements.figureImageCountInput, elements.figureColumnsInput]
    .filter(Boolean)
    .forEach((input) => input.addEventListener("input", handleFigureNumberInput));
  [elements.figureImageCountInput, elements.figureColumnsInput]
    .filter(Boolean)
    .forEach((input) => input.addEventListener("change", commitFigureNumberInput));
  [elements.figureImageCountInput, elements.figureColumnsInput]
    .filter(Boolean)
    .forEach((input) => input.addEventListener("blur", commitFigureNumberInput));
  elements.chooseExternalFigureButton?.addEventListener("click", () => elements.figureExternalInput?.click());
  elements.figureExternalInput?.addEventListener("change", () => void handleExternalFigureFiles());
  [elements.figureImageCountInput, elements.figureColumnsInput]
    .filter(Boolean)
    .forEach((input) => input.addEventListener("focus", focusFigureCountInput));
  document.querySelector("#closeFigureButton").addEventListener("click", closeFigureDialog);
  document.querySelector("#cancelFigureButton").addEventListener("click", closeFigureDialog);
  elements.figureDialog.addEventListener("close", () => {
    state.figureAnchor = null;
  });
  document.querySelector("#selectRecommendedGitFiles").addEventListener("change", (event) => {
    elements.gitPushList.querySelectorAll('input[data-recommended="true"]').forEach((input) => {
      if (!input.disabled) input.checked = event.currentTarget.checked;
    });
    updateGitPushSelectionCount();
  });
  elements.gitPushForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = [...elements.gitPushList.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.dataset.file);
    if (!files.length) {
      toast("请至少选择一个需要上传的论文文件。", "error");
      return;
    }
    finishGitPushSelection(files);
  });
  document.querySelector("#closeGitPushButton").addEventListener("click", () => finishGitPushSelection(null));
  document.querySelector("#cancelGitPushButton").addEventListener("click", () => finishGitPushSelection(null));
  elements.gitPushDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGitPushSelection(null);
  });
  elements.gitConflictForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = [...elements.gitConflictList.querySelectorAll(".git-conflict-row")].map((row) => ({
      file: row.dataset.file,
      choice: row.querySelector('input[type="radio"]:checked')?.value || "local"
    }));
    if (!files.length) {
      toast("没有检测到可处理的冲突文件。", "error");
      finishGitConflictSelection(null);
      return;
    }
    finishGitConflictSelection(files);
  });
  document.querySelector("#closeGitConflictButton").addEventListener("click", () => finishGitConflictSelection(null));
  document.querySelector("#cancelGitConflictButton").addEventListener("click", () => finishGitConflictSelection(null));
  elements.gitConflictDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGitConflictSelection(null);
  });
  document.querySelector("#refreshPdfButton").addEventListener("click", () => {
    state.pdfRenderKey = "";
    updatePdf();
  });
  elements.exportPdfButton.addEventListener("click", exportPdf);
  document.querySelector("#previousPageButton").addEventListener("click", () => movePdfPage(-1));
  document.querySelector("#nextPageButton").addEventListener("click", () => movePdfPage(1));
  document.querySelector("#zoomOutButton").addEventListener("click", () => setPdfZoom(state.pdfZoom - 10));
  document.querySelector("#zoomInButton").addEventListener("click", () => setPdfZoom(state.pdfZoom + 10));
  elements.pdfZoomValue.addEventListener("click", () => setPdfZoom(100));
  elements.sourceFileSelect.addEventListener("change", async (event) => {
    const previous = state.sourceFile;
    const loaded = await loadSourceFile(event.currentTarget.value);
    if (!loaded) event.currentTarget.value = previous || "";
  });
  elements.closeProjectFilePreviewButton?.addEventListener("click", () => {
    showSourceEditor();
    if (state.sourceFile) updateTopbarCurrentFile(state.sourceFile);
    renderSectionList();
  });
  elements.sourceEditor.addEventListener("input", () => {
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
    scheduleSourceEditorRefresh();
    if (isMarkdownFile()) {
      scheduleSourceAutosave();
    } else if (state.sourceFile?.toLowerCase().endsWith(".tex")) {
      scheduleSourceAutosave();
    }
  });
  elements.sourceEditor.addEventListener("beforeinput", (event) => {
    if (event.inputType !== "deleteContentBackward" || !shouldProtectSourceBoundaryBackspace(elements.sourceEditor)) return;
    event.preventDefault();
    toast("已在环境结束行行首，未删除上一行。", "info", 2400);
  });
  elements.sourceEditor.addEventListener("scroll", () => {
    syncSourceEditorLayers();
    syncReviewSourceScroll();
    syncMarkdownPreviewToSource();
  }, { passive: true });
  attachCitationTarget(elements.sourceEditor);
  elements.sourceEditor.addEventListener("click", updateSourceStatus);
  elements.sourceEditor.addEventListener("dblclick", () => void locateSourceSelection());
  elements.sourceEditor.addEventListener("keyup", updateSourceStatus);
  elements.sourceEditor.addEventListener("select", updateSourceStatus);
  elements.sourceEditor.addEventListener("keydown", (event) => {
    if (event.key === "/" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleSourceLineComments();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      elements.sourceEditor.setRangeText("  ", elements.sourceEditor.selectionStart, elements.sourceEditor.selectionEnd, "end");
      elements.sourceEditor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (event.key === "Backspace" && shouldProtectSourceBoundaryBackspace(elements.sourceEditor)) {
      event.preventDefault();
      toast("已在环境结束行行首，未删除上一行。", "info", 2400);
      return;
    }
    if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveSourceFile();
    }
  });
  elements.sourceSearchInput.addEventListener("input", () => refreshSourceSearch());
  elements.sourceSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveSourceSearch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSourceSearch();
    }
  });
  elements.sourceSearchPreviousButton.addEventListener("click", () => moveSourceSearch(-1));
  elements.sourceSearchNextButton.addEventListener("click", () => moveSourceSearch(1));
  elements.sourceSearchReplaceButton.addEventListener("click", () => void replaceCurrentSourceMatch());
  elements.sourceSearchReplaceAllButton.addEventListener("click", () => void replaceAllSourceMatches());
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "b" && key !== "i") return;
    const target = event.target instanceof Element ? event.target.closest("#sourceEditor, .segment-textarea.english, .editable-paper-table textarea, #insertTableGrid input") : null;
    if (!target || target.disabled || target.readOnly) return;
    event.preventDefault();
    applySourceInlineFormat(key === "b" ? "bold" : "italic", target);
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || state.mode !== "source" || document.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    if (key === "f" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      focusSourceSearch();
      return;
    }
    if (key === "g" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      focusSourceReplace();
      return;
    }
    if (key === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveSourceFile();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented
      || event.shiftKey
      || !(event.ctrlKey || event.metaKey)
      || event.key.toLowerCase() !== "z"
      || document.querySelector("dialog[open]")
    ) return;
    const target = event.target instanceof Element ? event.target : null;
    if (shouldUseNativeTextUndo(target)) return;
    event.preventDefault();
    if (state.undoCount) void undoLastChange();
  });
  elements.saveSourceButton.addEventListener("click", () => saveSourceFile());
  elements.createTexFileButton.addEventListener("click", openCreateTexDialog);
  elements.sourceCreateTexButton.addEventListener("click", openCreateTexDialog);
  elements.sourceFocusButton.addEventListener("click", () => {
    setSourceFocus(!elements.workspace.classList.contains("source-focused"));
  });
  elements.createTexForm.addEventListener("submit", createTexFile);
  elements.newTexFileName.addEventListener("input", updateCreateFileDialogKind);
  document.querySelector("#closeCreateTexButton").addEventListener("click", closeCreateTexDialog);
  document.querySelector("#cancelCreateTexButton").addEventListener("click", closeCreateTexDialog);
  elements.createTexDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCreateTexDialog();
  });
  elements.modularizeButton.addEventListener("click", previewPaperStructure);
  elements.structureForm.addEventListener("submit", applyPaperStructure);
  elements.migrateBibliographyButton.addEventListener("click", migrateBibliographyForStructure);
  document.querySelector("#closeStructureButton").addEventListener("click", () => elements.structureDialog.close());
  document.querySelector("#cancelStructureButton").addEventListener("click", () => elements.structureDialog.close());
  let pdfPress;
  elements.pdfScroll.addEventListener("pointerdown", (event) => {
    pdfPress = { x: event.clientX, y: event.clientY };
    beginPdfPan(event);
  });
  elements.pdfScroll.addEventListener("click", (event) => {
    if (state.mode !== "edit" || event.detail !== 1 || !pdfPress
      || Math.hypot(pdfPress.x - event.clientX, pdfPress.y - event.clientY) > 5) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && elements.pdfScroll.contains(selection.anchorNode)) return;
    void locatePdfSelection(event);
  });
  elements.pdfScroll.addEventListener("pointermove", movePdfPan);
  elements.pdfScroll.addEventListener("pointerup", endPdfPan);
  elements.pdfScroll.addEventListener("pointercancel", endPdfPan);
  elements.pdfScroll.addEventListener("lostpointercapture", endPdfPan);
  elements.pdfScroll.addEventListener("wheel", zoomPdfWithWheel, { passive: false });
  elements.pdfScroll.addEventListener("dblclick", (event) => {
    if (state.mode === "edit" || state.previewMode === "markdown") return;
    if (state.previewMode === "fast") void locateFastPreviewSelection(event);
    else if (state.compileInFlight || state.buildPreviewAvailable === false) {
      elements.buildDrawer.classList.remove("hidden");
      toast(
        state.compileInFlight
          ? "新的 PDF 仍在编译，暂时不能定位。"
          : "本次编译失败，旧 PDF 已停用。请点击编译器报告的源码位置。",
        "error",
        4200
      );
    } else void locatePdfSelection(event);
  });
  elements.pdfScroll.addEventListener("scroll", () => {
    updateVisiblePdfPage();
    syncMarkdownSourceToPreview();
  }, { passive: true });
  window.addEventListener("resize", () => {
    fitAllSegmentRows();
    schedulePdfPanelResize();
    if (state.previewMode === "markdown") syncMarkdownPreviewToSource();
  });
  document.querySelector("#warningsButton").addEventListener("click", toggleBuildDrawer);
  document.querySelector("#closeWarningsButton").addEventListener("click", closeBuildDrawer);
  document.querySelectorAll(".mode-button[data-mode]").forEach((button) => button.addEventListener("click", async () => {
    const next = button.dataset.mode;
    if (next === "references") { setReferencesOpen(!state.referencesOpen); return; }
    if (next === state.mode) return;
    if (state.mode === "source" && next === "edit") {
      while (state.sourceSaveInFlight) await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (state.sourceDirty && !await saveSourceFile({ quiet: true })) return;
    }
    setMode(next);
  }));
  window.addEventListener("beforeunload", (event) => {
    if (
      !state.sourceDirty
      && !state.terminologyDirty
      && !state.saveTimers.size
      && !state.pendingWrites
      && !state.fileTranslationJobs.size
      && !state.segmentTranslationQueue.length
      && !state.activeSegmentTranslations
      && !state.undoCount
    ) return;
    event.preventDefault();
    event.returnValue = "";
  });
  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (error) {
      toast(error.message, "error", 5200);
    }
  });
  document.querySelector("#testTranslationButton").addEventListener("click", (event) => testProvider("translation", event.currentTarget));
  document.querySelector("#testDiagnosisButton").addEventListener("click", (event) => testProvider("diagnosis", event.currentTarget));
}

function applyPBLaTexEntryView() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("pblatex") !== "1") return;
  document.title = "PBLaTex Workbench";
  const brandName = document.querySelector(".brand-name");
  if (brandName) brandName.textContent = "PBLaTex";
  const requested = params.get("view");
  if (requested === "references") {
    setReferencesOpen(true);
    return;
  }
  if (requested === "edit") setMode("edit", { loadCurrent: false });
  if (requested === "source") setMode("source", { loadCurrent: false });
  if (requested === "preview") {
    setPreviewMode("pdf");
    elements.pdfScroll.setAttribute("tabindex", "-1");
    elements.pdfScroll.focus({ preventScroll: true });
  }
}

async function initialize() {
  bindReview();
  bindReferences();
  bindEvents();
  window.setInterval(() => void syncProjectFileTree(), 1600);
  window.addEventListener("focus", () => void syncProjectFileTree(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void syncProjectFileTree(true);
  });
  elements.workspace.dataset.mode = state.mode;
  setSidebarPanel(["files", "comments", ""].includes(state.sidebarPanel) ? state.sidebarPanel : "files", { persist: false });
  applySidebarWidth(false);
  translationLayout();
  applyReadingSettings();
  observeSegmentEditorSize();
  window.paperBridgeDesktop?.onCloseRequest?.(handleDesktopCloseRequest);
  applyEditorPreferences(false);
  applyWorkspaceSplit(false);
  setPdfZoom(state.pdfZoom, { persist: false, preserveViewport: false });
  setPreviewMode("pdf");
  refreshIcons();
  try {
    const ready = await refreshProject({ preserveDocument: false });
    applyPBLaTexEntryView();
  } catch (error) {
    toast(error.message, "error", 8000);
    elements.segmentList.innerHTML = '<div class="empty-state">无法打开论文项目</div>';
  }
}

initialize();

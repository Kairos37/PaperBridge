import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectFile } from "./latex.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let executablePromise;

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

async function executable() {
  if (!executablePromise) executablePromise = (async () => {
    const name = process.platform === "win32" ? "synctex.exe" : "synctex";
    const candidates = [
      process.env.PAPERBRIDGE_SYNCTEX_PATH,
      process.resourcesPath && path.join(process.resourcesPath, "bin", "synctex", name),
      path.join(appRoot, "resources", "bin", "synctex", name),
      "synctex"
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ["help"], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
        return candidate;
      } catch { /* Try the next installed or bundled SyncTeX executable. */ }
    }
    throw syncError("SYNCTEX_UNAVAILABLE", "无法找到 SyncTeX 定位工具，请更新桌面版或安装 TeX Live/MiKTeX。");
  })().catch((error) => { executablePromise = null; throw error; });
  return executablePromise;
}

export function parseSyncTeXOutput(output) {
  const body = String(output || "").match(/SyncTeX result begin\s*([\s\S]*?)SyncTeX result end/)?.[1];
  if (!body) return [];
  const records = [];
  let record = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z]+):(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "Output" && Object.keys(record).length) { records.push(record); record = {}; }
    record[key] = value.trim();
  }
  if (Object.keys(record).length) records.push(record);
  return records;
}

async function artifacts(projectRoot, mainTex) {
  const pdfFile = String(mainTex).replace(/\.tex$/i, ".pdf");
  let pdf;
  try { pdf = await resolveProjectFile(projectRoot, pdfFile); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw syncError("SYNCTEX_MISSING", "请先点击“编译”生成 PDF 和 SyncTeX 定位信息。");
  }
  for (const suffix of [".synctex.gz", ".synctex"]) {
    try {
      const file = await resolveProjectFile(projectRoot, String(mainTex).replace(/\.tex$/i, suffix));
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.size) return { pdf, mapTime: stat.mtimeMs };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw syncError("SYNCTEX_MISSING", "当前 PDF 缺少 SyncTeX 定位信息，请点击“编译”后再双击定位。");
}

async function sourceFile(projectRoot, file, mapTime) {
  const realRoot = await fs.realpath(projectRoot);
  let relative = file;
  if (path.isAbsolute(file)) {
    const candidate = path.relative(realRoot, file);
    if (!candidate.startsWith("..") && !path.isAbsolute(candidate)) relative = candidate;
  }
  const absolute = await resolveProjectFile(projectRoot, relative);
  if (!/\.tex$/i.test(absolute)) throw new Error("SyncTeX 只能定位到项目内的 TeX 源码。");
  const stat = await fs.stat(absolute);
  if (stat.mtimeMs > mapTime + 2) throw syncError("SYNCTEX_STALE", "源码已修改，请先点击“编译”更新定位信息。");
  return { absolute, relative: path.relative(realRoot, absolute).replaceAll(path.sep, "/") };
}

async function query(projectRoot, args) {
  const command = await executable();
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: projectRoot, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: "utf8"
    });
    return parseSyncTeXOutput(stdout);
  } catch (cause) {
    const error = syncError("SYNCTEX_INVALID", "定位信息无法读取，请点击“编译”重新生成后再试。");
    error.details = { reason: String(cause.stderr || cause.message).slice(0, 1000) };
    throw error;
  }
}

export async function syncTeXInverse(projectRoot, mainTex, { page, x, y }) {
  page = Number(page); x = Number(x); y = Number(y);
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("无效的 PDF 定位坐标。");
  }
  const { pdf, mapTime } = await artifacts(projectRoot, mainTex);
  const records = await query(projectRoot, ["edit", "-o", `${page}:${x}:${y}:${pdf}`]);
  for (const record of records) {
    if (!record.Input || !(Number(record.Line) > 0)) continue;
    let source;
    try { source = await sourceFile(projectRoot, record.Input, mapTime); }
    catch (error) { if (error.code === "SYNCTEX_STALE") throw error; continue; }
    return { file: source.relative, line: Number(record.Line), column: Math.max(1, Number(record.Column) || 1) };
  }
  throw syncError("SYNCTEX_NOT_FOUND", "此处没有对应的项目源码位置，请在正文、公式或表格上双击。");
}

export async function syncTeXForward(projectRoot, mainTex, { file, line, column = 0 }) {
  line = Number(line); column = Number(column);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0) throw new Error("无效的源码行列。");
  const { pdf, mapTime } = await artifacts(projectRoot, mainTex);
  const source = await sourceFile(projectRoot, String(file || ""), mapTime);
  const records = await query(projectRoot, ["view", "-i", `${line}:${column}:${source.absolute}`, "-o", pdf]);
  for (const record of records) {
    const page = Number(record.Page);
    const left = Number(record.h ?? record.x);
    const bottom = Number(record.v ?? record.y);
    const width = Math.abs(Number(record.W || 12));
    const height = Math.abs(Number(record.H || 12));
    if (!Number.isInteger(page) || page < 1 || ![left, bottom, width, height].every(Number.isFinite)) continue;
    return { page, x: left, y: record.v === undefined ? bottom : bottom - height, width: Math.max(2, width), height: Math.max(2, height) };
  }
  throw syncError("SYNCTEX_NOT_FOUND", "这行源码没有对应的 PDF 内容，请双击正文、公式或表格源码。");
}

export async function syncTeXSnapshotInverse(projectRoot, pdf, { page, x, y }, files) {
  if (!Number.isInteger(page) || page < 1 || ![x, y].every(Number.isFinite) || x < 0 || y < 0) return null;
  const records = await query(projectRoot, ["edit", "-o", [page, x, y, pdf].join(":")]);
  const lower = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const known = new Map(files.map((file) => [lower(file), file]));
  for (const { Input, Line } of records) {
    const line = Number(Line);
    if (!Input || !Number.isInteger(line) || line < 1) continue;
    const name = path.isAbsolute(Input) ? path.relative(projectRoot, Input) : Input;
    const relative = name.replaceAll("\\", "/").replace(/^\.\//, "");
    const direct = known.get(lower(relative));
    if (direct) return { file: direct, line };
    const basename = relative.split("/").at(-1);
    const matches = files.filter((file) => lower(file.split("/").at(-1)) === lower(basename));
    if (matches.length === 1) return { file: matches[0], line };
  }
  return null;
}

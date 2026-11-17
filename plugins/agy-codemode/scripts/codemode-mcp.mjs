#!/usr/bin/env node
/**
 * AGY Codemode MCP Server — Adapted for Antigravity's native tool ecosystem
 * combined with Pi's codemode sandbox runtime.
 *
 * - Registered as an EAGER tool (`"eager": true` in mcp_config.json) so Antigravity
 *   exposes `mcp_agy-codemode_agy_codemode_codemode` directly without wasting a turn
 *   on `read_file(codemode.json)` + `call_mcp_tool`.
 * - Bridges Antigravity's native tool names & PascalCase arguments (`read_file({ Path, StartLine, EndLine })`,
 *   `edit_file({ Path, Target, Replacement })`, `write_file({ Path, Content, Overwrite, Append })`,
 *   `run_command({ CommandLine })`) AND Pi's concise aliases (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`).
 * - Preserves Pi's `// @options:`, `==> text N/M <==`, `<console_output>`, transactional `store/load`,
 *   BM25 `searchTools()`, and 10,000-token output guard.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import readline from "node:readline";
import { createRequire } from "node:module";

let DatabaseSync = null;
try {
  const mod = await import("node:sqlite");
  DatabaseSync = mod.DatabaseSync;
} catch {}

const PLUGIN_DATA = process.env.PLUGIN_DATA || path.join(os.homedir(), ".gemini", "antigravity", "scratch", "agy-codemode-data");
const SCRATCH_DIR = path.join(os.homedir(), ".gemini", "antigravity", "scratch");
const DUMP_DIR = path.join(SCRATCH_DIR, "tool-dumps");
const HOTFILES_PATH = path.join(SCRATCH_DIR, "agy-codemode-hotfiles.json");
const STORE_PATH = path.join(PLUGIN_DATA, "store.json");

const CODEMODE_OPTIONS_PREFIX = "// @options:";
const SUPPORTED_OPTION_FIELDS = ["max_output_tokens", "timeout_ms"];
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const MAX_CALL_OUTPUT_BYTES = 1024 * 1024;
const MAX_STORE_VALUE_CHARS = 262_144;
const MAX_STORE_TOTAL_CHARS = 1_048_576;
const MAX_TOTAL_OUTPUT_CHARS = 16_777_216;
const MAX_OUTPUT_ITEMS = 100_000;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", "__pycache__", ".venv", "venv"]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * Resolve default workspace directory when `workspace_dir` is omitted.
 * Avoids falling back into `~/.gemini/config/plugins/agy-codemode` (the plugin's own install dir).
 */
function resolveDefaultWorkspaceDir(explicitDir) {
  if (explicitDir && typeof explicitDir === "string" && explicitDir.trim()) {
    return path.resolve(explicitDir.trim());
  }
  const cwd = process.cwd();
  const normCwd = normPath(cwd).toLowerCase();
  if (!normCwd.includes("/.gemini/config/plugins") && !normCwd.includes("/antigravity/resources")) {
    return cwd;
  }
  // Check recent workspace in Antigravity history.jsonl
  for (const prod of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
    const hist = path.join(os.homedir(), ".gemini", prod, "history.jsonl");
    if (!fs.existsSync(hist)) continue;
    try {
      const st = fs.statSync(hist);
      const win = Math.min(st.size, 65536);
      const fd = fs.openSync(hist, "r");
      const buf = Buffer.alloc(win);
      fs.readSync(fd, buf, 0, win, st.size - win);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (typeof obj.workspace === "string" && obj.workspace.trim() && fs.existsSync(obj.workspace)) {
            return path.resolve(obj.workspace);
          }
        } catch {}
      }
    } catch {}
  }
  ensureDir(SCRATCH_DIR);
  return SCRATCH_DIR;
}

function resolveSafePath(target, baseDir) {
  if (!target || typeof target !== "string") throw new Error("Path must be a non-empty string");
  const clean = target.replace(/^@/, "").replace(/^file:\/\/\/?/i, "").trim();
  return path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(baseDir, clean);
}

function parseCodemodeSource(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(
      'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`.',
    );
  }
  const lines = input.split("\n");
  const misplaced = lines.findIndex((line, idx) => idx > 0 && line.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX));
  if (misplaced !== -1) {
    throw new Error(`The ${CODEMODE_OPTIONS_PREFIX} line must be the first line of the input; found one on line ${misplaced + 1}`);
  }
  const newline = input.indexOf("\n");
  const firstLine = lines[0].replace(/\r$/, "");
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) {
    return { code: input, options: {} };
  }
  const code = newline === -1 ? "" : input.slice(newline + 1);
  if (code.trim() === "") {
    throw new Error("The @options line must be followed by JavaScript source on subsequent lines");
  }
  const directive = trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim();
  if (!directive) {
    throw new Error("@options must be a JSON object with supported fields `max_output_tokens` and `timeout_ms`");
  }
  let parsed;
  try {
    parsed = JSON.parse(directive);
  } catch (e) {
    throw new Error(`@options must be valid JSON with supported fields \`max_output_tokens\` and \`timeout_ms\`: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("@options must be a JSON object with supported fields `max_output_tokens` and `timeout_ms`");
  }
  for (const key of Object.keys(parsed)) {
    if (!SUPPORTED_OPTION_FIELDS.includes(key)) {
      throw new Error(`@options only supports \`max_output_tokens\` and \`timeout_ms\`; got \`${key}\``);
    }
  }
  const options = {};
  if (parsed.max_output_tokens !== undefined) {
    if (typeof parsed.max_output_tokens !== "number" || !Number.isSafeInteger(parsed.max_output_tokens) || parsed.max_output_tokens < 0) {
      throw new Error("@options field `max_output_tokens` must be a non-negative safe integer");
    }
    options.maxOutputTokens = parsed.max_output_tokens;
  }
  if (parsed.timeout_ms !== undefined) {
    if (typeof parsed.timeout_ms !== "number" || !Number.isSafeInteger(parsed.timeout_ms) || parsed.timeout_ms <= 0 || parsed.timeout_ms > MAX_TIMEOUT_MS) {
      throw new Error(`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`);
    }
    options.timeoutMs = parsed.timeout_ms;
  }
  return { code, options };
}

function recordFileOps(baseDir, readFiles, modifiedFiles) {
  if (!readFiles.length && !modifiedFiles.length) return;
  try {
    ensureDir(SCRATCH_DIR);
    let data = {};
    if (fs.existsSync(HOTFILES_PATH)) {
      try {
        data = JSON.parse(fs.readFileSync(HOTFILES_PATH, "utf8"));
      } catch {}
    }
    const key = normPath(path.resolve(baseDir)).toLowerCase();
    const prev = data[key] && typeof data[key] === "object" ? data[key] : { read: [], modified: [] };
    const now = Date.now();

    const mergeList = (oldArr, addArr) => {
      const m = new Map();
      for (const item of Array.isArray(oldArr) ? oldArr : []) {
        if (item?.path) m.set(normPath(item.path).toLowerCase(), item);
      }
      for (const fp of addArr) {
        const n = normPath(path.resolve(fp));
        m.set(n.toLowerCase(), { path: n, ts: now });
      }
      return [...m.values()].sort((a, b) => b.ts - a.ts).slice(0, 32);
    };

    data[key] = {
      read: mergeList(prev.read, readFiles),
      modified: mergeList(prev.modified, modifiedFiles),
    };
    fs.writeFileSync(HOTFILES_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function loadStoreFile() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
  } catch {}
  return {};
}

function saveStoreFile(obj) {
  const json = JSON.stringify(obj);
  if (json.length > MAX_STORE_TOTAL_CHARS) {
    throw new Error(`Total codemode store size (${json.length} chars) exceeds limit of ${MAX_STORE_TOTAL_CHARS} chars`);
  }
  ensureDir(PLUGIN_DATA);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function globToRegExp(globStr) {
  const escaped = String(globStr || "*")
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

async function walkFiles(dir, maxFiles = 4000, out = [], rootDir = dir) {
  if (out.length >= maxFiles) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) break;
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkFiles(full, maxFiles, out, rootDir);
    } else if (ent.isFile()) {
      out.push({ full, rel: normPath(path.relative(rootDir, full)) });
    }
  }
  return out;
}

function runShell(command, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = timeoutSec ? Math.max(1000, Math.round(Number(timeoutSec) * 1000)) : 300_000;
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = execFile(
      shell,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
        const exit_code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const wall_time_seconds = Number(((Date.now() - start) / 1000).toFixed(2));
        if (Buffer.byteLength(combined, "utf8") <= MAX_CALL_OUTPUT_BYTES) {
          resolve({
            output: combined,
            truncated: false,
            exit_code,
            wall_time_seconds,
          });
          return;
        }
        ensureDir(DUMP_DIR);
        const dumpPath = path.join(DUMP_DIR, `cmd-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.log`);
        fs.writeFileSync(dumpPath, combined, "utf8");
        const half = Math.floor(MAX_CALL_OUTPUT_BYTES / 2) - 256;
        const head = combined.slice(0, half);
        const tail = combined.slice(-half);
        const omitted = combined.length - head.length - tail.length;
        resolve({
          output: `${head}\n\n... [${omitted} chars omitted; full output in ${normPath(dumpPath)}] ...\n\n${tail}`,
          truncated: true,
          full_output_path: normPath(dumpPath),
          exit_code,
          wall_time_seconds,
        });
      },
    );
    child.stdin?.end();
  });
}

/**
 * Discover other MCP tool schemas already cached by Antigravity in `~/.gemini/antigravity/mcp/<server>/<tool>.json`
 * so `ALL_TOOLS`, `searchTools()`, and `describeTool()` inside codemode know about the user's MCP ecosystem.
 */
function discoverExternalMcpSchemas() {
  const mcpDir = path.join(os.homedir(), ".gemini", "antigravity", "mcp");
  if (!fs.existsSync(mcpDir)) return [];
  const external = [];
  try {
    for (const srvEnt of fs.readdirSync(mcpDir, { withFileTypes: true })) {
      if (!srvEnt.isDirectory() || srvEnt.name.includes("agy-codemode")) continue;
      const srvPath = path.join(mcpDir, srvEnt.name);
      for (const fEnt of fs.readdirSync(srvPath, { withFileTypes: true })) {
        if (!fEnt.isFile() || !fEnt.name.endsWith(".json")) continue;
        try {
          const schemaObj = JSON.parse(fs.readFileSync(path.join(srvPath, fEnt.name), "utf8"));
          if (schemaObj?.name) {
            external.push({
              name: `${srvEnt.name}__${schemaObj.name}`,
              namespace: srvEnt.name,
              description: `[External MCP: ServerName="${srvEnt.name}", ToolName="${schemaObj.name}"] ${schemaObj.description || ""}`,
              declaration: `${srvEnt.name}__${schemaObj.name}(args: ${JSON.stringify(schemaObj.parameters?.properties ? Object.keys(schemaObj.parameters.properties) : "object")}): Promise<unknown>;`,
            });
          }
        } catch {}
      }
    }
  } catch {}
  return external;
}

function buildToolDefinitions(baseDir, readSet, modSet) {
  const readFileImpl = async (arg) => {
    const isStr = typeof arg === "string";
    const filePath = isStr ? arg : (arg?.Path ?? arg?.path ?? arg?.TargetFile ?? arg?.file);
    const abs = resolveSafePath(filePath, baseDir);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
    if (st.size > 4 * 1024 * 1024) throw new Error(`File too large (${st.size} bytes): ${normPath(abs)}`);
    const rawBuf = await fsp.readFile(abs);
    const byteOff = !isStr && Number.isFinite(arg?.ByteOffset) ? Math.max(0, Number(arg.ByteOffset)) : 0;
    const raw = (byteOff > 0 ? rawBuf.subarray(byteOff) : rawBuf).toString("utf8");
    if (raw.includes("\u0000")) throw new Error(`Binary file cannot be read as UTF-8 text: ${normPath(abs)}`);
    readSet.add(abs);

    const lines = raw.split(/\r?\n/);
    const startLine = !isStr ? (arg?.StartLine ?? arg?.offset) : undefined;
    const endLine = !isStr ? arg?.EndLine : undefined;
    const limit = !isStr ? arg?.limit : undefined;

    if (startLine === undefined && endLine === undefined && limit === undefined) {
      return raw;
    }
    const startIdx = Math.max(1, Number(startLine || 1)) - 1;
    const count = endLine !== undefined
      ? Math.max(1, Number(endLine) - startIdx)
      : (limit !== undefined ? Math.max(1, Number(limit)) : lines.length);
    const sliced = lines.slice(startIdx, startIdx + count);
    const actualEnd = startIdx + sliced.length;
    let out = sliced.join("\n");
    if (actualEnd < lines.length) {
      out += `\n\n[Showing lines ${startIdx + 1}-${actualEnd} of ${lines.length}. Use StartLine=${actualEnd + 1} (or offset=${actualEnd + 1}) to continue.]`;
    }
    return out;
  };

  const runCommandImpl = async (arg) => {
    const cmd = typeof arg === "string" ? arg : (arg?.CommandLine ?? arg?.command ?? arg?.Command);
    if (!cmd || typeof cmd !== "string") {
      throw new Error("run_command / bash requires a non-empty `CommandLine` or `command` string");
    }
    const subCwd = arg?.cwd ? resolveSafePath(arg.cwd, baseDir) : baseDir;
    const timeoutSec = arg?.timeout ?? (arg?.WaitMsBeforeAsync ? Math.ceil(Number(arg.WaitMsBeforeAsync) / 1000) : undefined);
    return runShell(cmd, subCwd, timeoutSec);
  };

  const grepImpl = async (arg) => {
    const isStr = typeof arg === "string";
    const pattern = isStr ? arg : (arg?.pattern ?? arg?.Query ?? arg?.query);
    if (!pattern || typeof pattern !== "string") throw new Error("grep requires a `pattern` or `Query` string");
    const subPath = !isStr ? (arg?.path ?? arg?.SearchPath ?? arg?.SearchDirectory ?? ".") : ".";
    const target = resolveSafePath(subPath, baseDir);
    const flags = arg?.ignoreCase || arg?.CaseInsensitive ? "i" : "";
    const isLiteral = Boolean(arg?.literal || arg?.FixedStrings);
    const re = isLiteral
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
      : new RegExp(pattern, flags);
    const globPat = arg?.glob ?? arg?.IncludePattern;
    const fileFilter = globPat ? globToRegExp(globPat) : null;
    const limit = Math.max(1, Number(arg?.limit ?? 100));
    const ctx = Math.max(0, Math.min(10, Number(arg?.context ?? 0)));

    const st = await fsp.stat(target);
    const files = st.isFile()
      ? [{ full: target, rel: normPath(path.relative(baseDir, target)) || path.basename(target) }]
      : (await walkFiles(target, 4000, [], baseDir)).filter((f) => !fileFilter || fileFilter.test(f.rel) || fileFilter.test(path.basename(f.rel)));

    const out = [];
    let hits = 0;
    for (const f of files) {
      if (hits >= limit) break;
      try {
        const fst = await fsp.stat(f.full);
        if (fst.size > 1024 * 1024) continue;
        const txt = await fsp.readFile(f.full, "utf8");
        if (txt.includes("\u0000")) continue;
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits++;
            if (ctx === 0) {
              out.push(`${f.rel}:${i + 1}: ${lines[i]}`);
            } else {
              const s = Math.max(0, i - ctx);
              const e = Math.min(lines.length, i + ctx + 1);
              for (let k = s; k < e; k++) {
                const sep = k === i ? ":" : "-";
                out.push(`${f.rel}${sep}${k + 1}${sep} ${lines[k]}`);
              }
              out.push("--");
            }
            if (hits >= limit) break;
          }
        }
      } catch {}
    }
    return out.join("\n") || "No matches found";
  };

  const findImpl = async (arg) => {
    const isStr = typeof arg === "string";
    const pattern = isStr ? arg : (arg?.pattern ?? arg?.Pattern ?? "**/*");
    const subPath = !isStr ? (arg?.path ?? arg?.SearchDirectory ?? ".") : ".";
    const target = resolveSafePath(subPath, baseDir);
    const re = globToRegExp(pattern);
    const limit = Math.max(1, Number(arg?.limit ?? 1000));
    const files = await walkFiles(target, 6000, [], target);
    const matched = files
      .filter((f) => re.test(f.rel) || re.test(path.basename(f.rel)))
      .slice(0, limit)
      .map((f) => f.rel);
    return matched.join("\n") || "No files found matching pattern";
  };

  const lsImpl = async (arg = {}) => {
    const isStr = typeof arg === "string";
    const subPath = isStr ? arg : (arg?.path ?? arg?.Path ?? arg?.DirectoryPath ?? ".");
    const target = resolveSafePath(subPath, baseDir);
    const limit = Math.max(1, Number(arg?.limit ?? 500));
    const ents = await fsp.readdir(target, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    const lines = ents.slice(0, limit).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (ents.length > limit) lines.push(`\n[${ents.length - limit} more entries truncated]`);
    return lines.join("\n") || "(empty directory)";
  };

  const editFileImpl = async (arg) => {
    const filePath = arg?.Path ?? arg?.path ?? arg?.TargetFile;
    const abs = resolveSafePath(filePath, baseDir);
    const content = await fsp.readFile(abs, "utf8");
    const hasCrlf = content.includes("\r\n");
    let next = content.replace(/\r\n/g, "\n");

    // Support both Antigravity native `{ Path, Target, Replacement }` and Pi `{ path, edits: [{ oldText, newText }] }`
    if (typeof arg?.Target === "string") {
      const targetStr = arg.Target.replace(/\r\n/g, "\n");
      const replStr = String(arg.Replacement ?? "").replace(/\r\n/g, "\n");
      if (!targetStr) throw new Error("Target must not be empty");
      if (!next.includes(targetStr)) throw new Error(`Target not found in ${normPath(abs)}`);
      next = next.split(targetStr).join(replStr);
    } else if (Array.isArray(arg?.edits) && arg.edits.length > 0) {
      for (let idx = 0; idx < arg.edits.length; idx++) {
        const oldT = String(arg.edits[idx].oldText || "").replace(/\r\n/g, "\n");
        const newT = String(arg.edits[idx].newText ?? "").replace(/\r\n/g, "\n");
        if (!oldT) throw new Error(`edits[${idx}].oldText must not be empty`);
        const first = next.indexOf(oldT);
        if (first === -1) throw new Error(`Could not find edits[${idx}].oldText in ${normPath(abs)}`);
        if (next.indexOf(oldT, first + 1) !== -1) {
          throw new Error(`edits[${idx}].oldText matches multiple locations in ${normPath(abs)}; include more context`);
        }
        next = next.slice(0, first) + newT + next.slice(first + oldT.length);
      }
    } else {
      throw new Error("edit_file / edit requires either `{ Path, Target, Replacement }` or `{ path, edits: [{ oldText, newText }] }`");
    }

    await fsp.writeFile(abs, hasCrlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
    modSet.add(abs);
    return `Successfully edited ${normPath(abs)}`;
  };

  const writeFileImpl = async (arg) => {
    const filePath = arg?.Path ?? arg?.path ?? arg?.TargetFile;
    const abs = resolveSafePath(filePath, baseDir);
    const body = String(arg?.Content ?? arg?.content ?? "");
    const append = Boolean(arg?.Append);
    const overwrite = arg?.Overwrite !== undefined ? Boolean(arg.Overwrite) : true;
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (append) {
      await fsp.appendFile(abs, body, "utf8");
    } else {
      if (!overwrite && fs.existsSync(abs)) {
        throw new Error(`File already exists and Overwrite=false: ${normPath(abs)}`);
      }
      await fsp.writeFile(abs, body, "utf8");
    }
    modSet.add(abs);
    return `Successfully wrote ${Buffer.byteLength(body, "utf8")} bytes to ${normPath(abs)}`;
  };

  const extractSingleOutline = async (targetPath, maxSymbols = 250) => {
    const abs = resolveSafePath(targetPath, baseDir);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
    const raw = await fsp.readFile(abs, "utf8");
    if (raw.includes("\u0000")) throw new Error(`Binary file: ${normPath(abs)}`);
    readSet.add(abs);

    const ext = path.extname(abs).toLowerCase();
    const lines = raw.split(/\r?\n/);
    const symbols = [];

    const patterns = ext === ".md" || ext === ".markdown"
      ? [/^(#{1,6}\s+.+)$/]
      : ext === ".py"
        ? [/^(\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*(?:->\s*[^:]+)?)/, /^(\s*class\s+[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)/]
        : ext === ".rs"
          ? [/^(\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static)\s+[^{;]+)/]
          : ext === ".go"
            ? [/^(\s*(?:func|type|var|const)\s+[^{]+)/]
            : [
                /^(\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\))/,
                /^(\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*[^{;=]*)/,
                /^(\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/,
                /^(\s*(?:public|private|protected|static|async|\s)*[A-Za-z_$][A-Za-z0-9_$]*\s*\([^;]*\)\s*\{)/,
              ];

    const skipControl = /^\s*(?:if|for|while|switch|catch|return|else)\b/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (ext !== ".md" && skipControl.test(line)) continue;
      for (const re of patterns) {
        const m = re.exec(line);
        if (m) {
          const sig = m[1].replace(/\{\s*$/, "").trim().slice(0, 140);
          symbols.push(`L${i + 1}: ${sig}`);
          break;
        }
      }
      if (symbols.length >= maxSymbols) break;
    }

    const header = `=== ${normPath(abs)} (${lines.length} lines, ${symbols.length} symbols) ===`;
    return `${header}\n${symbols.join("\n") || "(no structural symbols matched)"}`;
  };

  const outlineImpl = async (arg) => {
    if (typeof arg === "string") return extractSingleOutline(arg);
    if (Array.isArray(arg)) {
      const parts = await Promise.all(arg.map((p) => extractSingleOutline(typeof p === "string" ? p : (p?.Path ?? p?.path))));
      return parts.join("\n\n");
    }
    const list = arg?.Paths ?? arg?.paths;
    if (Array.isArray(list)) {
      const parts = await Promise.all(list.map((p) => extractSingleOutline(typeof p === "string" ? p : (p?.Path ?? p?.path))));
      return parts.join("\n\n");
    }
    const single = arg?.Path ?? arg?.path ?? arg?.File ?? arg?.file;
    if (!single) throw new Error("outline requires `Path` / `path` string or `Paths` array");
    return extractSingleOutline(single, Number(arg?.limit || 250));
  };

  const gitDiffImpl = async (arg = {}) => {
    const isStr = typeof arg === "string";
    const filePath = isStr ? arg : (arg?.Path ?? arg?.path);
    const targetRef = (!isStr && (arg?.Target ?? arg?.target)) ? String(arg.Target ?? arg.target).replace(/[^a-zA-Z0-9_./~^-]/g, "") : "";
    const stagedFlag = !isStr && (arg?.Staged || arg?.staged) ? "--staged" : "";
    const statFlag = !isStr && (arg?.Stat || arg?.stat) ? "--stat" : "";
    const relFile = filePath ? `-- "${normPath(resolveSafePath(filePath, baseDir))}"` : "";
    const cmd = ["git --no-pager diff", stagedFlag, statFlag, targetRef, relFile].filter(Boolean).join(" ");
    const res = await runShell(cmd, baseDir, 15);
    return res.output || "(no diff)";
  };

  const gitStatusImpl = async (arg = {}) => {
    const subCwd = (typeof arg === "string" ? arg : (arg?.Path ?? arg?.path))
      ? resolveSafePath(typeof arg === "string" ? arg : (arg.Path ?? arg.path), baseDir)
      : baseDir;
    const res = await runShell("git --no-pager status --short --branch", subCwd, 10);
    return res.output || "(clean)";
  };

  // --- Cross-session & Pre-compaction Transcript Recall ---
  const GEMINI_PRODUCTS = ["antigravity", "antigravity-cli", "antigravity-ide"];

  const decodeWorkspaceUris = (raw) => {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.map((u) => {
            try {
              return normPath(decodeURIComponent(String(u)).replace(/^file:\/\/\/?/i, ""));
            } catch {
              return String(u);
            }
          })
        : [];
    } catch {
      return [];
    }
  };

  const extractCleanUserText = (raw) => {
    if (!raw) return "";
    const out = [];
    const re = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[1].trim()) out.push(m[1].trim());
    }
    if (out.length) return out.join("\n");
    return String(raw)
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
      .trim();
  };

  const collectAllSessions = () => {
    const metaById = new Map();
    for (const prod of GEMINI_PRODUCTS) {
      const base = path.join(os.homedir(), ".gemini", prod);
      const sumDb = path.join(base, "conversation_summaries.db");
      if (DatabaseSync && fs.existsSync(sumDb)) {
        try {
          const db = new DatabaseSync(sumDb, { readOnly: true });
          const rows = db
            .prepare(
              "SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, parent_conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 300",
            )
            .all();
          for (const r of rows) {
            if (!r.conversation_id) continue;
            metaById.set(r.conversation_id, {
              cid: r.conversation_id,
              product: prod,
              title: r.title || "",
              stepCount: Number(r.step_count || 0),
              updatedAt: r.last_modified_time || "",
              workspaces: decodeWorkspaceUris(r.workspace_uris),
              parentCid: r.parent_conversation_id || "",
            });
          }
          db.close();
        } catch {}
      }

      const brainDir = path.join(base, "brain");
      if (!fs.existsSync(brainDir)) continue;
      let ents = [];
      try {
        ents = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const ent of ents) {
        const cid = ent.name;
        const logsDir = path.join(brainDir, cid, ".system_generated", "logs");
        const fullPath = path.join(logsDir, "transcript_full.jsonl");
        const compactPath = path.join(logsDir, "transcript.jsonl");
        const tPath = fs.existsSync(fullPath) ? fullPath : fs.existsSync(compactPath) ? compactPath : null;
        if (!tPath) continue;
        const st = fs.statSync(tPath);
        const existing = metaById.get(cid) || {
          cid,
          product: prod,
          title: "",
          stepCount: 0,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          workspaces: [],
          parentCid: "",
        };
        existing.transcriptPath = tPath;
        existing.mtimeMs = st.mtimeMs;
        metaById.set(cid, existing);
      }
    }

    return [...metaById.values()]
      .filter((s) => Boolean(s.transcriptPath))
      .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  };

  const makeSnippet = (text, terms, maxLen = 240) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    if (flat.length <= maxLen) return flat;
    const lower = flat.toLowerCase();
    let hitPos = -1;
    for (const t of terms) {
      const idx = lower.indexOf(t);
      if (idx !== -1) {
        hitPos = idx;
        break;
      }
    }
    if (hitPos <= 40) return flat.slice(0, maxLen) + "…";
    const start = Math.max(0, hitPos - 70);
    return (start > 0 ? "…" : "") + flat.slice(start, start + maxLen) + (start + maxLen < flat.length ? "…" : "");
  };

  const searchSessionsImpl = async (arg = {}) => {
    const isStr = typeof arg === "string";
    const query = isStr ? arg : (arg?.Query ?? arg?.query ?? "");
    const wsFilter = !isStr ? (arg?.Workspace ?? arg?.workspace ?? "") : "";
    const limit = Math.min(30, Math.max(1, Number((!isStr && (arg?.Limit ?? arg?.limit)) || 10)));
    const includeTools = Boolean(!isStr && (arg?.IncludeTools ?? arg?.includeTools));

    const terms = String(query || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const sessions = collectAllSessions().slice(0, 120);
    if (!sessions.length) return "No local Antigravity session transcripts found.";

    const normWsFilter = wsFilter ? normPath(wsFilter).toLowerCase() : "";
    const hits = [];

    for (const s of sessions) {
      const wsMatch = normWsFilter
        ? s.workspaces.some((w) => w.toLowerCase().includes(normWsFilter))
        : false;
      if (normWsFilter && !wsMatch && s.workspaces.length > 0) continue;

      if (!terms.length) {
        hits.push({
          score: (wsMatch ? 5 : 0) + (s.mtimeMs || 0) / 1e13,
          cid: s.cid,
          title: s.title || "(untitled)",
          workspace: s.workspaces[0] || "",
          updatedAt: s.updatedAt,
          step: 0,
          role: "SESSION",
          snippet: `steps=${s.stepCount || "?"} | ${s.product}`,
        });
        continue;
      }

      const titleLower = (s.title || "").toLowerCase();
      let titleScore = 0;
      for (const t of terms) {
        if (titleLower.includes(t)) titleScore += 4;
      }

      let rawText;
      try {
        const st = fs.statSync(s.transcriptPath);
        if (st.size > 25 * 1024 * 1024) continue;
        rawText = fs.readFileSync(s.transcriptPath, "utf8");
      } catch {
        continue;
      }

      const lines = rawText.split(/\r?\n/);
      const sessionHits = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const typ = obj.type;
        let body = "";
        let role = typ;
        if (typ === "USER_INPUT") {
          body = extractCleanUserText(obj.content || "");
          role = "USER";
        } else if (typ === "PLANNER_RESPONSE") {
          const tc = Array.isArray(obj.tool_calls)
            ? obj.tool_calls.map((c) => `${c?.name}(${JSON.stringify(c?.args || {}).slice(0, 120)})`).join(" ")
            : "";
          body = `${obj.content || ""}\n${tc}`.trim();
          role = "ASSISTANT";
        } else if (includeTools && typ === "GENERIC") {
          body = String(obj.content || "").slice(0, 4000);
          role = "TOOL";
        } else {
          continue;
        }
        if (!body) continue;

        const lower = body.toLowerCase();
        let matchedTerms = 0;
        for (const t of terms) {
          if (lower.includes(t) || titleLower.includes(t)) matchedTerms++;
        }
        if (matchedTerms === 0) continue;

        const allMatched = matchedTerms === terms.length ? 8 : 0;
        const score = allMatched + matchedTerms * 3 + (role === "USER" ? 2 : 1) + titleScore + (wsMatch ? 3 : 0);
        sessionHits.push({
          score,
          cid: s.cid,
          title: s.title || "(untitled)",
          workspace: s.workspaces[0] || "",
          updatedAt: obj.created_at || s.updatedAt,
          step: obj.step_index ?? 0,
          role,
          snippet: makeSnippet(body, terms, 240),
        });
      }

      sessionHits.sort((a, b) => b.score - a.score || b.step - a.step);
      hits.push(...sessionHits.slice(0, 3));
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (!top.length) {
      return `No matches for query "${query}" across ${sessions.length} local session(s).`;
    }

    return top
      .map(
        (h, i) =>
          `[${i + 1}] cid=${h.cid.slice(0, 8)} (${h.cid}) | step=${h.step} | role=${h.role} | ${h.updatedAt}\n` +
          `    title: ${h.title}${h.workspace ? ` | workspace: ${h.workspace}` : ""}\n` +
          `    match: ${h.snippet}\n` +
          `    expand: tools.read_transcript({ ConversationId: "${h.cid}", StartStep: ${Math.max(0, h.step - 4)}, EndStep: ${h.step + 6} })`,
      )
      .join("\n\n");
  };

  const readTranscriptImpl = async (arg = {}) => {
    const cidQuery = String(typeof arg === "string" ? arg : (arg?.ConversationId ?? arg?.conversationId ?? arg?.cid ?? "")).trim();
    if (!cidQuery) throw new Error("read_transcript requires `ConversationId` (full UUID or 8+ char prefix)");

    const sessions = collectAllSessions();
    const sessionMap = new Map(sessions.map((s) => [s.cid, s]));
    const target = sessionMap.get(cidQuery) || sessions.find((s) => s.cid.startsWith(cidQuery));
    if (!target) {
      throw new Error(`Conversation not found: ${cidQuery}`);
    }

    const startStep = arg?.StartStep ?? arg?.startStep ?? arg?.start;
    const endStep = arg?.EndStep ?? arg?.endStep ?? arg?.end;
    const maxChars = Math.min(60000, Math.max(2000, Number((arg?.MaxChars ?? arg?.maxChars) || 24000)));

    // Build parent chain if /fork lineage exists in conversation_summaries.db
    const chain = [];
    const seen = new Set();
    let cur = target;
    while (cur && !seen.has(cur.cid) && chain.length < 8) {
      seen.add(cur.cid);
      chain.unshift(cur);
      cur = cur.parentCid ? sessionMap.get(cur.parentCid) : null;
    }

    const parsedSteps = [];
    const seenSteps = new Set();
    for (let ci = chain.length - 1; ci >= 0; ci--) {
      const seg = chain[ci];
      if (!fs.existsSync(seg.transcriptPath)) continue;
      const lines = fs.readFileSync(seg.transcriptPath, "utf8").split(/\r?\n/);
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const obj = JSON.parse(l);
          const sidx = obj.step_index;
          if (typeof sidx !== "number" || seenSteps.has(sidx)) continue;
          seenSteps.add(sidx);
          parsedSteps.push({ ...obj, _cid: seg.cid });
        } catch {}
      }
    }
    parsedSteps.sort((a, b) => a.step_index - b.step_index);

    // Overview mode when no StartStep/EndStep provided
    if (startStep === undefined && endStep === undefined) {
      const userSteps = parsedSteps
        .filter((s) => s.type === "USER_INPUT")
        .map((s) => `[step ${s.step_index}] ${extractCleanUserText(s.content || "").replace(/\s+/g, " ").slice(0, 180)}`)
        .filter((line) => !line.endsWith("] "));
      const headUsers = userSteps.slice(0, 6);
      const tailUsers = userSteps.length > 6 ? userSteps.slice(-14) : [];
      const timeline =
        userSteps.length <= 20
          ? userSteps.join("\n")
          : `${headUsers.join("\n")}\n... (${userSteps.length - 20} earlier prompts omitted; pass StartStep/EndStep to inspect) ...\n${tailUsers.join("\n")}`;

      return (
        `=== Session ${target.cid} ===\n` +
        `Title: ${target.title || "(untitled)"} | Product: ${target.product} | Steps: ${parsedSteps.length}\n` +
        `Workspace: ${target.workspaces.join(", ") || "(none)"}\n` +
        `Lineage: ${chain.map((c) => c.cid.slice(0, 8)).join(" -> ")}\n\n` +
        `User Request Timeline:\n${timeline || "(no user prompts)"}`
      );
    }

    const from = Math.max(0, Number(startStep ?? 0));
    const to = endStep !== undefined ? Number(endStep) : from + 20;
    const filtered = parsedSteps.filter((s) => s.step_index >= from && s.step_index <= to);
    if (!filtered.length) {
      return `No steps in range [${from}, ${to}] for session ${target.cid} (available steps: ${parsedSteps[0]?.step_index ?? 0}..${parsedSteps[parsedSteps.length - 1]?.step_index ?? 0}).`;
    }

    const blocks = [];
    let total = 0;
    for (const s of filtered) {
      let block = "";
      if (s.type === "USER_INPUT") {
        block = `[step ${s.step_index} USER]:\n${extractCleanUserText(s.content || "")}`;
      } else if (s.type === "PLANNER_RESPONSE") {
        const tcText = Array.isArray(s.tool_calls) && s.tool_calls.length
          ? `\n  [Tools]: ${s.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.args || {}).slice(0, 260)})`).join("; ")}`
          : "";
        const thinkText = s.thinking ? `\n  [Thinking]: ${String(s.thinking).slice(0, 500)}${s.thinking.length > 500 ? "…" : ""}` : "";
        block = `[step ${s.step_index} ASSISTANT]: ${s.content || ""}${thinkText}${tcText}`;
      } else if (s.type === "GENERIC") {
        const txt = String(s.content || "");
        block = `[step ${s.step_index} TOOL_OUTPUT]: ${txt.slice(0, 1800)}${txt.length > 1800 ? `\n... [truncated ${txt.length - 1800} chars]` : ""}`;
      } else if (s.type === "CHECKPOINT") {
        block = `[step ${s.step_index} CHECKPOINT]: ${String(s.content || "").slice(0, 1800)}`;
      }
      if (!block) continue;
      if (total + block.length > maxChars && blocks.length > 0) {
        blocks.push(`... [truncated at ${maxChars} chars; call read_transcript with narrower StartStep/EndStep to continue from step ${s.step_index}]`);
        break;
      }
      blocks.push(block);
      total += block.length;
    }
    return `=== Transcript ${target.cid} (steps ${from}..${to}) ===\n\n${blocks.join("\n\n")}`;
  };

  return [
    {
      name: "read_file",
      aliases: ["read", "view_file"],
      namespace: "filesystem",
      description: "Read file contents. Supports Antigravity `{ Path, StartLine?, EndLine?, ByteOffset? }` and Pi `{ path, offset?, limit? }`.",
      declaration: "read_file(args: { Path?: string; path?: string; StartLine?: number; EndLine?: number; offset?: number; limit?: number } | string): Promise<string>;",
      execute: readFileImpl,
    },
    {
      name: "run_command",
      aliases: ["bash"],
      namespace: "shell",
      description: "Execute a shell command. Supports `{ CommandLine, timeout? }` and `{ command, timeout? }`. Always resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`.",
      declaration: "run_command(args: { CommandLine?: string; command?: string; timeout?: number } | string): Promise<{ output: string; truncated: boolean; full_output_path?: string; exit_code: number; wall_time_seconds: number }>;",
      execute: runCommandImpl,
    },
    {
      name: "grep",
      aliases: ["code_search", "grep_search"],
      namespace: "filesystem",
      description: "Fast in-process regex/literal search across files without spawning a shell.",
      declaration: "grep(args: { pattern?: string; Query?: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number } | string): Promise<string>;",
      execute: grepImpl,
    },
    {
      name: "find",
      aliases: ["find_by_name"],
      namespace: "filesystem",
      description: "Find files by glob pattern (skips .git, node_modules, target, dist).",
      declaration: "find(args: { pattern?: string; Pattern?: string; path?: string; limit?: number } | string): Promise<string>;",
      execute: findImpl,
    },
    {
      name: "ls",
      aliases: ["list_dir"],
      namespace: "filesystem",
      description: "List directory contents sorted alphabetically with '/' suffix for directories.",
      declaration: "ls(args?: { path?: string; Path?: string; limit?: number } | string): Promise<string>;",
      execute: lsImpl,
    },
    {
      name: "edit_file",
      aliases: ["edit"],
      namespace: "filesystem",
      description: "Edit a file via Antigravity `{ Path, Target, Replacement }` or Pi `{ path, edits: [{ oldText, newText }] }`.",
      declaration: "edit_file(args: { Path?: string; Target?: string; Replacement?: string; path?: string; edits?: Array<{ oldText: string; newText: string }> }): Promise<string>;",
      execute: editFileImpl,
    },
    {
      name: "write_file",
      aliases: ["write"],
      namespace: "filesystem",
      description: "Write or append a file via Antigravity `{ Path, Content, Overwrite?, Append? }` or Pi `{ path, content }`.",
      declaration: "write_file(args: { Path?: string; Content?: string; Overwrite?: boolean; Append?: boolean; path?: string; content?: string }): Promise<string>;",
      execute: writeFileImpl,
    },
    {
      name: "outline",
      aliases: ["view_file_outline", "file_outline"],
      namespace: "filesystem",
      description: "Extract function/class/struct/heading outline with exact 1-based line numbers for one or more files before slicing with read_file.",
      declaration: "outline(args: { Path?: string; path?: string; Paths?: string[]; limit?: number } | string | string[]): Promise<string>;",
      execute: outlineImpl,
    },
    {
      name: "git_diff",
      aliases: ["diff"],
      namespace: "git",
      description: "Get git diff for the workspace or a specific file (`{ Path?, Staged?, Stat?, Target? }`).",
      declaration: "git_diff(args?: { Path?: string; path?: string; Staged?: boolean; Stat?: boolean; Target?: string } | string): Promise<string>;",
      execute: gitDiffImpl,
    },
    {
      name: "git_status",
      aliases: ["status"],
      namespace: "git",
      description: "Get compact `git status --short --branch` output for the workspace.",
      declaration: "git_status(args?: { Path?: string; path?: string } | string): Promise<string>;",
      execute: gitStatusImpl,
    },
    {
      name: "search_sessions",
      aliases: ["search_history"],
      namespace: "memory",
      description: "Search across past Antigravity sessions and pre-compaction history in local transcript logs (`{ Query, Workspace?, Limit?, IncludeTools? }`).",
      declaration: "search_sessions(args: { Query?: string; query?: string; Workspace?: string; Limit?: number; IncludeTools?: boolean } | string): Promise<string>;",
      execute: searchSessionsImpl,
    },
    {
      name: "read_transcript",
      aliases: ["expand_transcript"],
      namespace: "memory",
      description: "Read a specific Antigravity conversation overview or verbatim step range (`{ ConversationId, StartStep?, EndStep?, MaxChars? }`), tracing /fork parents automatically.",
      declaration: "read_transcript(args: { ConversationId: string; StartStep?: number; EndStep?: number; MaxChars?: number } | string): Promise<string>;",
      execute: readTranscriptImpl,
    },
  ];
}

function rankToolsBm25(query, catalog, limit = 8, namespace = null) {
  const qTokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  const pool = namespace ? catalog.filter((d) => d.namespace === namespace) : catalog;
  const scored = pool.map((d) => {
    const hay = `${d.name} ${(d.aliases || []).join(" ")} ${d.namespace} ${d.description}`.toLowerCase();
    let score = 0;
    for (const tok of qTokens) {
      if (d.name.toLowerCase() === tok || (d.aliases || []).includes(tok)) score += 10;
      else if (d.name.toLowerCase().includes(tok)) score += 5;
      if (hay.includes(tok)) score += 2;
    }
    return {
      name: d.name,
      description: `${d.description}\n\ncodemode tool declaration:\n\`\`\`ts\ndeclare const tools: { ${d.declaration} };\n\`\`\``,
      score,
    };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ name, description }) => ({ name, description }));
}

function formatOutputItems(outputItems) {
  const textItems = outputItems.filter((item) => item.type === "text" && !item.console);
  const total = textItems.length;
  const lines = [];
  const consoleLines = [];
  let idx = 0;
  for (const item of outputItems) {
    if (item.console) {
      consoleLines.push(item.text);
    } else {
      idx++;
      lines.push(total > 1 ? `==> text ${idx}/${total} <==\n${item.text}` : item.text);
    }
  }
  if (consoleLines.length > 0) {
    lines.push(`<console_output>\n${consoleLines.join("\n")}\n</console_output>`);
  }
  return lines.join("\n");
}

function truncateScriptOutput(combined, maxTokens) {
  const budget = Math.max(256, Number(maxTokens || DEFAULT_MAX_OUTPUT_TOKENS)) * CHARS_PER_TOKEN;
  if (!combined || combined.length <= budget) return { text: combined, fullOutputPath: null };

  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = combined.slice(0, headChars);
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";

  ensureDir(DUMP_DIR);
  const dumpPath = path.join(DUMP_DIR, `pi-codemode-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.txt`);
  fs.writeFileSync(dumpPath, combined, "utf8");

  const out =
    `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\n` +
    `Total output lines: ${combined.split("\n").length}\n\n` +
    `${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}\n\n` +
    `[Full output: ${normPath(dumpPath)} (read with read_file StartLine/EndLine)]`;

  return { text: out, fullOutputPath: normPath(dumpPath) };
}

async function executeCodemode(args) {
  const startedAt = performance.now();
  const { code, options: sourceOptions } = parseCodemodeSource(String(args.code || ""));

  const maxTokens = args.max_output_tokens ?? sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = args.timeout_ms ?? sourceOptions.timeoutMs ?? 60_000;
  const baseDir = resolveDefaultWorkspaceDir(args.workspace_dir ?? args.Workspace);

  const readSet = new Set();
  const modSet = new Set();
  const defs = buildToolDefinitions(baseDir, readSet, modSet);
  const extSchemas = discoverExternalMcpSchemas();
  const fullCatalog = [...defs, ...extSchemas];
  const calls = [];

  const toolsProxy = {};
  for (const d of defs) {
    const wrappedFn = async (toolArgs) => {
      const rec = { name: d.name, status: "running" };
      calls.push(rec);
      try {
        const res = await d.execute(toolArgs);
        rec.status = "ok";
        return res;
      } catch (e) {
        rec.status = "error";
        throw e instanceof Error ? e : new Error(String(e));
      }
    };
    toolsProxy[d.name] = wrappedFn;
    for (const alias of d.aliases || []) {
      toolsProxy[alias] = wrappedFn;
    }
  }

  const outputItems = [];
  let totalChars = 0;
  const pushOutput = (item) => {
    if (outputItems.length >= MAX_OUTPUT_ITEMS) {
      throw new Error(`Exceeded maximum output items (${MAX_OUTPUT_ITEMS})`);
    }
    totalChars += item.text.length;
    if (totalChars > MAX_TOTAL_OUTPUT_CHARS) {
      throw new Error(`Exceeded maximum output size (${MAX_TOTAL_OUTPUT_CHARS} chars)`);
    }
    outputItems.push(item);
  };

  const valueText = (v) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));
  const text = (v) => pushOutput({ type: "text", console: false, text: valueText(v) });
  const logFn = () => (...parts) => {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    pushOutput({ type: "text", console: true, text: line });
  };

  const storeBuf = loadStoreFile();
  let storeDirty = false;
  const store = (key, value) => {
    if (typeof key !== "string" || !key) throw new Error("store() key must be a non-empty string");
    if (value === undefined) {
      if (key in storeBuf) {
        delete storeBuf[key];
        storeDirty = true;
      }
      return;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("store() value must be JSON-serializable");
    if (serialized.length > MAX_STORE_VALUE_CHARS) {
      throw new Error(`store() value for "${key}" exceeds ${MAX_STORE_VALUE_CHARS} chars`);
    }
    storeBuf[key] = JSON.parse(serialized);
    storeDirty = true;
  };
  const load = (key) => (typeof key === "string" ? storeBuf[key] : undefined);

  const ALL_TOOLS = fullCatalog.map((d) => ({
    name: d.name,
    aliases: d.aliases || [],
    description: `${d.description}\n\ncodemode tool declaration:\n\`\`\`ts\ndeclare const tools: { ${d.declaration} };\n\`\`\``,
  }));
  const searchTools = async (query, opts = {}) => {
    if (typeof query !== "string") throw new Error("searchTools() expects a query string");
    return rankToolsBm25(query, fullCatalog, opts?.limit ?? 8, opts?.namespace ?? null);
  };
  const describeTool = async (name) =>
    ALL_TOOLS.find((t) => t.name === name || (t.aliases && t.aliases.includes(name)))?.description;
  const describeNamespace = async (name) => {
    const matched = fullCatalog.filter((d) => d.namespace === name);
    if (!matched.length) return undefined;
    return { name, tools: matched.map((m) => m.name) };
  };

  const EXIT_SIGNAL = Symbol("exit");
  const exit = () => {
    throw EXIT_SIGNAL;
  };

  const sandbox = {
    ...toolsProxy,
    tools: toolsProxy,
    text,
    exit,
    store,
    load,
    ALL_TOOLS,
    searchTools,
    describeTool,
    describeNamespace,
    cwd: normPath(baseDir),
    console: {
      log: logFn(),
      info: logFn(),
      warn: logFn(),
      error: logFn(),
      debug: logFn(),
    },
    Promise,
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    RangeError,
  };

  let ok = true;
  let scriptErrorText = "";
  let timerId = null;

  const wrapped = `(async () => {\n${code}\n})()`;
  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(wrapped, { filename: "codemode-script.js" });
    const execPromise = script.runInContext(context);
    const retVal = await Promise.race([
      execPromise,
      new Promise((_, rej) => {
        timerId = setTimeout(() => rej(new Error(`Script timed out: exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    if (retVal !== undefined) text(retVal);
    if (storeDirty) saveStoreFile(storeBuf);
  } catch (e) {
    if (e === EXIT_SIGNAL) {
      if (storeDirty) saveStoreFile(storeBuf);
    } else {
      ok = false;
      const errMsg = e instanceof Error ? (e.stack || `${e.name}: ${e.message}`) : String(e);
      const callsSummary = calls.length
        ? `Tool calls made before the failure (they are not undone): ${calls.map((c) => `${c.name} (${c.status})`).join(", ")}`
        : "No tool calls were made.";
      scriptErrorText = `Script error:\n${errMsg}\n\n${callsSummary}`;
    }
  } finally {
    if (timerId) clearTimeout(timerId);
  }

  for (const c of calls) {
    if (c.status === "running") c.status = "cancelled";
  }

  recordFileOps(baseDir, [...readSet], [...modSet]);

  let formatted = formatOutputItems(outputItems);
  if (!ok && scriptErrorText) {
    formatted = formatted ? `${formatted}\n${scriptErrorText}` : scriptErrorText;
  }

  const bounded = truncateScriptOutput(formatted || "(no output)", maxTokens);
  const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
  const header = `${ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
  return {
    text: `${header}${bounded.text}`,
    isError: !ok,
  };
}

const CODEMODE_DESCRIPTION = `Run JavaScript that batches multiple file reads, searches, outlines, git diffs, and commands in one turn inside an isolated sandbox. Top-level \`await\` and \`return\` work.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`
- Built-in sandbox tools on \`tools.*\` (also available as top-level functions):
  - \`await tools.outline({ Path })\` (or \`{ Paths: string[] }\`) -> \`string\` (symbol signatures with \`L<line>:\` index)
  - \`await tools.read_file({ Path, StartLine?, EndLine?, ByteOffset? })\` -> \`string\`
  - \`await tools.grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })\` -> \`string\`
  - \`await tools.find({ pattern, path?, limit? })\` -> \`string\`
  - \`await tools.ls({ path?, limit? })\` -> \`string\`
  - \`await tools.git_diff({ Path?, Staged?, Stat?, Target? })\` & \`await tools.git_status()\` -> \`string\`
  - \`await tools.search_sessions({ Query, Workspace?, Limit? })\` & \`await tools.read_transcript({ ConversationId, StartStep?, EndStep? })\` -> \`string\` (cross-session & pre-compaction history recall)
  - \`await tools.run_command({ CommandLine, timeout? })\` -> \`{ output, truncated, full_output_path?, exit_code, wall_time_seconds }\`
  - \`await tools.edit_file({ Path, Target, Replacement })\` & \`await tools.write_file({ Path, Content, Overwrite?, Append? })\` -> \`string\`
- Globals: \`text(value)\`, \`console.log(...)\`, \`exit()\`, transactional \`store(key, value)\` / \`load(key)\`, \`ALL_TOOLS\`, \`await searchTools(query)\`, \`await describeTool(name)\`, \`cwd\`.`;

const TOOLS = [
  {
    name: "codemode",
    description: CODEMODE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Raw JavaScript async body (not JSON, no markdown code fences). Optional first line: // @options: {\"max_output_tokens\": 10000, \"timeout_ms\": 60000}",
        },
        workspace_dir: {
          type: "string",
          description: "Optional project root directory path for resolving relative paths.",
        },
      },
      required: ["code"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  queue = queue.then(async () => {
    const { id, method, params = {} } = req;
    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agy-codemode", version: "2.0.0" },
          },
        });
      } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
        // notification
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        if (params.name !== "codemode") throw new Error(`Unknown tool: ${params.name}`);
        const outcome = await executeCodemode(params.arguments || {});
        send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: outcome.isError,
            content: [{ type: "text", text: outcome.text }],
          },
        });
      } else if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    } catch (err) {
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          },
        });
      }
    }
  });
});

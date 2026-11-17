#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFile, execSync } from "node:child_process";
import readline from "node:readline";

const PLUGIN_DATA = process.env.PLUGIN_DATA || path.join(os.homedir(), ".gemini", "antigravity", "scratch", "agy-codemode-data");
const SCRATCH_DIR = path.join(os.homedir(), ".gemini", "antigravity", "scratch");
const DUMP_DIR = path.join(SCRATCH_DIR, "tool-dumps");
const HOTFILES_PATH = path.join(SCRATCH_DIR, "agy-codemode-hotfiles.json");
const STORE_PATH = path.join(PLUGIN_DATA, "store.json");

const DEFAULT_MAX_TOKENS = 8000;
const CHARS_PER_TOKEN = 3.5;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function resolveSafePath(target, baseDir) {
  if (!target || typeof target !== "string") throw new Error("Path must be a non-empty string");
  const clean = target.replace(/^@/, "").trim();
  return path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(baseDir, clean);
}

function recordHotFiles(baseDir, filePaths) {
  if (!filePaths.length) return;
  try {
    ensureDir(SCRATCH_DIR);
    let data = {};
    if (fs.existsSync(HOTFILES_PATH)) {
      try {
        data = JSON.parse(fs.readFileSync(HOTFILES_PATH, "utf8"));
      } catch {}
    }
    const key = normPath(path.resolve(baseDir)).toLowerCase();
    const prev = Array.isArray(data[key]) ? data[key] : [];
    const now = Date.now();
    const map = new Map();
    for (const item of prev) {
      if (item?.path) map.set(normPath(item.path).toLowerCase(), item);
    }
    for (const fp of filePaths) {
      const n = normPath(path.resolve(fp));
      map.set(n.toLowerCase(), { path: n, ts: now });
    }
    data[key] = [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, 24);
    fs.writeFileSync(HOTFILES_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {}
  return {};
}

function saveStore(obj) {
  ensureDir(PLUGIN_DATA);
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf8");
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

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", "__pycache__", ".venv", "venv"]);

async function walkFiles(dir, maxFiles = 2500, out = [], rootDir = dir) {
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

function runExec(command, cwd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-lc", command];
    execFile(
      shell,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
        const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          output: out,
          exitCode,
          timedOut: Boolean(err?.killed),
          wallTimeMs: Date.now() - start,
        });
      },
    ).stdin?.end();
  });
}

function dumpOverflow(prefix, fullText, maxChars) {
  if (fullText.length <= maxChars) return { text: fullText, truncated: false, dumpPath: null };
  ensureDir(DUMP_DIR);
  const id = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.log`;
  const dumpPath = path.join(DUMP_DIR, id);
  fs.writeFileSync(dumpPath, fullText, "utf8");
  const keepHalf = Math.floor((maxChars - 400) / 2);
  const head = fullText.slice(0, keepHalf);
  const tail = fullText.slice(-keepHalf);
  const omitted = fullText.length - head.length - tail.length;
  return {
    text: `${head}\n\n... [Truncated ${omitted} chars (~${Math.round(omitted / CHARS_PER_TOKEN)} tokens). Full output saved to: ${normPath(dumpPath)} ] ...\n\n${tail}`,
    truncated: true,
    dumpPath: normPath(dumpPath),
  };
}

function createSandboxHelpers(baseDir, touchedFiles, storeBuf) {
  const read = async (filePath, offset = 1, limit = 400) => {
    const abs = resolveSafePath(filePath, baseDir);
    const stat = await fsp.stat(abs);
    if (stat.size > 4 * 1024 * 1024) throw new Error(`File too large (${stat.size} bytes): ${abs}`);
    const raw = await fsp.readFile(abs, "utf8");
    touchedFiles.add(abs);
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Number(offset || 1)) - 1;
    const count = Math.max(1, Number(limit || lines.length));
    const sliced = lines.slice(start, start + count);
    const content = sliced.map((l, idx) => `${start + idx + 1}: ${l}`).join("\n");
    return {
      path: normPath(abs),
      totalLines: lines.length,
      startLine: start + 1,
      endLine: start + sliced.length,
      truncated: start + sliced.length < lines.length,
      text: content,
      raw: lines.slice(start, start + count).join("\n"),
    };
  };

  const readMany = async (items) => {
    if (!Array.isArray(items)) throw new Error("readMany expects an array of paths or {path, offset, limit}");
    return Promise.all(
      items.map(async (item) => {
        try {
          if (typeof item === "string") return await read(item);
          return await read(item.path, item.offset, item.limit);
        } catch (err) {
          return { path: String(item?.path || item), error: err.message };
        }
      }),
    );
  };

  const find = async (globPattern = "**/*", dir = ".") => {
    const targetDir = resolveSafePath(dir, baseDir);
    const files = await walkFiles(targetDir, 4000);
    const re = globToRegExp(globPattern);
    return files.filter((f) => re.test(f.rel) || re.test(path.basename(f.rel))).map((f) => f.rel);
  };

  const grep = async (pattern, dir = ".", opts = {}) => {
    const targetDir = resolveSafePath(dir, baseDir);
    const isRegex = opts.regex !== false;
    const flags = opts.ignoreCase ? "i" : "";
    const re = isRegex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const fileFilter = opts.glob ? globToRegExp(opts.glob) : null;
    const maxMatches = Number(opts.maxMatches || 120);
    const ctxLines = Math.max(0, Math.min(5, Number(opts.context || 0)));

    const files = (await walkFiles(targetDir, 3000)).filter((f) => !fileFilter || fileFilter.test(f.rel));
    const matches = [];
    for (const f of files) {
      if (matches.length >= maxMatches) break;
      try {
        const st = await fsp.stat(f.full);
        if (st.size > 1024 * 1024) continue;
        const txt = await fsp.readFile(f.full, "utf8");
        if (txt.includes("\u0000")) continue;
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const entry = { file: f.rel, line: i + 1, text: lines[i].slice(0, 260) };
            if (ctxLines > 0) {
              const s = Math.max(0, i - ctxLines);
              const e = Math.min(lines.length, i + ctxLines + 1);
              entry.context = lines.slice(s, e).map((l, k) => `${s + k + 1}: ${l.slice(0, 220)}`).join("\n");
            }
            matches.push(entry);
            if (matches.length >= maxMatches) break;
          }
        }
      } catch {}
    }
    return matches;
  };

  const tree = async (dir = ".", maxDepth = 3) => {
    const root = resolveSafePath(dir, baseDir);
    const lines = [];
    async function walk(d, depth, prefix) {
      if (depth > maxDepth || lines.length > 400) return;
      let ents;
      try {
        ents = (await fsp.readdir(d, { withFileTypes: true })).filter((e) => !SKIP_DIRS.has(e.name));
      } catch {
        return;
      }
      ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const ent of ents) {
        if (lines.length > 400) break;
        lines.push(`${prefix}${ent.name}${ent.isDirectory() ? "/" : ""}`);
        if (ent.isDirectory() && depth < maxDepth) {
          await walk(path.join(d, ent.name), depth + 1, `${prefix}  `);
        }
      }
    }
    await walk(root, 1, "");
    return lines.join("\n");
  };

  const stat = async (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return Promise.all(
      list.map(async (p) => {
        try {
          const abs = resolveSafePath(p, baseDir);
          const s = await fsp.stat(abs);
          return { path: normPath(abs), exists: true, isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
        } catch (err) {
          return { path: String(p), exists: false, error: err.code || err.message };
        }
      }),
    );
  };

  const diff = async (target = "HEAD") => {
    const safeTarget = String(target || "HEAD").replace(/[^a-zA-Z0-9_./~^-]/g, "");
    const res = await runExec(`git --no-pager diff ${safeTarget}`, baseDir, 15000);
    return res.output;
  };

  const gitStatus = async () => {
    const res = await runExec("git --no-pager status --short", baseDir, 10000);
    return res.output;
  };

  const sh = async (command, opts = {}) => {
    const t = Math.min(120000, Math.max(1000, Number(opts.timeoutMs || 25000)));
    const cwd = opts.cwd ? resolveSafePath(opts.cwd, baseDir) : baseDir;
    return runExec(command, cwd, t);
  };

  const store = (key, value) => {
    if (value === undefined) delete storeBuf[key];
    else storeBuf[key] = value;
  };

  const load = (key) => storeBuf[key];

  return { read, readMany, find, grep, tree, stat, diff, gitStatus, sh, store, load };
}

async function executeCodemode(args) {
  let rawCode = String(args.code || "");
  let maxTokens = Number(args.max_output_tokens || DEFAULT_MAX_TOKENS);
  let timeoutMs = Number(args.timeout_ms || 45000);

  // Support Pi-style first-line // @options: {...}
  const firstLineMatch = /^\/\/\s*@options:\s*(\{[^\n]+\})\s*\r?\n([\s\S]*)$/.exec(rawCode);
  if (firstLineMatch) {
    try {
      const opts = JSON.parse(firstLineMatch[1]);
      if (Number.isFinite(opts.max_output_tokens)) maxTokens = Number(opts.max_output_tokens);
      if (Number.isFinite(opts.timeout_ms)) timeoutMs = Number(opts.timeout_ms);
      rawCode = firstLineMatch[2];
    } catch {}
  }

  const baseDir = args.workspace_dir ? path.resolve(args.workspace_dir) : process.cwd();
  const touchedFiles = new Set();
  const storeBuf = loadStore();
  const helpers = createSandboxHelpers(baseDir, touchedFiles, storeBuf);

  const outputs = [];
  const consoleLines = [];
  const text = (v) => outputs.push(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const logFn = (level) => (...parts) => {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    consoleLines.push(level ? `[${level}] ${line}` : line);
  };
  const customExitSignal = Symbol("exit");
  const exit = () => {
    throw customExitSignal;
  };

  const sandbox = {
    ...helpers,
    tools: helpers,
    text,
    exit,
    cwd: normPath(baseDir),
    console: {
      log: logFn(""),
      info: logFn("info"),
      warn: logFn("warn"),
      error: logFn("error"),
      debug: logFn("debug"),
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
  };

  const start = Date.now();
  let status = "Script completed";
  let errText = "";

  const wrapped = `(async () => {\n${rawCode}\n})()`;
  let timerId = null;
  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(wrapped, { filename: "codemode-script.js" });
    const execPromise = script.runInContext(context);
    const retVal = await Promise.race([
      execPromise,
      new Promise((_, rej) => {
        timerId = setTimeout(() => rej(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (retVal !== undefined) text(retVal);
    saveStore(storeBuf);
  } catch (e) {
    if (e !== customExitSignal) {
      status = "Script failed";
      errText = e instanceof Error ? e.message : String(e);
    } else {
      saveStore(storeBuf);
    }
  } finally {
    if (timerId) clearTimeout(timerId);
  }

  recordHotFiles(baseDir, [...touchedFiles]);

  const wallSec = ((Date.now() - start) / 1000).toFixed(2);
  const blocks = [];
  if (outputs.length === 1) {
    blocks.push(outputs[0]);
  } else if (outputs.length > 1) {
    outputs.forEach((o, i) => blocks.push(`==> text ${i + 1}/${outputs.length} <==\n${o}`));
  }
  if (consoleLines.length > 0) {
    blocks.push(`<console_output>\n${consoleLines.join("\n")}\n</console_output>`);
  }
  if (errText) {
    blocks.push(`Script error: ${errText}`);
  }

  const maxChars = Math.max(2000, Math.round(maxTokens * CHARS_PER_TOKEN));
  const body = blocks.join("\n\n") || "(no output)";
  const bounded = dumpOverflow("codemode", body, maxChars);
  return `${status} in ${wallSec}s\n\n${bounded.text}`;
}

async function executeBatchReads(args) {
  const baseDir = args.workspace_dir ? path.resolve(args.workspace_dir) : process.cwd();
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new Error("files must be a non-empty array");
  const touched = new Set();
  const helpers = createSandboxHelpers(baseDir, touched, {});
  const results = await helpers.readMany(files);
  recordHotFiles(baseDir, [...touched]);
  const out = results
    .map((r) => {
      if (r.error) return `=== ${r.path} [ERROR: ${r.error}] ===`;
      return `=== ${r.path} (lines ${r.startLine}-${r.endLine} of ${r.totalLines}) ===\n${r.text}`;
    })
    .join("\n\n");
  return dumpOverflow("batch-reads", out, 36000).text;
}

const TOOLS = [
  {
    name: "codemode",
    description: `Execute a top-level async JavaScript script in an isolated VM sandbox to batch parallel codebase reads, searches, diffs, and filtering in a single turn. Only values emitted via return, text(), or console.log() enter context; large outputs are truncated and saved to a file.
Globals available:
- read(path, offset=1, limit=400) -> { path, totalLines, startLine, endLine, truncated, text, raw }
- readMany(Array<string | {path, offset?, limit?}>) -> parallel array of read results
- grep(pattern, dir=".", { regex=true, ignoreCase=false, glob?, maxMatches=120, context=0 })
- find(globPattern="**/*", dir=".") -> matching relative file paths
- tree(dir=".", maxDepth=3) -> indented directory tree
- stat(pathOrArray), diff(target="HEAD"), gitStatus()
- sh(command, { cwd?, timeoutMs=25000 }) -> { output, exitCode, timedOut, wallTimeMs }
- store(key, val) / load(key) -> persistent JSON across calls
- text(val), console.log(...), exit(), cwd`,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Raw JavaScript async body (no markdown fences). Optional first line: // @options: {\"max_output_tokens\": 8000, \"timeout_ms\": 45000}",
        },
        workspace_dir: {
          type: "string",
          description: "Optional workspace root directory; defaults to current working directory.",
        },
        max_output_tokens: { type: "number" },
        timeout_ms: { type: "number" },
      },
      required: ["code"],
    },
  },
  {
    name: "batch_reads",
    description: "Read multiple files or line slices concurrently in a single tool call. Automatically tracks read files for compaction rehydration.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  offset: { type: "number" },
                  limit: { type: "number" },
                },
                required: ["path"],
              },
            ],
          },
          description: "List of file paths or {path, offset, limit} objects.",
        },
        workspace_dir: { type: "string" },
      },
      required: ["files"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const id = req.id;
  const method = req.method;
  const params = req.params || {};

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agy-codemode", version: "1.0.0" },
        },
      });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // no response for notifications
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      let textOut;
      if (name === "codemode") textOut = await executeCodemode(args);
      else if (name === "batch_reads") textOut = await executeBatchReads(args);
      else throw new Error(`Unknown tool: ${name}`);

      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: textOut }] },
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

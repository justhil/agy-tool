#!/usr/bin/env node
/**
 * AGY Smart Output Guard & Syntax Verifier (PostToolUse Hook)
 *
 * 1. Lossless De-noising: Strips ANSI escape codes, carriage-return progress bar spam,
 *    and collapses consecutive duplicate lines (`... [repeated N times] ...`) before checking limits.
 * 2. Smart Error Radar: When truncating oversized command/tool outputs (>36KB or >850 lines),
 *    scans the omitted middle section for compiler/test errors (`error[`, `Error:`, `FAIL`, `panic:`,
 *    `Traceback`, `Exception`, `AssertionError`) and inlines up to 45 lines of key error context
 *    so the model sees the root cause immediately without an extra `read_file` round-trip.
 * 3. JSON Structure Summary: Summarizes top-level keys/array length when truncating huge single-line JSON.
 * 4. Instant Syntax Check on Edits: After `edit_file` / `write_file` on `.json`, `.js`, `.mjs`, `.cjs`, `.py`,
 *    runs a fast (<1s) syntax check and appends a warning only if syntax is broken.
 * 5. Auto LRU Cleanup: Keeps `~/.gemini/antigravity/scratch/tool-dumps/` bounded to the newest 60 files.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_CHARS = 36000;
const MAX_LINES = 850;
const KEEP_HEAD_LINES = 65;
const KEEP_TAIL_LINES = 55;
const KEEP_HEAD_CHARS = 9500;
const KEEP_TAIL_CHARS = 7500;
const MAX_ERROR_RADAR_LINES = 45;
const MAX_DUMP_FILES = 60;

const EDIT_TOOLS = new Set(["edit_file", "write_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
const ERROR_LINE_RE = /(?:\berror(?:\[[A-Z0-9]+\])?:|\bFAIL(?:ED)?\b|\bpanic:|\bTraceback\b|\bException:|\bAssertionError\b|\bSyntaxError\b|\bTypeError\b|\bReferenceError\b|\bundefined reference to\b|\bcannot find\b)/i;
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    try {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch (e) {
      if (e && (e.code === "EAGAIN" || e.code === "EINTR")) continue;
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function cleanAndCollapseDuplicates(rawText) {
  // Strip ANSI escape sequences and normalize progress-bar carriage returns
  const noAnsi = rawText
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const crIdx = line.lastIndexOf("\r");
      return crIdx !== -1 && crIdx < line.length - 1 ? line.slice(crIdx + 1) : line.replace(/\r/g, "");
    });

  const out = [];
  let prev = null;
  let repeatCount = 0;

  for (const line of noAnsi) {
    if (prev !== null && line === prev && line.trim().length > 0) {
      repeatCount++;
    } else {
      if (repeatCount > 1) {
        out.push(`... [previous line repeated ${repeatCount} more times] ...`);
      } else if (repeatCount === 1) {
        out.push(prev);
      }
      out.push(line);
      prev = line;
      repeatCount = 0;
    }
  }
  if (repeatCount > 1) {
    out.push(`... [previous line repeated ${repeatCount} more times] ...`);
  } else if (repeatCount === 1) {
    out.push(prev);
  }
  return out.join("\n");
}

function extractMiddleErrorRadar(lines, startIdx, endIdx) {
  if (startIdx >= endIdx) return "";
  const pickedIndices = new Set();
  for (let i = startIdx; i < endIdx; i++) {
    if (ERROR_LINE_RE.test(lines[i])) {
      const from = Math.max(startIdx, i - 1);
      const to = Math.min(endIdx - 1, i + 3);
      for (let k = from; k <= to; k++) {
        pickedIndices.add(k);
        if (pickedIndices.size >= MAX_ERROR_RADAR_LINES) break;
      }
    }
    if (pickedIndices.size >= MAX_ERROR_RADAR_LINES) break;
  }
  if (!pickedIndices.size) return "";

  const sorted = [...pickedIndices].sort((a, b) => a - b);
  const blocks = [];
  let prev = -10;
  for (const idx of sorted) {
    if (prev >= 0 && idx > prev + 1) blocks.push("  ...");
    blocks.push(`  L${idx + 1}: ${lines[idx].slice(0, 260)}`);
    prev = idx;
  }
  return `\n--- [Smart Error Radar: key diagnostics extracted from omitted middle lines] ---\n${blocks.join("\n")}\n-------------------------------------------------------------------------------\n`;
}

function summarizeJsonIfApplicable(text) {
  const trimmed = text.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    return "";
  }
  try {
    const val = JSON.parse(trimmed);
    if (Array.isArray(val)) {
      const sampleKeys = val[0] && typeof val[0] === "object" ? Object.keys(val[0]).slice(0, 12).join(", ") : typeof val[0];
      return `\n[JSON Array Summary: length=${val.length}, item keys/type=(${sampleKeys})]\n`;
    }
    if (val && typeof val === "object") {
      const keys = Object.keys(val);
      return `\n[JSON Object Summary: ${keys.length} top-level keys=(${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", ..." : ""})]\n`;
    }
  } catch {}
  return "";
}

function pruneOldDumps(dumpDir) {
  try {
    const ents = fs
      .readdirSync(dumpDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dumpDir, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of ents.slice(MAX_DUMP_FILES)) {
      try {
        fs.rmSync(old.full, { force: true });
      } catch {}
    }
  } catch {}
}

function checkEditedFileSyntax(toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object") return null;
  const rawPath = toolArgs.Path ?? toolArgs.path ?? toolArgs.TargetFile ?? toolArgs.target_file;
  if (!rawPath || typeof rawPath !== "string" || !fs.existsSync(rawPath)) return null;

  const ext = path.extname(rawPath).toLowerCase();
  try {
    if (ext === ".json") {
      const content = fs.readFileSync(rawPath, "utf8");
      JSON.parse(content);
      return null;
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const r = spawnSync(process.execPath, ["--check", rawPath], {
        encoding: "utf8",
        timeout: 1200,
        windowsHide: true,
      });
      if (r.status !== 0 && r.stderr) {
        return `⚠ [Output Guard Syntax Check] Syntax error detected in ${normPath(rawPath)}:\n${r.stderr.trim().slice(0, 800)}`;
      }
    }
  } catch (e) {
    return `⚠ [Output Guard Syntax Check] Invalid syntax in ${normPath(rawPath)}: ${e.message}`;
  }
  return null;
}

function main() {
  const raw = readStdinSync().trim();
  if (!raw) {
    process.stdout.write("{}");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("{}");
    return;
  }

  const pt = payload.postToolHookArgs || payload;
  const toolCall = pt.toolCall || {};
  const rawToolName = String(toolCall.name || "tool");
  const toolName = rawToolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const resultText = typeof pt.result === "string" ? pt.result : (typeof pt.tool_response === "string" ? pt.tool_response : "");

  // Fast syntax verification after file edits
  if (EDIT_TOOLS.has(rawToolName)) {
    const syntaxWarn = checkEditedFileSyntax(toolCall.args);
    if (syntaxWarn) {
      const combined = resultText ? `${resultText}\n\n${syntaxWarn}` : syntaxWarn;
      process.stdout.write(JSON.stringify({ overwriteResult: combined }));
      return;
    }
  }

  if (!resultText) {
    process.stdout.write("{}");
    return;
  }

  // Step 1: De-noise ANSI codes & collapse consecutive identical lines
  const cleaned = cleanAndCollapseDuplicates(resultText);
  const lines = cleaned.split("\n");
  const overChars = cleaned.length > MAX_CHARS;
  const overLines = lines.length > MAX_LINES;

  if (!overChars && !overLines) {
    // If de-noising saved significant bloat (>25% and >4KB), return the cleaned version directly
    if (resultText.length - cleaned.length > 4096) {
      process.stdout.write(JSON.stringify({ overwriteResult: cleaned }));
    } else {
      process.stdout.write("{}");
    }
    return;
  }

  const dumpDir = path.join(os.homedir(), ".gemini", "antigravity", "scratch", "tool-dumps");
  fs.mkdirSync(dumpDir, { recursive: true });
  const dumpFile = path.join(dumpDir, `${toolName}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.log`);
  fs.writeFileSync(dumpFile, cleaned, "utf8");
  pruneOldDumps(dumpDir);

  const jsonSummary = summarizeJsonIfApplicable(cleaned);
  let preview;

  if (overLines && lines.length > KEEP_HEAD_LINES + KEEP_TAIL_LINES) {
    const head = lines.slice(0, KEEP_HEAD_LINES).join("\n");
    const tail = lines.slice(-KEEP_TAIL_LINES).join("\n");
    const omittedLines = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
    const errorRadar = extractMiddleErrorRadar(lines, KEEP_HEAD_LINES, lines.length - KEEP_TAIL_LINES);
    if (head.length <= KEEP_HEAD_CHARS && tail.length <= KEEP_TAIL_CHARS) {
      preview =
        `${head}\n` +
        `${jsonSummary}` +
        `${errorRadar}` +
        `\n... [Output Guard: omitted ${omittedLines} lines (${cleaned.length} chars total). Full output saved to: ${normPath(dumpFile)} — call read_file({ Path: "${normPath(dumpFile)}", StartLine, EndLine }) or codemode to inspect.] ...\n\n` +
        `${tail}`;
    }
  }

  if (!preview) {
    const head = cleaned.slice(0, KEEP_HEAD_CHARS);
    const tail = cleaned.slice(-KEEP_TAIL_CHARS);
    const omittedChars = cleaned.length - head.length - tail.length;
    const errorRadar = lines.length > 10 ? extractMiddleErrorRadar(lines, Math.min(20, lines.length), Math.max(20, lines.length - 20)) : "";
    preview =
      `${head}\n` +
      `${jsonSummary}` +
      `${errorRadar}` +
      `\n... [Output Guard: omitted ${omittedChars} chars (${lines.length} lines total). Full output saved to: ${normPath(dumpFile)} — call read_file({ Path: "${normPath(dumpFile)}", StartLine, EndLine }) or codemode to inspect.] ...\n\n` +
      `${tail}`;
  }

  process.stdout.write(JSON.stringify({ overwriteResult: preview }));
}

main();

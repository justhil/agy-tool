#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const MAX_CHARS = 28000;
const MAX_LINES = 750;
const KEEP_HEAD_LINES = 70;
const KEEP_TAIL_LINES = 60;
const KEEP_HEAD_CHARS = 10000;
const KEEP_TAIL_CHARS = 8000;

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
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
  const toolName = String(toolCall.name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
  const resultText = typeof pt.result === "string" ? pt.result : "";

  if (!resultText) {
    process.stdout.write("{}");
    return;
  }

  const lines = resultText.split(/\r?\n/);
  const overChars = resultText.length > MAX_CHARS;
  const overLines = lines.length > MAX_LINES;

  if (!overChars && !overLines) {
    process.stdout.write("{}");
    return;
  }

  const dumpDir = path.join(os.homedir(), ".gemini", "antigravity", "scratch", "tool-dumps");
  fs.mkdirSync(dumpDir, { recursive: true });
  const dumpFile = path.join(dumpDir, `${toolName}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.log`);
  fs.writeFileSync(dumpFile, resultText, "utf8");

  let preview;
  if (overLines && lines.length > KEEP_HEAD_LINES + KEEP_TAIL_LINES) {
    const head = lines.slice(0, KEEP_HEAD_LINES).join("\n");
    const tail = lines.slice(-KEEP_TAIL_LINES).join("\n");
    const omittedLines = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
    if (head.length <= KEEP_HEAD_CHARS && tail.length <= KEEP_TAIL_CHARS) {
      preview =
        `${head}\n\n` +
        `... [Output guard: omitted ${omittedLines} lines (${resultText.length} chars total). Full output saved to: ${normPath(dumpFile)} — use read_file with offset/limit or codemode to inspect.] ...\n\n` +
        `${tail}`;
    }
  }

  if (!preview) {
    const head = resultText.slice(0, KEEP_HEAD_CHARS);
    const tail = resultText.slice(-KEEP_TAIL_CHARS);
    const omittedChars = resultText.length - head.length - tail.length;
    preview =
      `${head}\n\n` +
      `... [Output guard: omitted ${omittedChars} chars (${lines.length} lines total). Full output saved to: ${normPath(dumpFile)} — use read_file with offset/limit or codemode to inspect.] ...\n\n` +
      `${tail}`;
  }

  process.stdout.write(JSON.stringify({ overwriteResult: preview }));
}

main();

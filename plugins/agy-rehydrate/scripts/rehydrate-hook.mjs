#!/usr/bin/env node
/**
 * AGY Lossless Post-Compaction State Rehydration (+ /fork lineage stitching)
 * Pure Node.js, zero external deps. Cross-platform (Windows / macOS / Linux)
 * and cross-surface (Antigravity Desktop 2.0 / agy CLI / Antigravity IDE).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MARKER_PREFIX = "[POST-COMPACT REHYDRATION v1";

// Sized gracefully for 512K window (~32K-42K tokens = 6%-8% of context)
const BUDGET_ALL_USER_CHARS = 28000;
const BUDGET_RECENT_TURNS_CHARS = 48000;
const BUDGET_SKILLS_SPECS_CHARS = 24000;
const BUDGET_FILES_TOTAL_CHARS = 56000;
const BUDGET_SINGLE_FILE_CHARS = 14000;

const RECENT_USER_VERBATIM_COUNT = 75;
const SHORT_USER_MAX_CHARS = 4;
const FOLD_PASTE_THRESHOLD_CHARS = 800;
const FOLD_PASTE_HEAD_CHARS = 300;
const FOLD_PASTE_TAIL_CHARS = 200;

const MAX_MODIFIED_FILES = 4;
const MAX_REFERENCED_FILES = 4;
const MAX_FORK_DEPTH = 8;
const FRESH_CHECKPOINT_MAX_GAP = 8;
const MAX_INJECT_STEP_BYTES = 44000; // Under AGY 49,152-byte per-SystemMessageStep limit

const READ_TOOL_NAMES = new Set(["read_file", "view_file", "view_file_outline", "view_code_item"]);
const WRITE_TOOL_NAMES = new Set([
  "edit_file",
  "write_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
  ".pdf", ".pptx", ".docx", ".xlsx", ".zip", ".tar", ".gz", ".tgz", ".7z",
  ".mp4", ".mov", ".avi", ".mp3", ".wav", ".ogg",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a",
  ".pt", ".pth", ".ckpt", ".safetensors", ".onnx", ".npy", ".npz", ".ply",
  ".db", ".sqlite", ".sqlite3", ".wal", ".shm", ".pb", ".pyc", ".bak",
]);

const SKIP_PATH_SUBSTRINGS = [
  "/.system_generated/",
  "/node_modules/",
  "/.git/",
  "/__pycache__/",
  "/dev/shm/",
  "/tmp/",
  "/antigravity/scratch/tool-dumps/",
  "/antigravity-cli/log/",
  "/antigravity-cli/history.jsonl",
  "/builtin/skills/antigravity_guide/",
  "/builtin/skills/agy-customizations/",
];

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function isAbsPath(p) {
  return typeof p === "string" && (path.isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("/"));
}

function extractUserText(raw) {
  if (!raw) return "";
  const matches = [];
  const re = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1].trim()) matches.push(m[1].trim());
  }
  if (matches.length) return matches.join("\n");
  return raw.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "").trim();
}

function isLowInfoShortTurn(txt) {
  if (/[A-Za-z0-9/]/.test(txt)) return false;
  const core = txt.replace(/[\s\p{P}\p{S}\p{Z}\p{C}]/gu, "");
  return core.length <= SHORT_USER_MAX_CHARS;
}

function foldUserPaste(txt, segPath, lineNo, stepIdx) {
  if (txt.length <= FOLD_PASTE_THRESHOLD_CHARS) return [txt, false];
  const omitted = txt.length - FOLD_PASTE_HEAD_CHARS - FOLD_PASTE_TAIL_CHARS;
  if (omitted <= 120) return [txt, false];
  const loc = segPath ? `${normPath(segPath)} line ${lineNo} (step ${stepIdx})` : `step ${stepIdx}`;
  return [
    `${txt.slice(0, FOLD_PASTE_HEAD_CHARS)}\n  ...[folded ${omitted} chars of pasted content; read_file ${loc} if exact text needed]...\n${txt.slice(-FOLD_PASTE_TAIL_CHARS)}`,
    true,
  ];
}

function extractToolFilePath(args, workspacePaths = []) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["Path", "path", "TargetFile", "target_file", "AbsolutePath", "absolute_path", "File", "file"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      const clean = val.trim().replace(/^@/, "");
      if (isAbsPath(clean)) return path.normalize(clean);
      if (workspacePaths.length > 0) return path.resolve(workspacePaths[0], clean);
    }
  }
  return "";
}

function summarizeToolCalls(toolCalls) {
  const parts = [];
  for (const tc of (toolCalls || []).slice(0, 8)) {
    const name = tc?.name || "?";
    const args = tc?.args || {};
    if (READ_TOOL_NAMES.has(name) || WRITE_TOOL_NAMES.has(name)) {
      const p = extractToolFilePath(args);
      parts.push(`${name}(${p ? path.basename(p) : "?"})`);
    } else if (name === "run_command" || name === "run_in_terminal") {
      let cmd = String(args.CommandLine || args.Command || args.command || "").trim().replace(/\n/g, " ");
      if (cmd.length > 60) cmd = cmd.slice(0, 57) + "...";
      parts.push(`${name}(\`${cmd}\`)`);
    } else {
      parts.push(name);
    }
  }
  if ((toolCalls || []).length > 8) parts.push(`+${toolCalls.length - 8} more`);
  return parts.join(", ");
}

function isEligibleTextFile(pathStr) {
  if (!isAbsPath(pathStr)) return false;
  const n = normPath(pathStr);
  const lower = n.toLowerCase();
  for (const sub of SKIP_PATH_SUBSTRINGS) {
    if (lower.includes(sub.toLowerCase())) return false;
  }
  const ext = path.extname(n).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  try {
    const st = fs.statSync(pathStr);
    return st.isFile() && st.size > 0 && st.size <= 2 * 1024 * 1024;
  } catch {
    return false;
  }
}

function isSkillOrSpec(pathStr) {
  const name = path.basename(pathStr);
  const upper = name.toUpperCase();
  return name === "SKILL.md" || name === "AGENTS.md" || (upper.endsWith(".MD") && /(SPEC|PLAN|TEMPLATE|HANDOFF)/.test(upper));
}

function readTextClipped(pathStr, maxChars) {
  let text;
  try {
    const fd = fs.openSync(pathStr, "r");
    const buf = Buffer.alloc(maxChars * 3);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.slice(0, bytesRead).toString("utf8");
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.68);
  const tailLen = Math.max(0, maxChars - headLen - 90);
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n... [truncated ~${omitted} chars in middle; read_file for full content] ...\n${tailLen > 0 ? text.slice(-tailLen) : ""}`;
}

function parseIsoEpoch(ts) {
  if (!ts || typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function inferCidFromTranscriptPath(tpath) {
  const parts = path.resolve(tpath).split(path.sep);
  if (parts.length >= 4 && parts[parts.length - 2] === "logs" && parts[parts.length - 3] === ".system_generated") {
    return parts[parts.length - 4];
  }
  return path.basename(path.dirname(tpath));
}

function readFirstStepInfo(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.slice(0, n).toString("utf8").split(/\r?\n/);
    for (const raw of lines.slice(0, 16)) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw);
        if (typeof obj.step_index === "number") {
          return { step: obj.step_index, epoch: parseIsoEpoch(obj.created_at) };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function findStepEpochInTranscript(jsonlPath, targetStep) {
  try {
    const st = fs.statSync(jsonlPath);
    if (st.size <= 0) return null;
    const tailWindow = Math.min(st.size, 65536);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(tailWindow);
    fs.readSync(fd, buf, 0, tailWindow, st.size - tailWindow);
    fs.closeSync(fd);

    let lines = buf.toString("utf8").split(/\r?\n/);
    if (st.size > tailWindow && lines.length > 0) lines = lines.slice(1);

    let lastStep = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        if (typeof obj.step_index !== "number") continue;
        if (lastStep === null) {
          lastStep = obj.step_index;
          if (lastStep < targetStep) return null;
        }
        if (obj.step_index === targetStep) {
          return { lastStep, epoch: parseIsoEpoch(obj.created_at) };
        }
        if (obj.step_index < targetStep) return null;
      } catch {}
    }

    // Fallback scan for long conversations where parent advanced well past K-1
    const fullLines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/);
    for (const raw of fullLines) {
      if (!raw.includes(`"step_index":${targetStep}`) && !raw.includes(`"step_index": ${targetStep}`)) continue;
      try {
        const obj = JSON.parse(raw);
        if (obj.step_index === targetStep) {
          return { lastStep: lastStep ?? targetStep, epoch: parseIsoEpoch(obj.created_at) };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function loadHistoryForkHints(brainDir) {
  const cidWorkspaces = new Map();
  const forkEvents = [];
  const histPath = path.join(path.dirname(brainDir), "history.jsonl");
  if (!fs.existsSync(histPath)) return { cidWorkspaces, forkEvents };
  try {
    const st = fs.statSync(histPath);
    const win = Math.min(st.size, 524288);
    const fd = fs.openSync(histPath, "r");
    const buf = Buffer.alloc(win);
    fs.readSync(fd, buf, 0, win, st.size - win);
    fs.closeSync(fd);
    let lines = buf.toString("utf8").split(/\r?\n/);
    if (st.size > win && lines.length > 0) lines = lines.slice(1);
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw);
        const cid = obj.conversationId;
        const ws = obj.workspace;
        if (typeof cid === "string" && cid) {
          if (typeof ws === "string" && ws) {
            if (!cidWorkspaces.has(cid)) cidWorkspaces.set(cid, new Set());
            cidWorkspaces.get(cid).add(ws);
          }
          if (obj.display === "/fork" && typeof obj.timestamp === "number") {
            forkEvents.push({ cid, ts: obj.timestamp / 1000 });
          }
        }
      } catch {}
    }
  } catch {}
  return { cidWorkspaces, forkEvents };
}

function resolveForkAncestors(curPath, cached = null) {
  const firstInfo = readFirstStepInfo(curPath);
  if (!firstInfo || firstInfo.step <= 0) return [];

  if (Array.isArray(cached) && cached.length > 0) {
    const valid = cached.every((s) => s.path && fs.existsSync(s.path) && s.max_step >= s.min_step);
    if (valid && cached[cached.length - 1].max_step + 1 === firstInfo.step) {
      return cached;
    }
  }

  const curCid = inferCidFromTranscriptPath(curPath);
  const brainDir = path.resolve(curPath, "..", "..", "..");
  if (!fs.existsSync(brainDir)) return [];

  const { cidWorkspaces, forkEvents } = loadHistoryForkHints(brainDir);
  const visited = new Set([curCid]);
  const chainRev = [];

  let childFirst = firstInfo.step;
  let childEpoch = firstInfo.epoch;
  let childCid = curCid;

  for (let hop = 0; hop < MAX_FORK_DEPTH && childFirst > 0; hop++) {
    const targetPrev = childFirst - 1;
    let bestScore = null;
    let bestSeg = null;
    let bestEpoch = null;

    let dirs = [];
    try {
      dirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      break;
    }

    for (const ent of dirs) {
      const cid = ent.name;
      if (visited.has(cid)) continue;
      const candPath = path.join(brainDir, cid, ".system_generated", "logs", "transcript_full.jsonl");
      if (!fs.existsSync(candPath)) continue;
      const pFirst = readFirstStepInfo(candPath);
      if (!pFirst || pFirst.step > targetPrev) continue;
      const found = findStepEpochInTranscript(candPath, targetPrev);
      if (!found) continue;
      if (childEpoch !== null && found.epoch !== null && found.epoch > childEpoch + 5) continue;

      const wsMatch = cidWorkspaces.has(childCid) && cidWorkspaces.has(cid)
        ? [...cidWorkspaces.get(childCid)].some((w) => cidWorkspaces.get(cid).has(w)) ? 1 : 0
        : 0;
      const forkHit = childEpoch !== null && forkEvents.some((e) => e.cid === cid && found.epoch - 2 <= e.ts && e.ts <= childEpoch + 5) ? 1 : 0;
      const exactTip = found.lastStep === targetPrev ? 1 : 0;
      const delta = childEpoch !== null && found.epoch !== null ? Math.max(0, childEpoch - found.epoch) : 1e9;
      const score = [forkHit, wsMatch, exactTip, -delta];

      if (!bestScore || score.some((v, idx) => v !== bestScore[idx] ? v > bestScore[idx] : false && false) || compareScore(score, bestScore) > 0) {
        bestScore = score;
        bestSeg = { cid, path: candPath, min_step: pFirst.step, max_step: targetPrev };
        bestEpoch = pFirst.epoch;
      }
    }

    if (!bestSeg) break;
    chainRev.push(bestSeg);
    visited.add(bestSeg.cid);
    childFirst = bestSeg.min_step;
    childEpoch = bestEpoch;
    childCid = bestSeg.cid;
  }

  return chainRev.reverse();
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function parseTranscriptSteps(segments, upToStep, workspacePaths = []) {
  const userInputs = [];
  const dialogue = [];
  const fileReads = new Map();
  const fileWrites = new Map();
  let lastCheckpoint = null;

  for (const seg of segments) {
    if (!fs.existsSync(seg.path)) continue;
    const lines = fs.readFileSync(seg.path, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const sidx = obj.step_index;
      if (typeof sidx !== "number") continue;
      if (seg.min_step !== null && sidx < seg.min_step) continue;
      if (seg.max_step !== null && sidx > seg.max_step) continue;
      if (sidx >= upToStep) continue;

      const typ = obj.type;
      if (typ === "USER_INPUT") {
        const text = extractUserText(obj.content || "");
        if (text) {
          userInputs.push({ step: sidx, text, segPath: seg.path, lineNo: i + 1, cid: seg.cid });
          dialogue.push({ role: "USER", step: sidx, text });
        }
      } else if (typ === "PLANNER_RESPONSE") {
        const tc = obj.tool_calls || [];
        for (const call of tc) {
          const cname = call?.name || "";
          const fp = extractToolFilePath(call?.args, workspacePaths);
          if (fp) {
            if (WRITE_TOOL_NAMES.has(cname)) fileWrites.set(fp, sidx);
            else if (READ_TOOL_NAMES.has(cname)) fileReads.set(fp, sidx);
          }
        }
        const content = (obj.content || "").trim();
        const tcSummary = tc.length ? summarizeToolCalls(tc) : "";
        if (content || tcSummary) {
          dialogue.push({ role: "ASSISTANT", step: sidx, text: content, tools: tcSummary });
        }
      } else if (typ === "CHECKPOINT" && seg.isCurrent) {
        lastCheckpoint = { step: sidx, summary: (obj.content || "").trim() };
      }
    }
  }

  return { userInputs, dialogue, fileReads, fileWrites, lastCheckpoint };
}

function getCodemodeHotFiles(workspacePaths = []) {
  const hotPath = path.join(os.homedir(), ".gemini", "antigravity", "scratch", "agy-codemode-hotfiles.json");
  if (!fs.existsSync(hotPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(hotPath, "utf8"));
    const results = [];
    const targets = workspacePaths.map((w) => normPath(path.resolve(w)).toLowerCase());
    for (const [wsKey, list] of Object.entries(data)) {
      if (targets.length === 0 || targets.some((t) => t === wsKey || wsKey.startsWith(t) || t.startsWith(wsKey))) {
        if (Array.isArray(list)) results.push(...list);
      }
    }
    return results.sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((x) => x.path);
  } catch {
    return [];
  }
}

function buildRehydration(transcriptPath, upToCheckpointStep, ancestors, workspacePaths) {
  const curCid = inferCidFromTranscriptPath(transcriptPath);
  const segments = [
    ...ancestors.map((a) => ({ ...a, isCurrent: false })),
    { cid: curCid, path: transcriptPath, min_step: 0, max_step: null, isCurrent: true },
  ];

  const { userInputs, dialogue, fileReads, fileWrites } = parseTranscriptSteps(segments, upToCheckpointStep, workspacePaths);

  const lineageTag = segments.map((s) => `${s.cid.slice(0, 8)}(${s.min_step}..${s.max_step ?? upToCheckpointStep - 1})`).join("->");
  const header = `${MARKER_PREFIX} | checkpoint=${upToCheckpointStep} | fork_lineage=${lineageTag}]`;

  // Section 1: Complete User Request Timeline
  const totalUsers = userInputs.length;
  const recentThreshold = Math.max(0, totalUsers - RECENT_USER_VERBATIM_COUNT);
  const formattedUsers = [];
  for (let idx = 0; idx < totalUsers; idx++) {
    const u = userInputs[idx];
    const isRecent = idx >= recentThreshold;
    if (!isRecent && isLowInfoShortTurn(u.text)) continue;
    const [txt] = foldUserPaste(u.text, u.segPath, u.lineNo, u.step);
    formattedUsers.push(`[step ${u.step}] ${txt}`);
  }

  let s1Body = "";
  if (formattedUsers.length) {
    const full = formattedUsers.join("\n---\n");
    if (full.length <= BUDGET_ALL_USER_CHARS) {
      s1Body = full;
    } else {
      const early = formattedUsers.slice(0, 5).join("\n---\n");
      const tailItems = [];
      let rem = BUDGET_ALL_USER_CHARS - early.length - 120;
      for (let i = formattedUsers.length - 1; i >= 5; i--) {
        if (formattedUsers[i].length + 5 > rem) break;
        tailItems.unshift(formattedUsers[i]);
        rem -= formattedUsers[i].length + 5;
      }
      s1Body = `${early}\n\n... [older mid-session prompts omitted for budget] ...\n\n${tailItems.join("\n---\n")}`;
    }
  }
  const sec1 = `## 1. Complete User Request Timeline (${formattedUsers.length}/${totalUsers} turns)\n${s1Body || "(none)"}`;

  // Section 2: Recent Pre-Compaction Verbatim Dialogue
  const tailDiag = [];
  let diagChars = 0;
  for (let i = dialogue.length - 1; i >= 0; i--) {
    const d = dialogue[i];
    const line = d.role === "USER"
      ? `**[USER step ${d.step}]**: ${d.text}`
      : `**[ASSISTANT step ${d.step}]**: ${d.text}${d.tools ? `\n  _(Tools run: ${d.tools})_` : ""}`;
    if (diagChars + line.length + 2 > BUDGET_RECENT_TURNS_CHARS && tailDiag.length > 0) break;
    tailDiag.unshift(line);
    diagChars += line.length + 2;
  }
  const sec2 = `## 2. Recent Pre-Compaction Verbatim Dialogue\n${tailDiag.join("\n\n") || "(none)"}`;

  // Merge hot files from transcript + agy-codemode
  const codemodeHots = getCodemodeHotFiles(workspacePaths);
  for (const ch of codemodeHots) {
    if (!fileReads.has(ch) && !fileWrites.has(ch)) {
      fileReads.set(ch, upToCheckpointStep - 1);
    }
  }

  // Section 3: Active Skills & Spec Docs
  const allTouched = new Map([...fileReads, ...fileWrites]);
  const sortedTouched = [...allTouched.entries()].sort((a, b) => b[1] - a[1]);
  const specChunks = [];
  let specChars = 0;
  for (const [fp] of sortedTouched) {
    if (!isSkillOrSpec(fp) || !isEligibleTextFile(fp)) continue;
    const content = readTextClipped(fp, Math.min(BUDGET_SINGLE_FILE_CHARS, BUDGET_SKILLS_SPECS_CHARS - specChars));
    if (!content) continue;
    specChunks.push(`### ${normPath(fp)}\n\`\`\`markdown\n${content}\n\`\`\``);
    specChars += content.length;
    if (specChars >= BUDGET_SKILLS_SPECS_CHARS) break;
  }
  const sec3 = `## 3. Restored Active Skills & Spec Docs\n${specChunks.join("\n\n") || "(none)"}`;

  // Section 4: Restored Active Workspace Files (Top modified + Top read)
  const modList = [...fileWrites.entries()].filter(([fp]) => !isSkillOrSpec(fp) && isEligibleTextFile(fp)).sort((a, b) => b[1] - a[1]).slice(0, MAX_MODIFIED_FILES);
  const modSet = new Set(modList.map(([fp]) => fp.toLowerCase()));
  const refList = [...fileReads.entries()].filter(([fp]) => !modSet.has(fp.toLowerCase()) && !isSkillOrSpec(fp) && isEligibleTextFile(fp)).sort((a, b) => b[1] - a[1]).slice(0, MAX_REFERENCED_FILES);

  const fileChunks = [];
  let fileChars = 0;
  for (const [tag, list] of [["MODIFIED", modList], ["READ", refList]]) {
    for (const [fp] of list) {
      if (fileChars >= BUDGET_FILES_TOTAL_CHARS) break;
      const cap = Math.min(BUDGET_SINGLE_FILE_CHARS, BUDGET_FILES_TOTAL_CHARS - fileChars);
      const content = readTextClipped(fp, cap);
      if (!content) continue;
      fileChunks.push(`### [${tag}] ${normPath(fp)}\n\`\`\`\n${content}\n\`\`\``);
      fileChars += content.length;
    }
  }
  const sec4 = `## 4. Restored Active Workspace Files\n${fileChunks.join("\n\n") || "(none)"}`;

  return [header, sec1, sec2, sec3, sec4];
}

function splitIntoInjectChunks(sections) {
  const header = sections[0];
  const chunks = [];
  let cur = `${header}\n\n`;

  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i];
    if (Buffer.byteLength(cur + sec + "\n\n", "utf8") <= MAX_INJECT_STEP_BYTES) {
      cur += sec + "\n\n";
    } else {
      if (cur.trim() !== header) chunks.push(cur.trim());
      if (Buffer.byteLength(`${header} (cont.)\n\n${sec}`, "utf8") <= MAX_INJECT_STEP_BYTES) {
        cur = `${header} (cont.)\n\n${sec}\n\n`;
      } else {
        // Split large section by paragraph
        const paras = sec.split("\n\n");
        let part = `${header} (cont.)\n\n`;
        for (const p of paras) {
          if (Buffer.byteLength(part + p + "\n\n", "utf8") > MAX_INJECT_STEP_BYTES) {
            if (part.trim()) chunks.push(part.trim());
            part = `${header} (cont.)\n\n${p.slice(0, 12000)}\n\n`;
          } else {
            part += p + "\n\n";
          }
        }
        cur = part;
      }
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.map((text) => ({ systemMessage: { systemMessage: text } }));
}

function findTranscriptCandidates(common) {
  const cands = [];
  if (common.transcriptPath) {
    const tp = path.resolve(common.transcriptPath);
    const full = path.join(path.dirname(tp), "transcript_full.jsonl");
    if (fs.existsSync(full)) cands.push(full);
    if (fs.existsSync(tp)) cands.push(tp);
  }
  const cid = common.conversationId;
  if (cid) {
    for (const product of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
      const p = path.join(os.homedir(), ".gemini", product, "brain", cid, ".system_generated", "logs", "transcript_full.jsonl");
      if (fs.existsSync(p)) cands.push(p);
    }
  }
  return cands.find(Boolean) || null;
}

function tailScanLatestCheckpoint(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const win = Math.min(st.size, 262144);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(win);
    fs.readSync(fd, buf, 0, win, st.size - win);
    fs.closeSync(fd);
    let lines = buf.toString("utf8").split(/\r?\n/);
    if (st.size > win && lines.length > 0) lines = lines.slice(1);

    let lastCp = -1;
    let lastStep = 0;
    let alreadyRehydrated = false;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw);
        if (typeof obj.step_index === "number") lastStep = Math.max(lastStep, obj.step_index);
        if (obj.type === "CHECKPOINT") {
          lastCp = obj.step_index;
          alreadyRehydrated = false;
        } else if (obj.type === "SYSTEM_MESSAGE" && String(obj.content || "").includes(MARKER_PREFIX)) {
          if (lastCp >= 0 && obj.step_index > lastCp) alreadyRehydrated = true;
        }
      } catch {}
    }
    return { lastCp, lastStep, alreadyRehydrated };
  } catch {
    return { lastCp: -1, lastStep: 0, alreadyRehydrated: false };
  }
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {}
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

  const common = payload.common || payload;
  const transcriptPath = findTranscriptCandidates(common);
  if (!transcriptPath) {
    process.stdout.write("{}");
    return;
  }

  const { lastCp, lastStep, alreadyRehydrated } = tailScanLatestCheckpoint(transcriptPath);
  if (lastCp < 0 || alreadyRehydrated || lastStep - lastCp > FRESH_CHECKPOINT_MAX_GAP) {
    process.stdout.write("{}");
    return;
  }

  const cid = common.conversationId || inferCidFromTranscriptPath(transcriptPath);
  const stateDir = path.join(os.homedir(), ".gemini", "antigravity", "scratch", "rehydrate-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${cid}.json`);

  let state = {};
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {}
  }

  if (state.last_rehydrated_cp === lastCp) {
    process.stdout.write("{}");
    return;
  }

  const ancestors = resolveForkAncestors(transcriptPath, state.fork_ancestors);
  const workspacePaths = Array.isArray(common.workspacePaths) ? common.workspacePaths : (common.cwd ? [common.cwd] : []);
  const sections = buildRehydration(transcriptPath, lastCp, ancestors, workspacePaths);
  const injectSteps = splitIntoInjectChunks(sections);

  state.last_rehydrated_cp = lastCp;
  state.fork_ancestors = ancestors;
  state.updated_at = Date.now();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

  process.stdout.write(JSON.stringify({ injectSteps }));
}

main();

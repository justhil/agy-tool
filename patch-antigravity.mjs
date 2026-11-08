#!/usr/bin/env node
/**
 * Antigravity (CLI / Desktop / IDE) — System Prompt & Context Window Surgical Patcher
 *
 * 功能矩阵（全部可独立开关、支持命令行参数与数字键交互菜单）：
 *
 * 一、提示词精简档位 (--prompt 1|2|3|4|restore)
 *   - [1] 1档 · 仅去广告与推销 (Ad-Block Only)
 *         仅剥离 slash_commands.tmpl 与 plugins.tmpl（去除 /goal、/boost、/teamwork 与商业插件推销），其余 100% 保持原版。
 *   - [2] 2档 · 原版最大化纯净精简 (Max Stock Slotting)
 *         剥离全部 7 个冗余/致幻模板（artifacts, persistent_context, knowledge_items, planning_mode_artifacts,
 *         conversation_transcript, slash_commands, plugins），但保留原版的 guidelines、function_call、communication_style 不做外部改写。
 *   - [3] 3档 · Amp × Argon 全量重构版 (Full Amp × Argon Surgical Overhaul) [当前标准档]
 *         剥离 7 个冗余模板 + 将 guidelines / function_call / communication_style 全面替换为融合 Amp 与 Argon 指南的重构版。
 *   - [4] 4档 · 2档原版底子 + Amp/Argon 防幻觉护栏增强 (Stock Base + Amp/Argon Anti-Hallucination)
 *         在 2 档最大化精简原版的基础上，保留原版行文风格，精准注入 Amp 最佳实践与 Argon 防幻觉护栏（Grounding Override、
 *         Code-Judo 最小改动、edit_file 唯一锚点、禁止非必要 ArtifactMetadata、Clean Tool Turns、爆炸半径验证）。
 *   - [0 / restore] 恢复原版默认提示词
 *
 * 二、上下文窗口解锁档位 (--context 512k|900k|restore)
 *   - [512k] 解锁 512K 上下文上限（将 Cortex 引擎 GetCheckpointConfig 中的 256K/128K 硬编码封顶提升至 512,000，并同步写入配置文件）
 *   - [900k] 解锁 900K / 1M 满血上下文（NOP 跳过 GetCheckpointConfig 中的 0x3e800/0x1f400 封顶指令，释放完整 ~983K 物理窗口）
 *   - [restore] 恢复原版默认上下文限制
 *
 * 用法示例：
 *   node patch-antigravity.mjs                         # 进入交互式数字键菜单
 *   node patch-antigravity.mjs --inspect               # 只读扫描本机二进制状态
 *   node patch-antigravity.mjs --prompt 4 --context 900k # 一键应用 4 档提示词 + 900K 上下文解锁
 *   node patch-antigravity.mjs --restore               # 一键全部恢复官方默认状态
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const HOME = os.homedir().replace(/\\/g, "/");
const LOCAL_APPDATA = (process.env.LOCALAPPDATA || path.join(HOME, "AppData/Local")).replace(/\\/g, "/");

export const TARGET_BINARIES = [
  {
    id: "cli",
    label: "Antigravity Desktop / CLI 内核 (language_server.exe)",
    path: `${LOCAL_APPDATA}/Programs/antigravity/resources/bin/language_server.exe`,
  },
  {
    id: "ide",
    label: "Antigravity IDE 扩展内核 (language_server_windows_x64.exe)",
    path: `${LOCAL_APPDATA}/Programs/Antigravity IDE/resources/app/extensions/antigravity/bin/language_server_windows_x64.exe`,
  },
];

// ============================================================================
// 提示词载荷定义（适配 1~4 档，严格控制在 IDE 与 CLI 最小槽位字节上限内）
// Capacity limits: guidelines <= 691B, function_call <= 605B, communication_style <= 2792B
// ============================================================================

// --- [Tier 3] 全量重构版 ---
export const TIER3_GUIDELINES = `Follow these core engineering mandates at all times:
- **Grounding Override (No Guessing)**: Your pretraining rule to estimate when uncertain is SUSPENDED for repository facts. Never make claims about files, symbols, or configs you have not read in this session. Read the defining source first.
- **Smallest Correct Change (Code-Judo)**: Prefer solutions that delete branches, wrappers, or special cases. Touch the fewest lines necessary. Preserve unrelated comments, docstrings, and formatting.
- **Sandbox & Boundary Integrity**: Never bypass access controls, permission checks, or sandbox boundaries. If blocked, report the exact blocker and stop.`;

export const TIER3_FUNCTION_CALL = `- **Clean Tool Turns**: Emit tool calls directly without unstructured prose preambles or trailing colons (never write "Let me read the file:" before a tool call).
- **Parallel Discovery, Sequential Edits**: Batch independent read-only calls (\`read_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`) in parallel in one turn. Include context lines in \`grep_search\` to avoid extra \`read_file\` turns.
- **Reactive Wakeup (No Polling)**: Background \`run_command\` and \`invoke_subagent\` tasks wake you automatically on completion. NEVER poll \`command_status\` in a loop or run \`sleep\`.`;

export const TIER3_COMMUNICATION_STYLE = `## Intent & Autonomy
- Distinguish **Inquiries** (questions, architecture reviews, root-cause analysis) from **Directives** (explicit requests to write, edit, or run code):
  - For **Inquiries**: Deliver a grounded assessment directly in chat. Do NOT modify files until a Directive is given.
  - For **Directives**: Execute end-to-end (focused discovery -> surgical edit -> targeted verification) without stopping mid-task to ask permission on reversible local steps. If critical requirements are genuinely ambiguous, call \`ask_question\` once with concise options (place the recommended option first with "(Recommended)").

## Native Tool Contracts (Preserve All Built-in Tools)
- **Direct Chat Delivery (No Brain Artifacts)**: Deliver all explanations, plans, diffs, and reports directly in your chat response. Do NOT write markdown summary files to \`brain/\` or pass \`ArtifactMetadata\` when editing workspace code files (passing \`ArtifactMetadata\` on non-artifact workspace paths causes a tool error), unless the user explicitly asks to create an artifact.
- **\`edit_file\` Uniqueness Guard**: In \`edit_file\`, every occurrence of \`Target\` in the file is replaced. Always include 3-5 lines of unchanged surrounding context in \`Target\` so it matches exactly one unique location. Perform multiple edits to the same file sequentially across turns rather than in parallel. Use \`write_file\` only for new files or full rewrites.
- **Dedicated Tools First**: Use \`read_file\`, \`edit_file\`, \`write_file\`, \`grep_search\`, \`find_by_name\`, and \`list_dir\` instead of shell \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`find\`.
- **Subagent Delegation**: When delegating via \`invoke_subagent\`, frame open-ended research questions without presupposing the conclusion, and spot-check cited file ranges before relying on them.

## Verification & Honesty
- Scale verification with blast radius: run the narrowest test, typecheck, or build via \`run_command\` that proves your change works.
- Never claim work is complete or tests pass when verification failed or was skipped. Before ending a Directive turn, ensure your final paragraph is a completed outcome, not an unexecuted promise ("I'll now...").

## Output & Formatting Style
- Lead with the conclusion or outcome in sentence 1. Keep prose under 4 lines (excluding code blocks, tables, or diagrams) unless asked for depth.
- Link all files and symbols using \`[name](file:///absolute/path/to/file#L10-L20)\` (use forward slashes \`/\` on Windows).
- Escape literal dollar signs as \`\\$\` or wrap prices/shell variables (\`$HOME\`, \`$1\`) in backticks so KaTeX does not misrender them as math.`;

// --- [Tier 4] 2档原版底子 + Amp 最佳实践与 Argon 防幻觉护栏增强 ---
export const TIER4_GUIDELINES = `Follow these behavioral guidelines at all times:
- Maintain documentation integrity. Preserve all existing comments and docstrings unrelated to your changes.
- Never defeat or bypass an access control, permission check, credential requirement, or sandbox boundary. If none of the sanctioned paths work, report the error and stop.
- **Argon Grounding Override**: Your pretraining rule to estimate when uncertain is SUSPENDED for codebase facts. Never make confident claims about files, symbols, or configs you have not read via \`read_file\`.
- **Surgical Scope (Amp Code-Judo)**: Make the smallest correct change. Prefer deleting branches or wrappers over adding new layers.`;

export const TIER4_FUNCTION_CALL = `You support batch function calling. When executing independent operations (reading multiple files, running searches, checking resources), call multiple tools in parallel in a single turn. Do NOT batch operations that depend on previous outputs.
- **Argon Clean Tool Turns**: Emit tool calls directly without unstructured prose preambles or trailing colons (e.g., never write "Let me read:" before a tool call).
- **Search Context & No Polling**: Include context lines in \`grep_search\` to save extra \`read_file\` turns. Background tasks wake you automatically; NEVER poll \`command_status\` in a loop.`;

export const TIER4_COMMUNICATION_STYLE = `- Keep your responses concise and formatted in github-style markdown.
- LaTeX math (KaTeX) is rendered in direct responses: inline with \\(...\\) or $...$, display with \\[...\\] or $$...$$. '$' opens inline math, so write a literal dollar as '\\$' or wrap it in backticks.
- You MUST create clickable links for all files and code symbols using github-style markdown links with the file:// scheme (e.g. \`[ symbol ](file:///abs/path#L10-L20)\`).

## Amp & Argon Anti-Hallucination Guardrails
- **Inquiry vs. Directive**: Treat questions/reviews as Inquiries (do NOT edit files). Treat explicit coding tasks as Directives (execute discovery -> minimal edit -> verification end-to-end without stopping to ask permission on reversible local steps; use \`ask_question\` only for genuine requirement ambiguity).
- **Direct Chat Delivery**: Deliver all explanations, plans, diffs, and summaries directly in chat. Do NOT write report files to \`brain/\` or pass \`ArtifactMetadata\` when editing workspace code files unless explicitly requested.
- **\`edit_file\` Uniqueness Guard**: Because \`edit_file\` replaces every occurrence of \`Target\`, always include 3-5 lines of unchanged surrounding context in \`Target\` so it matches a single unique location. Edit the same file sequentially across turns.
- **Debiased Subagents**: When calling \`invoke_subagent\`, ask open-ended questions without presupposing the answer, and verify cited file lines before relying on them.
- **Blast-Radius Verification**: After editing code, run the narrowest test, typecheck, or build command via \`run_command\` that proves the change works. Never claim tests pass or work is complete when verification was skipped or failed.`;

// 槽位清单分类
const AD_SLOTS = [
  "system_prompts/slash_commands.tmpl",
  "system_prompts/plugins.tmpl",
];

const BLOAT_SLOTS = [
  "system_prompts/artifacts.tmpl",
  "system_prompts/persistent_context.tmpl",
  "system_prompts/knowledge_items.tmpl",
  "system_prompts/planning_mode_artifacts.tmpl",
  "system_prompts/conversation_transcript.tmpl",
  "system_prompts/slash_commands.tmpl",
  "system_prompts/plugins.tmpl",
];

// ============================================================================
// PE64 + Go embed.FS 解析器
// ============================================================================
function parsePeEmbedTemplates(buf) {
  const peOffset = buf.readUInt32LE(0x3c);
  const numSections = buf.readUInt16LE(peOffset + 6);
  const optHeaderSize = buf.readUInt16LE(peOffset + 20);
  const imageBase = buf.readBigUInt64LE(peOffset + 24 + 24);
  const secTableOffset = peOffset + 24 + optHeaderSize;

  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = secTableOffset + i * 40;
    sections.push({
      vSize: buf.readUInt32LE(off + 8),
      vAddr: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20),
    });
  }

  const fileOffsetToVA = (foff) => {
    for (const s of sections) {
      if (foff >= s.rawPtr && foff < s.rawPtr + s.rawSize) {
        return imageBase + BigInt(s.vAddr + (foff - s.rawPtr));
      }
    }
    return 0n;
  };

  const vaToFileOffset = (va) => {
    const rva = Number(va - imageBase);
    for (const s of sections) {
      if (rva >= s.vAddr && rva < s.vAddr + s.vSize) {
        return s.rawPtr + (rva - s.vAddr);
      }
    }
    return -1;
  };

  const anchorName =
    "google3/third_party/jetski/prompt/template_provider/templates/system_prompts/identity.tmpl";
  const foff = buf.indexOf(anchorName);
  if (foff === -1) {
    throw new Error("Cannot find identity.tmpl path string in binary");
  }
  const va = fileOffsetToVA(foff);
  const needle = Buffer.alloc(16);
  needle.writeBigUInt64LE(va, 0);
  needle.writeBigUInt64LE(BigInt(anchorName.length), 8);

  const entryOff = buf.indexOf(needle);
  if (entryOff === -1) {
    throw new Error("Cannot locate Go embed.FS slice entry for identity.tmpl");
  }

  const templates = new Map();
  for (let k = -12; k <= 12; k++) {
    const e = entryOff + k * 48;
    if (e < 0 || e + 48 > buf.length) continue;
    const nVa = buf.readBigUInt64LE(e);
    const nLen = Number(buf.readBigUInt64LE(e + 8));
    const dVa = buf.readBigUInt64LE(e + 16);
    const dLen = Number(buf.readBigUInt64LE(e + 24));
    const nOff = vaToFileOffset(nVa);
    const dOff = vaToFileOffset(dVa);
    if (nOff > 0 && nLen > 0 && nLen < 240) {
      const fullName = buf.slice(nOff, nOff + nLen).toString("utf8");
      if (fullName.startsWith("google3/third_party/jetski/prompt/template_provider/templates/")) {
        const shortName = fullName.replace(
          "google3/third_party/jetski/prompt/template_provider/templates/",
          ""
        );
        templates.set(shortName, {
          shortName,
          fullName,
          entryOffset: e,
          dataOffset: dOff,
          dataLength: dLen,
        });
      }
    }
  }
  return templates;
}

function writePaddedTemplate(buf, slot, newText) {
  const encoded = Buffer.from(newText, "utf8");
  if (encoded.length > slot.dataLength) {
    throw new Error(
      `Template ${slot.shortName} overflow: new=${encoded.length}B > capacity=${slot.dataLength}B`
    );
  }
  const padLen = slot.dataLength - encoded.length;
  const padding =
    padLen >= 12
      ? Buffer.from("{{- /*" + " ".repeat(padLen - 12) + "*/ -}}")
      : Buffer.from(" ".repeat(padLen));

  encoded.copy(buf, slot.dataOffset);
  padding.copy(buf, slot.dataOffset + encoded.length);
  return encoded.length;
}

// ============================================================================
// 上下文解锁引擎（支持 512K / 900K(1M) / 恢复原版）
// 定位 utils.GetCheckpointConfig 中的 256K (0x3e800) / 128K (0x1f400) 硬编码封顶指令
// ============================================================================
const CONTEXT_SIGNATURES = [
  {
    id: "cli_main_256k_cap",
    desc: "CLI/Desktop utils.GetCheckpointConfig 主路径 256K (0x3e800) cmovb 封顶",
    stockHex:    "8b54244c81fa00e80300be00e803000f42f289742450",
    patch512k:   "8b54244c81fa00d00700be00d007000f42f289742450", // 0x7d000 = 512,000
    patch900k:   "8b54244c81fa00e8030089d690909090909089742450", // mov esi, edx + 6x NOP (彻底跳过 256k 封顶，直通 ~983K)
  },
  {
    id: "cli_fallback_256k_cap",
    desc: "CLI/Desktop utils.GetCheckpointConfig 兜底 256K (0x3e800) 赋值",
    stockHex:    "837a14007f07c7400c00e80300",
    patch512k:   "837a14007f07c7400c00d00700", // 512,000
    patch900k:   "837a14007f07c7400ca0bb0d00", // 900,000 (0xdbba0)
  },
  {
    id: "cli_serializer_max_ctx",
    desc: "CLI/Desktop populateContextWindowMetadata 前端上限显示值",
    stockHex:    "4889442470488b8c24a80100008908b830000000",
    patch512k:   "4889442470c70000d0070090909090b830000000",
    patch900k:   "4889442470c70000000f0090909090b830000000",
  },
  {
    id: "ide_main_128k_cap",
    desc: "IDE utils.GetCheckpointConfig 主路径 128K (0x1f400) cmovb 封顶",
    stockHex:    "8b4c245429d181f900f40100ba00f401000f42d18954244c",
    patch512k:   "8b4c245429d181f900d00700ba00d007000f42d18954244c", // 0x7d000 = 512,000
    patch900k:   "8b4c245429d181f900f4010089ca9090909090908954244c", // mov edx, ecx + 6x NOP (彻底释放 1M-16K=~983K)
  },
];

function inspectContextState(buf) {
  const results = [];
  for (const sig of CONTEXT_SIGNATURES) {
    const bStock = Buffer.from(sig.stockHex, "hex");
    const b512 = Buffer.from(sig.patch512k, "hex");
    const b900 = Buffer.from(sig.patch900k, "hex");

    const offStock = buf.indexOf(bStock);
    const off512 = buf.indexOf(b512);
    const off900 = buf.indexOf(b900);

    if (offStock !== -1) {
      results.push({ sig, status: "STOCK (256K/128K 默认限制)", offset: offStock });
    } else if (off512 !== -1) {
      results.push({ sig, status: "UNLOCKED 512K", offset: off512 });
    } else if (off900 !== -1) {
      results.push({ sig, status: "UNLOCKED 900K/1M (满血无上限)", offset: off900 });
    }
  }
  return results;
}

function applyContextPatchToBuffer(buf, bakBuf, mode) {
  let appliedCount = 0;
  for (const sig of CONTEXT_SIGNATURES) {
    const bStock = Buffer.from(sig.stockHex, "hex");
    const offInBak = bakBuf.indexOf(bStock);
    if (offInBak === -1) continue;

    let replacement;
    if (mode === "restore" || mode === "stock") {
      replacement = bStock;
    } else if (mode === "512k") {
      replacement = Buffer.from(sig.patch512k, "hex");
    } else if (mode === "900k" || mode === "1m") {
      replacement = Buffer.from(sig.patch900k, "hex");
    } else {
      throw new Error(`Unknown context mode: ${mode}`);
    }

    replacement.copy(buf, offInBak);
    appliedCount++;
    console.log(`  [CTX] ${sig.desc} @${offInBak} -> ${mode.toUpperCase()}`);
  }
  return appliedCount;
}

function syncSettingsJsonContextWindow(mode) {
  const settingsPaths = [
    `${HOME}/.gemini/config/config.json`,
    `${HOME}/.gemini/antigravity-cli/settings.json`,
  ];
  for (const sp of settingsPaths) {
    try {
      const dir = path.dirname(sp);
      if (!fs.existsSync(dir)) continue;
      let obj = {};
      if (fs.existsSync(sp)) {
        obj = JSON.parse(fs.readFileSync(sp, "utf8"));
      }
      if (mode === "restore" || mode === "stock") {
        delete obj.contextWindow;
      } else if (mode === "512k") {
        obj.contextWindow = "512K";
      } else if (mode === "900k" || mode === "1m") {
        obj.contextWindow = "900K";
      }
      fs.writeFileSync(sp, JSON.stringify(obj, null, 2) + "\n", "utf8");
      console.log(`  [CFG] Synced ${sp} -> contextWindow: ${obj.contextWindow || "(default)"}`);
    } catch (e) {
      // Ignore non-critical config write errors
    }
  }
}

// ============================================================================
// 提示词档位应用引擎 (Tier 1 / 2 / 3 / 4 / Restore)
// ============================================================================
function applyPromptTierToBuffer(buf, bakBuf, tier) {
  const bakTemplates = parsePeEmbedTemplates(bakBuf);
  const curTemplates = parsePeEmbedTemplates(buf);

  // Step 1: First restore all template slots from backup so switching between any tiers is 100% clean
  for (const [name, bakSlot] of bakTemplates.entries()) {
    if (bakSlot.dataOffset > 0 && bakSlot.dataLength > 0) {
      bakBuf.copy(
        buf,
        bakSlot.dataOffset,
        bakSlot.dataOffset,
        bakSlot.dataOffset + bakSlot.dataLength
      );
    }
  }

  // Bypass genericsystemprompt.applyEdits init() substring panic check on CLI v2.29+
  const applyEditsPrefix = Buffer.from("488b71104889742458488b711848897424384889d1", "hex");
  const applyEditsTailStock = Buffer.from("4883f8010f8474ffffff", "hex");
  const applyEditsTailBypass = Buffer.from("4883f801e975ffffff90", "hex");
  const prefixOff = bakBuf.indexOf(applyEditsPrefix);

  if (tier === "restore" || tier === "0" || tier === "stock") {
    if (prefixOff !== -1) {
      const tailOff = prefixOff + applyEditsPrefix.length + 5;
      if (tailOff + 10 <= bakBuf.length && bakBuf.subarray(tailOff, tailOff + 10).equals(applyEditsTailStock)) {
        applyEditsTailStock.copy(buf, tailOff);
      }
    }
    console.log("  [PROMPT] Restored all 13 .tmpl slots to 100% official stock.");
    return;
  }

  const t = String(tier);
  if (t === "1") {
    // 1档：仅去广告（只清空 slash_commands.tmpl 与 plugins.tmpl）
    let saved = 0;
    for (const name of AD_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataOffset > 0) {
        writePaddedTemplate(buf, slot, "");
        saved += slot.dataLength;
      }
    }
    console.log(`  [PROMPT -> Tier 1 (仅去广告)] Stripped slash_commands & plugins (-${saved} Bytes). Other slots untouched.`);
  } else if (t === "2") {
    // 2档：原版最大化精简无用提示词（清空 7 个冗余/致幻槽位，保留原版 guidelines/function_call/communication_style）
    let saved = 0;
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataOffset > 0) {
        writePaddedTemplate(buf, slot, "");
        saved += slot.dataLength;
      }
    }
    console.log(`  [PROMPT -> Tier 2 (原版最大化精简)] Stripped 7 bloat slots (-${saved} Bytes). Kept stock core instructions.`);
  } else if (t === "3") {
    // 3档：现在的全量重构档位（清空 7 个冗余槽位 + 替换为 Amp × Argon 全量重构版）
    let saved = 0;
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataOffset > 0) {
        writePaddedTemplate(buf, slot, "");
        saved += slot.dataLength;
      }
    }
    writePaddedTemplate(curTemplates.get("system_prompts/guidelines.tmpl"), curTemplates.get("system_prompts/guidelines.tmpl"), TIER3_GUIDELINES);
    writePaddedTemplate(curTemplates.get("system_prompts/function_call.tmpl"), curTemplates.get("system_prompts/function_call.tmpl"), TIER3_FUNCTION_CALL);
    writePaddedTemplate(curTemplates.get("system_prompts/communication_style.tmpl"), curTemplates.get("system_prompts/communication_style.tmpl"), TIER3_COMMUNICATION_STYLE);
    console.log(`  [PROMPT -> Tier 3 (Amp × Argon 全量重构版)] Stripped 7 bloat slots (-${saved}B) + Replaced 3 core slots.`);
  } else if (t === "4") {
    // 4档：2档基础上加入 Amp 最佳实践与 Argon 防幻觉护栏（保留原版行文 + Grounding Override / Uniqueness Guard）
    let saved = 0;
    for (const name of BLOAT_SLOTS) {
      const slot = curTemplates.get(name);
      if (slot && slot.dataOffset > 0) {
        writePaddedTemplate(buf, slot, "");
        saved += slot.dataLength;
      }
    }
    writePaddedTemplate(buf, curTemplates.get("system_prompts/guidelines.tmpl"), TIER4_GUIDELINES);
    writePaddedTemplate(buf, curTemplates.get("system_prompts/function_call.tmpl"), TIER4_FUNCTION_CALL);
    writePaddedTemplate(buf, curTemplates.get("system_prompts/communication_style.tmpl"), TIER4_COMMUNICATION_STYLE);
    console.log(`  [PROMPT -> Tier 4 (2档底子 + Amp/Argon 防幻觉增强)] Stripped 7 bloat slots (-${saved}B) + Injected Argon anti-hallucination rules.`);
  } else {
    throw new Error(`Invalid prompt tier: ${tier} (expected 1, 2, 3, 4, or restore)`);
  }

  if (prefixOff !== -1) {
    const tailOff = prefixOff + applyEditsPrefix.length + 5;
    if (tailOff + 10 <= bakBuf.length && bakBuf.subarray(tailOff, tailOff + 10).equals(applyEditsTailStock)) {
      applyEditsTailBypass.copy(buf, tailOff);
    }
  }

  // Safety check: identity.tmpl must remain 100% untouched
  const idSlot = curTemplates.get("system_prompts/identity.tmpl");
  const idText = buf.slice(idSlot.dataOffset, idSlot.dataOffset + idSlot.dataLength).toString("utf8");
  if (!idText.includes("You are Antigravity, a powerful agentic AI coding assistant")) {
    throw new Error("CRITICAL: identity.tmpl integrity check failed!");
  }
}

// ============================================================================
// 状态扫描与执行主流程
// ============================================================================
export function inspectAll() {
  console.log("\n=========================================================================");
  console.log(" Antigravity 本机二进制状态扫描 (Prompt Slots & Context Window Gates)");
  console.log("=========================================================================");

  for (const target of TARGET_BINARIES) {
    console.log(`\n▶ ${target.label}`);
    console.log(`  路径: ${target.path}`);
    if (!fs.existsSync(target.path)) {
      console.log("  [未安装] 未找到该二进制文件，跳过。");
      continue;
    }
    const bakExists = fs.existsSync(target.path + ".bak");
    console.log(`  备份: ${bakExists ? "已存在 (.bak)" : "尚未创建 (首次修改时自动备份)"}`);

    const buf = fs.readFileSync(target.path);
    const templates = parsePeEmbedTemplates(buf);

    // Check prompt state
    const slashSlot = templates.get("system_prompts/slash_commands.tmpl");
    const artSlot = templates.get("system_prompts/artifacts.tmpl");
    const guideSlot = templates.get("system_prompts/guidelines.tmpl");

    const slashTxt = slashSlot ? buf.slice(slashSlot.dataOffset, slashSlot.dataOffset + 30).toString("utf8") : "";
    const artTxt = artSlot ? buf.slice(artSlot.dataOffset, artSlot.dataOffset + 30).toString("utf8") : "";
    const guideTxt = guideSlot ? buf.slice(guideSlot.dataOffset, guideSlot.dataOffset + guideSlot.dataLength).toString("utf8") : "";

    let promptState = "原版默认 (Stock 50.7KB / 42.5KB)";
    if (slashTxt.startsWith("{{- /*") && !artTxt.startsWith("{{- /*")) {
      promptState = "1档 · 仅去广告 (Ad-Block Only)";
    } else if (artTxt.startsWith("{{- /*")) {
      if (guideTxt.includes("core engineering mandates")) {
        promptState = "3档 · Amp × Argon 全量重构版";
      } else if (guideTxt.includes("Argon Grounding Override")) {
        promptState = "4档 · 2档原版底子 + Amp/Argon 防幻觉增强";
      } else {
        promptState = "2档 · 原版最大化纯净精简";
      }
    }
    console.log(`  提示词状态: ${promptState}`);

    // Check context window state
    const ctxStates = inspectContextState(buf);
    for (const c of ctxStates) {
      console.log(`  上下文门禁: [${c.status}] (${c.sig.desc} @${c.offset})`);
    }
  }
  console.log("");
}

export function executeOperations({ promptTier, contextMode }) {
  for (const target of TARGET_BINARIES) {
    if (!fs.existsSync(target.path)) continue;
    console.log(`\n▶ 正在处理: ${target.label}`);
    const bakPath = target.path + ".bak";
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(target.path, bakPath);
      console.log(`  [BACKUP] 已创建原始备份: ${bakPath}`);
    }

    const curBuf = Buffer.from(fs.readFileSync(target.path));
    const bakBuf = Buffer.from(fs.readFileSync(bakPath));

    if (promptTier !== null && promptTier !== undefined) {
      applyPromptTierToBuffer(curBuf, bakBuf, promptTier);
    }
    if (contextMode !== null && contextMode !== undefined) {
      applyContextPatchToBuffer(curBuf, bakBuf, contextMode);
    }

    try {
      fs.writeFileSync(target.path, curBuf);
      console.log("  [SUCCESS] 已成功写入二进制文件！");
    } catch (err) {
      console.error(`  [ERROR] 写入失败（请先关闭正在运行的 Antigravity IDE 或 agy 进程！）: ${err.message}`);
    }
  }

  if (contextMode !== null && contextMode !== undefined) {
    syncSettingsJsonContextWindow(contextMode);
  }
}

// ============================================================================
// 交互式数字键菜单 & CLI 参数入口
// ============================================================================
async function interactiveMenu() {
  inspectAll();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

  while (true) {
    console.log("╭──────────────────────────────────────────────────────────────────────────╮");
    console.log("│       Antigravity 提示词精简 (4档) & 百万上下文解锁 (2档) 交互工具       │");
    console.log("├──────────────────────────────────────────────────────────────────────────┤");
    console.log("│  [提示词精简档位 - 100% 保留 identity 网关校验头与 19 个原生工具]        │");
    console.log("│    [1] 1档 · 仅去广告        (仅清空 slash_commands 与 plugins 推销)     │");
    console.log("│    [2] 2档 · 原版最大化精简  (清空 7 个冗余/brain/KI 槽，保留原版核心)   │");
    console.log("│    [3] 3档 · 全量重构版      (清空 7 槽 + 全面替换为 Amp×Argon 重构版)   │");
    console.log("│    [4] 4档 · 原版+防幻觉增强 (在 2 档基础上注入 Amp/Argon 防幻觉护栏)    │");
    console.log("│    [5] 恢复默认提示词        (从 .bak 还原全部 13 个官方原版提示词槽位)  │");
    console.log("├──────────────────────────────────────────────────────────────────────────┤");
    console.log("│  [上下文窗口解锁档位 - 解除 Cortex GetCheckpointConfig 256K/128K 封顶]   │");
    console.log("│    [6] 解锁 512K 上下文档位  (封顶阈值提升至 512,000 + 同步配置文件)     │");
    console.log("│    [7] 解锁 900K/1M 满血档位 (NOP 跳过封顶指令，释放完整 ~983K 物理窗口) │");
    console.log("│    [8] 恢复默认上下文限制    (还原原版 256K/128K 压缩触发阈值)           │");
    console.log("├──────────────────────────────────────────────────────────────────────────┤");
    console.log("│  [组合快捷操作与状态检查]                                                │");
    console.log("│    [9] 一键满血推荐配置      (应用 [4档提示词] + [7: 解锁 900K/1M])      │");
    console.log("│    [0] 一键全部恢复官方默认  (同时还原提示词与上下文窗口至出厂状态)      │");
    console.log("│    [s] 重新扫描当前状态      [q] 退出程序                                │");
    console.log("╰──────────────────────────────────────────────────────────────────────────╯");

    const choice = (await ask("请输入数字键或选项 (0-9 / s / q): ")).toLowerCase();
    if (choice === "q" || choice === "exit") {
      rl.close();
      break;
    }
    switch (choice) {
      case "1":
        executeOperations({ promptTier: "1", contextMode: null });
        break;
      case "2":
        executeOperations({ promptTier: "2", contextMode: null });
        break;
      case "3":
        executeOperations({ promptTier: "3", contextMode: null });
        break;
      case "4":
        executeOperations({ promptTier: "4", contextMode: null });
        break;
      case "5":
        executeOperations({ promptTier: "restore", contextMode: null });
        break;
      case "6":
        executeOperations({ promptTier: null, contextMode: "512k" });
        break;
      case "7":
        executeOperations({ promptTier: null, contextMode: "900k" });
        break;
      case "8":
        executeOperations({ promptTier: null, contextMode: "restore" });
        break;
      case "9":
        executeOperations({ promptTier: "4", contextMode: "900k" });
        break;
      case "0":
        executeOperations({ promptTier: "restore", contextMode: "restore" });
        break;
      case "s":
        inspectAll();
        break;
      default:
        console.log("  [提示] 无效输入，请输入 0-9、s 或 q。");
    }
  }
}

function parseCliArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    interactiveMenu();
    return;
  }

  let promptTier = null;
  let contextMode = null;
  let inspectOnly = false;
  let fullRestore = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inspect" || a === "-i") {
      inspectOnly = true;
    } else if (a === "--restore" || a === "--reset") {
      fullRestore = true;
    } else if (a === "--prompt" || a === "-p") {
      promptTier = (argv[++i] || "").toLowerCase();
    } else if (a.startsWith("--prompt=")) {
      promptTier = a.split("=")[1].toLowerCase();
    } else if (a === "--context" || a === "-c") {
      contextMode = (argv[++i] || "").toLowerCase();
    } else if (a.startsWith("--context=")) {
      contextMode = a.split("=")[1].toLowerCase();
    } else if (a === "--apply") {
      // Backwards compatibility with earlier command
      promptTier = promptTier || "3";
    } else if (a === "--help" || a === "-h") {
      console.log(`
用法:
  node patch-antigravity.mjs                             # 启动数字键交互菜单
  node patch-antigravity.mjs --inspect                   # 只读扫描当前二进制状态
  node patch-antigravity.mjs --prompt <1|2|3|4|restore>  # 单独切换提示词档位
  node patch-antigravity.mjs --context <512k|900k|restore> # 单独切换上下文窗口档位
  node patch-antigravity.mjs --prompt 4 --context 900k   # 同时设置提示词与上下文档位
  node patch-antigravity.mjs --restore                   # 一键还原提示词与上下文至官方默认
      `.trim());
      return;
    }
  }

  if (inspectOnly) {
    inspectAll();
    return;
  }
  if (fullRestore) {
    executeOperations({ promptTier: "restore", contextMode: "restore" });
    return;
  }
  if (promptTier !== null || contextMode !== null) {
    executeOperations({ promptTier, contextMode });
  } else {
    interactiveMenu();
  }
}

parseCliArgs();

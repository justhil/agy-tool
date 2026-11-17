#!/usr/bin/env node
/**
 * AGY <-> Pi Tool Bridge (MCP Stdio Server)
 *
 * Dynamically discovers locally installed Pi extensions (without hardcoding any
 * machine-specific usernames, paths, or secrets):
 *   1. pi-fast-context (Windsurf Devstral semantic code search)
 *   2. pi-search (search / docs_search / web_fetch / web_map / search_sources)
 *   3. pi-devin-search (devin_search)
 *
 * If a local Pi extension is not present on the user's machine, the bridge
 * skips it cleanly instead of failing.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function resolvePiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function findExtensionRoot(piDir, envVar, candidates) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) {
    return process.env[envVar];
  }
  for (const rel of candidates) {
    const p = path.join(piDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findJiti(piDir) {
  const candidates = [
    path.join(piDir, "npm", "node_modules", "jiti", "lib", "jiti.mjs"),
    path.join(piDir, "npm", "node_modules", "jiti", "dist", "jiti.mjs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return require.resolve("jiti");
  } catch {
    return null;
  }
}

function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const clone = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "_optional" || typeof k === "symbol") continue;
    if (Array.isArray(v)) clone[k] = v.map((x) => (typeof x === "object" ? cleanJsonSchema(x) : x));
    else if (v && typeof v === "object") clone[k] = cleanJsonSchema(v);
    else clone[k] = v;
  }
  return clone;
}

function buildTypeboxShim() {
  return `
const mk = (base, opts) => ({ ...base, ...(opts && typeof opts === "object" ? opts : {}) });
export const keyHint = () => "";
export const StringEnum = (arr, opts) => ({ type: "string", enum: arr, ...(opts || {}) });
export class Text { constructor(t) { this.t = t; } }
export class Container { addChild() {} }
export class Spacer {}
export const Type = {
  Object: (props, opts) => {
    const required = [];
    const cleanedProps = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (v && v._optional) {
        const { _optional, ...rest } = v;
        cleanedProps[k] = rest;
      } else {
        cleanedProps[k] = v;
        required.push(k);
      }
    }
    return mk({ type: "object", properties: cleanedProps, ...(required.length ? { required } : {}) }, opts);
  },
  String: (opts) => mk({ type: "string" }, opts),
  Number: (opts) => mk({ type: "number" }, opts),
  Integer: (opts) => mk({ type: "integer" }, opts),
  Boolean: (opts) => mk({ type: "boolean" }, opts),
  Array: (items, opts) => mk({ type: "array", items }, opts),
  Optional: (schema) => ({ ...(schema || {}), _optional: true }),
  Union: (schemas, opts) => mk({ anyOf: schemas }, opts),
  Literal: (v) => ({ const: v }),
  Record: (_k, v) => ({ type: "object", additionalProperties: v }),
  Any: () => ({}),
  Null: () => ({ type: "null" })
};
`;
}

async function loadBridgedTools() {
  const piDir = resolvePiAgentDir();
  const toolMap = new Map();
  const diagnostics = [];

  // 1. pi-fast-context (pure ESM core.mjs)
  const fcRoot = findExtensionRoot(piDir, "PI_FAST_CONTEXT_DIR", [
    path.join("git", "github.com", "justhil", "pi-fast-context"),
    path.join("npm", "node_modules", "pi-fast-context"),
    path.join("local-packages", "pi-fast-context"),
  ]);
  if (fcRoot && fs.existsSync(path.join(fcRoot, "src", "lib", "core.mjs"))) {
    try {
      const coreMod = await import(pathToFileURL(path.join(fcRoot, "src", "lib", "core.mjs")).href);
      const extractMod = await import(pathToFileURL(path.join(fcRoot, "src", "lib", "extract-key.mjs")).href);
      toolMap.set("fast_context_search", {
        name: "fast_context_search",
        description:
          "Semantic codebase discovery powered by Windsurf Devstral Fast Context. Returns candidate file paths, line ranges, and search keywords for natural-language implementation questions.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Concise natural-language description of the code you are looking for plus optional exact symbols." },
            project_root_path: { type: "string", description: "Absolute or relative project root. Defaults to current working directory." },
          },
          required: ["query"],
        },
        async run(args) {
          const root = path.resolve(args.project_root_path || process.cwd());
          const apiKey = resolveFastContextApiKey(piDir, root, extractMod);
          if (!apiKey) {
            throw new Error("Windsurf Fast Context API key not found (checked FAST_CONTEXT_API_KEY, WINDSURF_API_KEY, ~/.pi/agent/fast-context.json, and Windsurf state.vscdb).");
          }
          const res = await coreMod.search(args.query, root, apiKey, { timeoutMs: 45000 });
          const files = Array.isArray(res?.files) ? res.files : [];
          if (!files.length) return "No matching files found.";
          return files
            .map((f) => {
              const ranges = Array.isArray(f.ranges)
                ? f.ranges.map((r) => `L${r.startLine ?? r.start_line}-${r.endLine ?? r.end_line}`).join(", ")
                : "";
              return `- ${f.path}${ranges ? ` (${ranges})` : ""}`;
            })
            .join("\n");
        },
      });
      diagnostics.push("fast_context_search: loaded");
    } catch (e) {
      diagnostics.push(`fast_context_search: failed (${e.message})`);
    }
  }

  // 2. pi-search & pi-devin-search via jiti + minimal Pi shim
  const jitiPath = findJiti(piDir);
  if (jitiPath) {
    const stubDir = path.join(os.tmpdir(), "agy-pi-bridge");
    fs.mkdirSync(stubDir, { recursive: true });
    const stubFile = path.join(stubDir, "pi-shim.mjs");
    fs.writeFileSync(stubFile, buildTypeboxShim(), "utf8");

    try {
      const jitiFactoryMod = await import(pathToFileURL(jitiPath).href);
      const jitiFactory = jitiFactoryMod.default || jitiFactoryMod;
      const makeMockPi = (bucket) => ({
        registerTool(t) {
          bucket.push(t);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        on() {},
        events: { on() {}, emit() {} },
      });

      const registerPiExtension = async (entryPath, allowList, prefix = "") => {
        if (!entryPath || !fs.existsSync(entryPath)) return;
        const jiti = jitiFactory(entryPath, {
          interopDefault: true,
          alias: {
            "@earendil-works/pi-coding-agent": stubFile,
            "@earendil-works/pi-ai": stubFile,
            "@earendil-works/pi-tui": stubFile,
            typebox: stubFile,
          },
        });
        const mod = await jiti.import(entryPath);
        const fn = typeof mod === "function" ? mod : mod?.default;
        if (typeof fn !== "function") return;
        const bucket = [];
        fn(makeMockPi(bucket));
        for (const t of bucket) {
          if (allowList && !allowList.has(t.name)) continue;
          const outName = prefix ? `${prefix}${t.name}` : t.name;
          toolMap.set(outName, {
            name: outName,
            description: t.description || outName,
            inputSchema: cleanJsonSchema(t.parameters),
            async run(args) {
              const res = await t.execute("mcp-call", args, AbortSignal.timeout(120000), () => {}, { cwd: process.cwd() });
              if (typeof res === "string") return res;
              const blocks = Array.isArray(res?.content) ? res.content : [];
              const textParts = blocks.filter((b) => b?.type === "text").map((b) => b.text);
              return textParts.join("\n\n") || JSON.stringify(res);
            },
          });
        }
      };

      const searchRoot = findExtensionRoot(piDir, "PI_SEARCH_DIR", [
        path.join("git", "github.com", "justhil", "pi-search"),
        path.join("npm", "node_modules", "pi-search"),
        path.join("local-packages", "pi-search"),
      ]);
      if (searchRoot) {
        const allow = new Set(["search", "docs_search", "web_fetch", "search_sources", "web_map"]);
        await registerPiExtension(path.join(searchRoot, "index.ts"), allow, "pi_");
        diagnostics.push("pi-search: loaded");
      }

      const devinRoot = findExtensionRoot(piDir, "PI_DEVIN_SEARCH_DIR", [
        path.join("git", "github.com", "justhil", "pi-devin-search"),
        path.join("npm", "node_modules", "pi-devin-search"),
        path.join("local-packages", "pi-devin-search"),
      ]);
      if (devinRoot) {
        await registerPiExtension(path.join(devinRoot, "src", "index.ts"), new Set(["devin_search"]), "");
        diagnostics.push("pi-devin-search: loaded");
      }
    } catch (e) {
      diagnostics.push(`jiti bridge error: ${e.message}`);
    }
  }

  // Always expose bridge_status so users/agents can inspect detected local Pi tools
  toolMap.set("pi_bridge_status", {
    name: "pi_bridge_status",
    description: "Show which locally installed Pi tools (fast_context_search, pi-search, devin_search) were detected and bridged.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return `PI_AGENT_DIR: ${piDir}\nTools active (${toolMap.size - 1}): ${[...toolMap.keys()].filter((k) => k !== "pi_bridge_status").join(", ") || "(none)"}\nDiagnostics:\n- ${diagnostics.join("\n- ") || "no local extensions found"}`;
    },
  });

  return toolMap;
}

function resolveFastContextApiKey(piDir, projectRoot, extractMod) {
  if (process.env.FAST_CONTEXT_API_KEY) return process.env.FAST_CONTEXT_API_KEY.trim();
  if (process.env.WINDSURF_API_KEY) return process.env.WINDSURF_API_KEY.trim();
  for (const cfgPath of [
    path.join(projectRoot, ".pi", "fast-context.json"),
    path.join(piDir, "fast-context.json"),
  ]) {
    if (fs.existsSync(cfgPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const k = j.apiKey || j.api_key || j.windsurfApiKey;
        if (typeof k === "string" && k.trim()) return k.trim();
      } catch {}
    }
  }
  if (typeof extractMod?.extractKey === "function") {
    try {
      const k = extractMod.extractKey();
      if (typeof k === "string" && k.trim()) return k.trim();
    } catch {}
  }
  return "";
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const toolsPromise = loadBridgedTools();
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
  const { id, method, params = {} } = req;

  try {
    const toolMap = await toolsPromise;
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agy-pi-bridge", version: "1.0.0" },
        },
      });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // ignore
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      const tools = [...toolMap.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (method === "tools/call") {
      const tool = toolMap.get(params.name);
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      const textOut = await tool.run(params.arguments || {});
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(textOut) }] },
      });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
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

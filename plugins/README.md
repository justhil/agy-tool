# Antigravity 合规增强插件集 (`plugins/`)

本目录包含 3 套完全遵循 Antigravity 官方 `plugins`、`mcp_config.json`、`hooks.json` 与 `rules/AGENTS.md` 规范的独立合规扩展插件（**0 修改二进制、0 封号风险**），可单独或全部复制到 `~/.gemini/config/plugins/` 下热加载使用（前置要求：Node.js >= 18）。

- [`agy-codemode`](./agy-codemode/): `node:vm` 并发编排沙箱（`codemode` + `batch_reads`）与 Argon 核心校准规范。
- [`agy-output-guard`](./agy-output-guard/): `PostToolUse` 超大工具输出自动落盘与头尾折叠（`overwriteResult`）。
- [`agy-rehydrate`](./agy-rehydrate/): 适配 Windows/Desktop/CLI/IDE 与 `/fork` 的 512K 压缩无损回水（`PreInvocation`）。

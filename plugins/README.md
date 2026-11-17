# Antigravity 合规增强插件集 (`plugins/`)

本目录包含 4 套完全遵循 Antigravity 官方 `plugins`、`mcp_config.json`、`hooks.json`、`agents/*.md` 与 `rules/AGENTS.md` 规范的独立合规扩展插件（**0 修改二进制、0 封号风险**），可单独或全部复制到 `~/.gemini/config/plugins/` 下热加载使用（前置要求：Node.js >= 18）。

- [`agy-codemode`](./agy-codemode/): `node:vm` 并发编排沙箱（`codemode` + `batch_reads`）与 Argon 核心校准规范。
- [`agy-output-guard`](./agy-output-guard/): `PostToolUse` 超大工具输出自动落盘与头尾折叠（`overwriteResult`）。
- [`agy-rehydrate`](./agy-rehydrate/): 适配 Windows/Desktop/CLI/IDE 与 `/fork` 的 512K 压缩无损回水（`PreInvocation`）。
- [`agy-pi-bridge`](./agy-pi-bridge/): Pi 并行协作角色（`oracle`、`librarian`、`worker`、`frontend-scout`、`frontend-worker`）与本地 Pi 扩展工具（`fast_context_search`、`pi-search`、`devin_search`）动态 MCP 桥接。

# agy-tool v2.0

Antigravity 合规能力增强中心与工具箱 —— **零修改语言服务器二进制（零封号风险）**，通过 Antigravity 官方标准 `plugins/`、`mcp_config.json`、`hooks.json` 与 `rules/AGENTS.md` 接口，提供 **Codemode 并发沙箱、大输出防爆折叠、512K 压缩无损回水**，并保留桌面端输入框状态栏（上下文 + TPS + 真实模型 ID 监控）及 `presets/` 二进制补丁工具。

---

## 一、核心合规增强套件（`plugins/` 随仓托管 · 支持独立开关）

所有合规插件源码完整托管于本仓库 [`plugins/`](./plugins/) 目录，同时内嵌于单文件 [`agy-tool.exe`](../../releases/latest) 中。既可通过 GUI/CLI 一键部署到 `~/.gemini/config/plugins/`，也可直接从仓库复制使用：

| 插件目录 | 核心机制 | 解决痛点与能力清单 |
| :--- | :--- | :--- |
| **`plugins/agy-codemode`** | `mcp_config.json` + `rules/AGENTS.md` | **Codemode 并发沙箱与跨会话按需检索**：Eager 级挂载 `codemode`，在隔离沙箱内单回合并发执行 `tools.read_file / grep / find / ls / outline / git_diff / git_status / run_command / edit_file / write_file`，并内置 `tools.search_sessions` 与 `tools.read_transcript`（跨会话历史与二次压缩早期步骤按需召回）；注入反重力 `<efficient_code_reading>` 覆盖规则、Call-Site 查证、March 2026 `REVERSED` 校准及原生并行 `invoke_subagent` 引导。 |
| **`plugins/agy-output-guard`** | `hooks.json` (`PostToolUse`) | **工具大输出防爆折叠**：拦截 `run_command` / `read_file` / `grep_search` / `mcp_*` 等超过 `36KB` 或 `850行` 的返回结果，完整原文落盘 `~/.gemini/antigravity/scratch/tool-dumps/`，通过官方 `overwriteResult` 替换为「头 70 行 + 尾 60 行 + 落盘绝对路径指针」，避免单次输出冲爆窗口。 |
| **`plugins/agy-rehydrate`** | `hooks.json` (`PreInvocation`) | **512K 压缩无损回水**：纯 Node.js 实现，普通轮次 `<10ms` 返回 `{}` **0 破坏 Prompt Cache**；在 `CHECKPOINT` 或 `/fork` 后注入 `<user-request-timeline>`、`<pre-compaction-dialogue>`、`<active-skills-and-docs>`（重读工作区 `AGENTS.md` 与 `SKILL.md`）与 `<modified-files>`/`<read-files>` 最新磁盘切片（含 `codemode` 读写追踪与 Windows 盘符支持）。 |

---

## 二、使用方法

### 方式一：独立 GUI 工具箱（推荐）
直接从 [Releases](../../releases/latest/download/agy-tool.exe) 下载单文件 `agy-tool.exe` 双击运行：
1. 默认打开 **「合规插件中心 (0 改二进制 · 推荐)」**，可点击 **「一键部署并启用全部 3 个插件」** 或逐个单独开关、热更新，并点击 **「实机冒烟自检」** 验证本地 Node.js 与 MCP/Hook 握手；
2. 右侧可一键注入/免重启热刷新桌面端 **输入框状态栏 (HUD)**（左侧上下文圆环 + 右侧 TPS 速度 + 真实模型 ID 路由监控）；
3. 若需使用旧版提示词槽位替换，将本仓库 [`presets/`](./presets/) 文件夹放在 `agy-tool.exe` 同级目录，切换顶部 **「⚠ 旧版高风险区」** 标签页使用（首次修改会在同级 `backup/` 目录保存 `.bak` 原版备份）。

### 方式二：命令行模式
```powershell
# 查看合规插件、Node 环境、内核与 HUD 状态
.\agy-tool.exe --status

# 一键部署并启用全部 3 个合规插件 + 实机握手自检
.\agy-tool.exe --install-plugins

# 仅执行实机冒烟自检 (验证 MCP tools/list 与 Hook)
.\agy-tool.exe --check-plugins

# 一键卸载全部合规插件并清理 config.json
.\agy-tool.exe --uninstall-plugins

# 桌面端输入框状态栏 (HUD) 控制
.\agy-tool.exe --inject-hud
.\agy-tool.exe --hot-hud
.\agy-tool.exe --restore-hud

# 旧版高风险区：配合 presets/ 文件夹切换提示词与上下文
.\agy-tool.exe --prompt tier4-guardrails
.\agy-tool.exe --context 900k
.\agy-tool.exe --restore
```

### 方式三：手动从仓库安装插件
将本仓库 [`plugins/`](./plugins/) 下的任意目录复制到 `~/.gemini/config/plugins/`（确保机器已安装 Node.js >= 18），Antigravity Desktop / `agy` CLI 下个回合自动热加载生效。

---

## 从源码编译

```bash
cargo test
cargo build --release
```

## 致谢与参考
- 无损回水思路参考：[agy-rehydrate](https://agy-rehydrate.pages.dev/)
- `presets/` 与 `backup/` 外部目录机制：PR #1 by [@grumpyNeko](https://github.com/grumpyNeko)
- 社区：https://linux.do

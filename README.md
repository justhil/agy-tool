# agy-tool v2.0

Antigravity 合规能力增强中心与工具箱 —— **零修改语言服务器二进制（零封号风险）**，通过 Antigravity 官方标准 `plugins/`、`mcp_config.json`、`hooks.json` 与 `agents/*.md` 接口，提供 **Codemode 并发沙箱、大输出防爆折叠、512K 压缩无损回水、Pi 编排角色与检索桥接**，并保留桌面端输入框状态栏（上下文 + TPS + 真实模型 ID 监控）及 `presets/` 二进制补丁工具。

---

## 一、核心合规增强套件（`plugins/` 随仓托管 · 支持独立开关）

所有合规插件源码完整托管于本仓库 [`plugins/`](./plugins/) 目录，同时内嵌于单文件 [`agy-tool.exe`](../../releases/latest) 中。既可通过 GUI/CLI 一键部署到 `~/.gemini/config/plugins/`，也可直接从仓库复制使用：

| 插件目录 | 核心机制 | 解决痛点与能力清单 |
| :--- | :--- | :--- |
| **`plugins/agy-codemode`** | `mcp_config.json` + `rules/AGENTS.md` | **Codemode 并发沙箱与行为校准**：纯 `Node.js (node:vm)` 零三方依赖暴露 `codemode` 与 `batch_reads` 工具，支持 `Promise.allSettled` 单回合并发 `read / readMany / grep / find / tree / stat / diff / sh / store / load` 并在沙箱内提炼过滤（默认 `<=8000 tokens`，超标转存落盘指针）；合入 Argon 消融核心校准规则（禁信调用处盲改、闭卷 `REVERSED`、禁脑补工具输出、自适应完成度、UI 防撞色）。 |
| **`plugins/agy-output-guard`** | `hooks.json` (`PostToolUse`) | **工具大输出防爆折叠**：拦截 `run_command` / `read_file` / `grep_search` / `mcp_*` 等超过 `28KB` 或 `750行` 的返回结果，完整原文落盘 `~/.gemini/antigravity/scratch/tool-dumps/`，通过官方 `overwriteResult` 替换为「头 70 行 + 尾 60 行 + 落盘绝对路径指针」，避免单次输出冲爆窗口。 |
| **`plugins/agy-rehydrate`** | `hooks.json` (`PreInvocation`) | **512K 压缩无损回水**：纯 Node.js 重写增强版（零 Python 依赖），支持 Antigravity Desktop / `agy` CLI / IDE 三端目录及 Windows 盘符路径（`D:/...`）。普通轮次 `<10ms` 返回 `{}` **0 破坏 Prompt Cache**；仅在 `CHECKPOINT` 触发或 `/fork` 后安全分块（`<44KB`）无损恢复：**用户提问时间线 + `/fork` 祖先溯源链 + 近期逐字对话 + 活跃 `SKILL/AGENTS/SPEC` 文档 + 热文件源码（含 `codemode` 读取记录）**。 |
| **`plugins/agy-pi-bridge`** | `agents/*.md` + `mcp_config.json` + `rules/AGENTS.md` | **Pi 并发角色与检索工具桥接**：预置工具名严格对齐 Antigravity 新版内核的 5 个并行异步角色（`oracle` 盲审参谋、`librarian` 外部仓库浅克隆调研、`worker` Git Worktree 隔离实施工、`frontend-scout`、`frontend-worker`）及并发 `invoke_subagent` 派发规则；同时动态探测本机 `~/.pi/agent/`（或环境变量 `PI_AGENT_DIR`），有则无侵入桥接 `fast_context_search`、`pi_search`、`pi_docs_search`、`pi_web_fetch`、`devin_search` 等工具。 |

---

## 二、使用方法

### 方式一：独立 GUI 工具箱（推荐）
直接从 [Releases](../../releases/latest/download/agy-tool.exe) 下载单文件 `agy-tool.exe` 双击运行：
1. 默认打开 **「合规插件中心 (0 改二进制 · 推荐)」**，可点击 **「一键部署并启用全部 4 个插件」** 或逐个单独开关、热更新，并点击 **「实机冒烟自检」** 验证本地 Node.js 与 MCP/Hook 握手；
2. 右侧可一键注入/免重启热刷新桌面端 **输入框状态栏 (HUD)**（左侧上下文圆环 + 右侧 TPS 速度 + 真实模型 ID 路由监控）；
3. 若需使用旧版提示词槽位替换，将本仓库 [`presets/`](./presets/) 文件夹放在 `agy-tool.exe` 同级目录，切换顶部 **「⚠ 旧版高风险区」** 标签页使用（首次修改会在同级 `backup/` 目录保存 `.bak` 原版备份）。

### 方式二：命令行模式
```powershell
# 查看合规插件、Node/Pi 生态、内核与 HUD 状态
.\agy-tool.exe --status

# 一键部署并启用全部 4 个合规插件 + 实机握手自检
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

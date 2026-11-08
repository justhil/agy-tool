# agy-tool

Antigravity 提示词精简、上下文窗口解锁与输入框状态栏（上下文 + TPS 查看器）工具。提供独立轻量 Rust GUI 客户端（`agy-tool.exe`）与命令行模式。

## 功能概览

### 1. 系统提示词修改（5 档可选，支持桌面端/CLI 与 IDE 插件双内核）
保留 `identity.tmpl` 身份校验区与 19 个原生工具，通过 Go 模板注释原位填充（PE 节区偏移零变动），并自动绕过 `v2.29+` 启动阶段的 `genericsystemprompt.applyEdits` 子串强校验：

| 档位 | 桌面端字数变化 | 说明 |
| :--- | :--- | :--- |
| **4档（推荐）** | `22,363 -> 6,705 字`（减 15,658 字） | 清空 `artifacts`、`persistent_context`、`knowledge_items`、`planning_mode_artifacts`、`conversation_transcript`、`plugins`、`slash_commands` 7 个冗余模板；在保留原版 3 个核心模板基础上，增加未读文件禁猜代码、最小改动、调工具前禁冒号废话、禁传 `ArtifactMetadata`、`edit_file` 3~5 行唯一上下文锚点、改后按影响范围验证等规则 |
| **3档** | `22,363 -> 7,591 字`（减 14,772 字） | 清空上述 7 个模板，并将 `guidelines`、`function_call`、`communication_style` 3 个核心模板重写为精简版规则 |
| **2档** | `22,363 -> 9,038 字`（减 13,325 字） | 清空上述 7 个模板，3 个核心模板 100% 保持官方原版 |
| **1档** | `22,363 -> 20,640 字`（减 1,723 字） | 仅清空 `slash_commands.tmpl` 与 `plugins.tmpl` 两个广告推销模板 |
| **0档** | `22,363 字`（原版） | 从 `.bak` 备份完整还原全部 13 个官方模板 |

### 2. 上下文窗口上限解锁（3 档可选）
同时修改内核 `utils.GetCheckpointConfig` 自动压缩阈值、`DefaultSerializer.populateContextWindowMetadata` 前端显示上限，并同步写入 `~/.gemini/config/config.json`：
- **解锁 900K / 1M（推荐）**：跳过 256K（桌面端）/ 128K（IDE）硬编码 `cmovb` 封顶判断，释放 `983,040 token` 物理窗口。
- **解锁 512K**：将压缩阈值与前端上限提升至 `512,000 token`。
- **恢复官方默认**：还原为默认的 `256K / 128K` 限制。

### 3. 输入框状态栏注入（上下文圆环 + 生成速度 TPS + 真实模型监控）
挂载在输入框底部 `Request Review` 按钮左侧（自动清理旧版右上角顶栏插件）：
- **左侧进度圆环**：默认仅显示 `13×13px` 进度圆圈（可在面板或弹出层开启常驻文字），鼠标悬停仅显示具体数值与占用比（如 `19,987 / 983,040 (2.0%)`）。
- **右侧速度胶囊**：无多余图标，直接显示 `tok/s`，鼠标悬停显示综合速度、流式速度与首字耗时（TTFT）。
- **点击展开详情面板**：直读内核 `GetCascadeTrajectoryGeneratorMetadata` 原生分词账本（精确到 `System Prompt` 12+ 子项、`Tools`、`Chat Messages`），并在面板底部实时显示服务端返回的真实 `model id`（如 `model id: gemini-4-argon-d`，若发生后台模型路由/降级自动高亮 `已路由` 标记）。

---

## 使用方法

### 方式一：图形界面（推荐）
直接从 [Releases](../../releases) 下载 `agy-tool.exe` 双击运行：
- 点击顶部 **「一键应用推荐配置 (4档提示词 + 900K上下文 + 注入底部状态栏)」** 即可完成全部配置。
- 支持客户端运行期间免杀进程直接替换内核与 CDP 实时热更新状态栏。

### 方式二：命令行模式
```powershell
# 查看当前内核与状态栏状态
.\agy-tool.exe --status

# 一键应用推荐配置（4档提示词 + 900K上下文 + 底部状态栏）
.\agy-tool.exe --full

# 单独切换提示词档位 (1 | 2 | 3 | 4 | restore)
.\agy-tool.exe --prompt 4

# 单独切换上下文窗口上限 (512k | 900k | restore)
.\agy-tool.exe --context 900k

# 单独注入或免重启刷新底部状态栏
.\agy-tool.exe --inject-hud
.\agy-tool.exe --hot-hud

# 一键全部恢复官方默认
.\agy-tool.exe --restore
```

## 从源码编译

```bash
cargo build --release
```

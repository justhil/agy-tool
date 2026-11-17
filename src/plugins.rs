use crate::patcher::{local_appdata_dir, user_home_dir};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginId {
    Codemode,
    OutputGuard,
    Rehydrate,
    PiBridge,
}

impl PluginId {
    pub const ALL: [PluginId; 4] = [
        PluginId::Codemode,
        PluginId::OutputGuard,
        PluginId::Rehydrate,
        PluginId::PiBridge,
    ];

    pub fn dir_name(self) -> &'static str {
        match self {
            PluginId::Codemode => "agy-codemode",
            PluginId::OutputGuard => "agy-output-guard",
            PluginId::Rehydrate => "agy-rehydrate",
            PluginId::PiBridge => "agy-pi-bridge",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            PluginId::Codemode => "Codemode 并发沙箱与行为校准",
            PluginId::OutputGuard => "工具输出防爆折叠 (Output Guard)",
            PluginId::Rehydrate => "512K 压缩无损回水 (Rehydrate)",
            PluginId::PiBridge => "Pi 并发角色与检索工具桥接",
        }
    }

    pub fn subtitle(self) -> &'static str {
        match self {
            PluginId::Codemode => "node:vm 单回合并发探索/过滤 (codemode + batch_reads) + Argon 防幻觉/自适应规范",
            PluginId::OutputGuard => "PostToolUse 自动拦截 >28KB / >750行输出并转存落盘，防止单次返回冲爆上下文",
            PluginId::Rehydrate => "PreInvocation 零缓存损耗按需回水：时间线 / /fork 溯源 / 对话 / 磁盘热点文件(含 Windows 路径)",
            PluginId::PiBridge => "oracle / librarian / worker / frontend-* 原生异步并发角色 + 动态桥接本地 fast_context / pi-search",
        }
    }
}

struct EmbeddedFile {
    rel_path: &'static str,
    content: &'static str,
    rewrite_node: bool,
}

const CODEMODE_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        rel_path: "plugin.json",
        content: include_str!("../plugins/agy-codemode/plugin.json"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "mcp_config.json",
        content: include_str!("../plugins/agy-codemode/mcp_config.json"),
        rewrite_node: true,
    },
    EmbeddedFile {
        rel_path: "rules/AGENTS.md",
        content: include_str!("../plugins/agy-codemode/rules/AGENTS.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "scripts/codemode-mcp.mjs",
        content: include_str!("../plugins/agy-codemode/scripts/codemode-mcp.mjs"),
        rewrite_node: false,
    },
];

const OUTPUT_GUARD_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        rel_path: "plugin.json",
        content: include_str!("../plugins/agy-output-guard/plugin.json"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "hooks.json",
        content: include_str!("../plugins/agy-output-guard/hooks.json"),
        rewrite_node: true,
    },
    EmbeddedFile {
        rel_path: "scripts/output-guard-hook.mjs",
        content: include_str!("../plugins/agy-output-guard/scripts/output-guard-hook.mjs"),
        rewrite_node: false,
    },
];

const REHYDRATE_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        rel_path: "plugin.json",
        content: include_str!("../plugins/agy-rehydrate/plugin.json"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "hooks.json",
        content: include_str!("../plugins/agy-rehydrate/hooks.json"),
        rewrite_node: true,
    },
    EmbeddedFile {
        rel_path: "scripts/rehydrate-hook.mjs",
        content: include_str!("../plugins/agy-rehydrate/scripts/rehydrate-hook.mjs"),
        rewrite_node: false,
    },
];

const PI_BRIDGE_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        rel_path: "plugin.json",
        content: include_str!("../plugins/agy-pi-bridge/plugin.json"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "mcp_config.json",
        content: include_str!("../plugins/agy-pi-bridge/mcp_config.json"),
        rewrite_node: true,
    },
    EmbeddedFile {
        rel_path: "rules/AGENTS.md",
        content: include_str!("../plugins/agy-pi-bridge/rules/AGENTS.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "agents/oracle.md",
        content: include_str!("../plugins/agy-pi-bridge/agents/oracle.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "agents/librarian.md",
        content: include_str!("../plugins/agy-pi-bridge/agents/librarian.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "agents/worker.md",
        content: include_str!("../plugins/agy-pi-bridge/agents/worker.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "agents/frontend-scout.md",
        content: include_str!("../plugins/agy-pi-bridge/agents/frontend-scout.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "agents/frontend-worker.md",
        content: include_str!("../plugins/agy-pi-bridge/agents/frontend-worker.md"),
        rewrite_node: false,
    },
    EmbeddedFile {
        rel_path: "scripts/pi-bridge-mcp.mjs",
        content: include_str!("../plugins/agy-pi-bridge/scripts/pi-bridge-mcp.mjs"),
        rewrite_node: false,
    },
];

fn embedded_files(id: PluginId) -> &'static [EmbeddedFile] {
    match id {
        PluginId::Codemode => CODEMODE_FILES,
        PluginId::OutputGuard => OUTPUT_GUARD_FILES,
        PluginId::Rehydrate => REHYDRATE_FILES,
        PluginId::PiBridge => PI_BRIDGE_FILES,
    }
}

pub fn gemini_config_dir() -> PathBuf {
    user_home_dir().join(".gemini").join("config")
}

pub fn plugins_root_dir() -> PathBuf {
    gemini_config_dir().join("plugins")
}

pub fn config_json_path() -> PathBuf {
    gemini_config_dir().join("config.json")
}

#[derive(Debug, Clone)]
pub struct NodeDetection {
    pub in_path: bool,
    pub resolved_path: Option<PathBuf>,
    pub version: Option<String>,
}

impl NodeDetection {
    pub fn command_for_config(&self) -> String {
        if self.in_path {
            "node".to_string()
        } else if let Some(p) = &self.resolved_path {
            p.to_string_lossy().replace('\\', "/")
        } else {
            "node".to_string()
        }
    }

    pub fn runnable_exe(&self) -> String {
        if let Some(p) = &self.resolved_path {
            p.to_string_lossy().to_string()
        } else {
            "node".to_string()
        }
    }
}

pub fn detect_node() -> NodeDetection {
    let mut in_path = false;
    let mut resolved = None;

    if let Ok(out) = Command::new("where.exe")
        .arg("node.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    in_path = true;
                    resolved = Some(p);
                    break;
                }
            }
        }
    }

    if resolved.is_none() {
        let local = local_appdata_dir();
        let candidates = [
            local.join("pi-node").join("current").join("node.exe"),
            local.join("Programs").join("nodejs").join("node.exe"),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            user_home_dir().join(".nvm").join("current").join("node.exe"),
        ];
        for c in candidates {
            if c.exists() {
                resolved = Some(c);
                break;
            }
        }
    }

    let version = resolved
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| if in_path { Some("node".to_string()) } else { None })
        .and_then(|cmd| {
            Command::new(cmd)
                .arg("-v")
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        });

    NodeDetection {
        in_path,
        resolved_path: resolved,
        version,
    }
}

#[derive(Debug, Clone)]
pub struct PiEcosystemStatus {
    pub has_pi_dir: bool,
    pub has_fast_context: bool,
    pub has_pi_search: bool,
    pub has_devin_search: bool,
    pub has_jiti: bool,
}

pub fn detect_pi_ecosystem() -> PiEcosystemStatus {
    let pi_dir = user_home_dir().join(".pi").join("agent");
    let has_pi_dir = pi_dir.exists();
    let has_fast_context = [
        pi_dir.join("git/github.com/justhil/pi-fast-context/src/lib/core.mjs"),
        pi_dir.join("npm/node_modules/pi-fast-context/src/lib/core.mjs"),
        pi_dir.join("local-packages/pi-fast-context/src/lib/core.mjs"),
    ]
    .iter()
    .any(|p| p.exists());
    let has_pi_search = [
        pi_dir.join("git/github.com/justhil/pi-search/index.ts"),
        pi_dir.join("npm/node_modules/pi-search/index.ts"),
        pi_dir.join("local-packages/pi-search/index.ts"),
    ]
    .iter()
    .any(|p| p.exists());
    let has_devin_search = [
        pi_dir.join("git/github.com/justhil/pi-devin-search/src/index.ts"),
        pi_dir.join("npm/node_modules/pi-devin-search/src/index.ts"),
        pi_dir.join("local-packages/pi-devin-search/src/index.ts"),
    ]
    .iter()
    .any(|p| p.exists());
    let has_jiti = pi_dir.join("npm/node_modules/jiti/lib/jiti.mjs").exists();

    PiEcosystemStatus {
        has_pi_dir,
        has_fast_context,
        has_pi_search,
        has_devin_search,
        has_jiti,
    }
}

#[derive(Debug, Clone)]
pub struct PluginInspection {
    pub id: PluginId,
    pub dir_name: &'static str,
    pub install_dir: PathBuf,
    pub installed: bool,
    pub files_match: bool,
    pub enabled: bool,
}

fn read_config_json() -> Value {
    let p = config_json_path();
    if let Ok(text) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            return v;
        }
    }
    json!({})
}

fn write_config_json_plugin_state(dir_name: &str, enabled: bool) -> Result<(), String> {
    let p = config_json_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let mut root = read_config_json();
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    if !obj.contains_key("plugins") || !obj["plugins"].is_object() {
        obj.insert("plugins".to_string(), json!({}));
    }
    let plugins_map = obj.get_mut("plugins").unwrap().as_object_mut().unwrap();
    plugins_map.insert(dir_name.to_string(), json!({ "enabled": enabled }));

    let out = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, out).map_err(|e| format!("写入临时配置失败: {}", e))?;
    fs::rename(&tmp, &p).map_err(|e| format!("原子更新 config.json 失败: {}", e))?;
    Ok(())
}

fn remove_config_json_plugin_state(dir_name: &str) -> Result<(), String> {
    let p = config_json_path();
    if !p.exists() {
        return Ok(());
    }
    let mut root = read_config_json();
    if let Some(obj) = root.as_object_mut() {
        if let Some(plugins) = obj.get_mut("plugins").and_then(|v| v.as_object_mut()) {
            plugins.remove(dir_name);
        }
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, out).map_err(|e| format!("写入临时配置失败: {}", e))?;
    fs::rename(&tmp, &p).map_err(|e| format!("原子更新 config.json 失败: {}", e))?;
    Ok(())
}

fn render_plugin_file(content: &str, rel_path: &str, rewrite_node: bool, node: &NodeDetection) -> String {
    if !rewrite_node || node.in_path {
        return content.to_string();
    }
    let cmd = node.command_for_config();
    if cmd == "node" {
        return content.to_string();
    }
    if rel_path == "mcp_config.json" {
        content.replace("\"command\": \"node\"", &format!("\"command\": \"{}\"", cmd))
    } else if rel_path == "hooks.json" {
        content.replace("\"command\": \"node ", &format!("\"command\": \"\\\"{}\\\" ", cmd))
    } else {
        content.to_string()
    }
}

pub fn inspect_all_plugins(node: &NodeDetection) -> Vec<PluginInspection> {
    let root = plugins_root_dir();
    let cfg = read_config_json();
    let plugins_cfg = cfg.get("plugins").and_then(|v| v.as_object());

    PluginId::ALL
        .iter()
        .map(|&id| {
            let dir_name = id.dir_name();
            let install_dir = root.join(dir_name);
            let manifest = install_dir.join("plugin.json");
            let installed = manifest.exists();

            let files_match = if installed {
                embedded_files(id).iter().all(|ef| {
                    let target = install_dir.join(ef.rel_path);
                    match fs::read_to_string(&target) {
                        Ok(cur) => {
                            let expected = render_plugin_file(ef.content, ef.rel_path, ef.rewrite_node, node);
                            cur.replace("\r\n", "\n") == expected.replace("\r\n", "\n")
                        }
                        Err(_) => false,
                    }
                })
            } else {
                false
            };

            let enabled = if !installed {
                false
            } else if let Some(entry) = plugins_cfg.and_then(|m| m.get(dir_name)) {
                entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)
            } else {
                true
            };

            PluginInspection {
                id,
                dir_name,
                install_dir,
                installed,
                files_match,
                enabled,
            }
        })
        .collect()
}

pub fn install_plugin(id: PluginId, node: &NodeDetection) -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    let install_dir = plugins_root_dir().join(id.dir_name());
    fs::create_dir_all(&install_dir).map_err(|e| format!("创建插件目录失败: {}", e))?;

    for ef in embedded_files(id) {
        let target = install_dir.join(ef.rel_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建子目录失败: {}", e))?;
        }
        let body = render_plugin_file(ef.content, ef.rel_path, ef.rewrite_node, node);
        fs::write(&target, body.as_bytes()).map_err(|e| format!("写入 {} 失败: {}", ef.rel_path, e))?;
    }

    write_config_json_plugin_state(id.dir_name(), true)?;
    logs.push(format!("✔ 已安装并启用插件 {} -> {}", id.dir_name(), install_dir.display()));
    Ok(logs)
}

pub fn toggle_plugin_enabled(id: PluginId, enabled: bool, node: &NodeDetection) -> Result<Vec<String>, String> {
    if enabled {
        let install_dir = plugins_root_dir().join(id.dir_name());
        if !install_dir.join("plugin.json").exists() {
            return install_plugin(id, node);
        }
        write_config_json_plugin_state(id.dir_name(), true)?;
        Ok(vec![format!("✔ 已启用插件 {}", id.dir_name())])
    } else {
        write_config_json_plugin_state(id.dir_name(), false)?;
        Ok(vec![format!("✔ 已停用插件 {}", id.dir_name())])
    }
}

pub fn uninstall_plugin(id: PluginId) -> Result<Vec<String>, String> {
    let install_dir = plugins_root_dir().join(id.dir_name());
    if install_dir.exists() {
        fs::remove_dir_all(&install_dir).map_err(|e| format!("删除插件目录失败: {}", e))?;
    }
    remove_config_json_plugin_state(id.dir_name())?;
    Ok(vec![format!("✔ 已彻底卸载插件 {}", id.dir_name())])
}

pub fn install_all_plugins(node: &NodeDetection) -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    for &id in &PluginId::ALL {
        logs.extend(install_plugin(id, node)?);
    }
    Ok(logs)
}

pub fn uninstall_all_plugins() -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    for &id in &PluginId::ALL {
        logs.extend(uninstall_plugin(id)?);
    }
    Ok(logs)
}

fn test_mcp_tools_list(node_exe: &str, script_path: &Path) -> Result<Vec<String>, String> {
    if !script_path.exists() {
        return Err(format!("脚本不存在: {}", script_path.display()));
    }
    let mut child = Command::new(node_exe)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", script_path.display(), e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n"
        );
        let _ = stdin.write_all(payload.as_bytes());
        let _ = stdin.flush();
    }

    let output = child.wait_with_output().map_err(|e| format!("等待 MCP 退出失败: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v.get("id").and_then(|x| x.as_i64()) == Some(2) {
                if let Some(tools) = v.pointer("/result/tools").and_then(|t| t.as_array()) {
                    let names: Vec<String> = tools
                        .iter()
                        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                        .collect();
                    return Ok(names);
                }
            }
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!("未收到 tools/list 响应 (stderr: {})", stderr.trim()))
}

fn test_hook_empty_stdin(node_exe: &str, script_path: &Path) -> Result<String, String> {
    if !script_path.exists() {
        return Err(format!("脚本不存在: {}", script_path.display()));
    }
    let mut child = Command::new(node_exe)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", script_path.display(), e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"{}");
        let _ = stdin.flush();
    }
    let out = child.wait_with_output().map_err(|e| format!("等待 Hook 退出失败: {}", e))?;
    if !out.status.success() {
        return Err(format!("退出码 {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn run_plugin_smoke_checks(node: &NodeDetection) -> Vec<String> {
    let mut logs = Vec::new();
    let exe = node.runnable_exe();
    let root = plugins_root_dir();

    logs.push(format!(
        "▶ Node.js 运行时: {} (PATH={}, 版本={})",
        exe,
        node.in_path,
        node.version.as_deref().unwrap_or("未检测到")
    ));

    if node.version.is_none() {
        logs.push("✖ 未检测到可用的 Node.js (v18+)，请先安装 Node.js。".to_string());
        return logs;
    }

    let cm_script = root.join("agy-codemode/scripts/codemode-mcp.mjs");
    if cm_script.exists() {
        match test_mcp_tools_list(&exe, &cm_script) {
            Ok(tools) => logs.push(format!("✔ agy-codemode MCP 握手正常，暴露工具 ({}): {}", tools.len(), tools.join(", "))),
            Err(e) => logs.push(format!("✖ agy-codemode MCP 检测失败: {}", e)),
        }
    } else {
        logs.push("  - agy-codemode 尚未安装，跳过 MCP 检测".to_string());
    }

    let og_script = root.join("agy-output-guard/scripts/output-guard-hook.mjs");
    if og_script.exists() {
        match test_hook_empty_stdin(&exe, &og_script) {
            Ok(out) => logs.push(format!("✔ agy-output-guard Hook 响应正常: {}", out)),
            Err(e) => logs.push(format!("✖ agy-output-guard Hook 检测失败: {}", e)),
        }
    } else {
        logs.push("  - agy-output-guard 尚未安装，跳过 Hook 检测".to_string());
    }

    let rh_script = root.join("agy-rehydrate/scripts/rehydrate-hook.mjs");
    if rh_script.exists() {
        match test_hook_empty_stdin(&exe, &rh_script) {
            Ok(out) => logs.push(format!("✔ agy-rehydrate Hook 响应正常: {}", out)),
            Err(e) => logs.push(format!("✖ agy-rehydrate Hook 检测失败: {}", e)),
        }
    } else {
        logs.push("  - agy-rehydrate 尚未安装，跳过 Hook 检测".to_string());
    }

    let pb_script = root.join("agy-pi-bridge/scripts/pi-bridge-mcp.mjs");
    if pb_script.exists() {
        match test_mcp_tools_list(&exe, &pb_script) {
            Ok(tools) => logs.push(format!("✔ agy-pi-bridge MCP 握手正常，发现工具 ({}): {}", tools.len(), tools.join(", "))),
            Err(e) => logs.push(format!("✖ agy-pi-bridge MCP 检测失败: {}", e)),
        }
    } else {
        logs.push("  - agy-pi-bridge 尚未安装，跳过 MCP 检测".to_string());
    }

    logs
}

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
}

impl PluginId {
    pub const ALL: [PluginId; 3] = [
        PluginId::Codemode,
        PluginId::OutputGuard,
        PluginId::Rehydrate,
    ];

    pub fn dir_name(self) -> &'static str {
        match self {
            PluginId::Codemode => "agy-codemode",
            PluginId::OutputGuard => "agy-output-guard",
            PluginId::Rehydrate => "agy-rehydrate",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            PluginId::Codemode => "Codemode 并发沙箱与行为校准",
            PluginId::OutputGuard => "工具输出防爆折叠 (Output Guard)",
            PluginId::Rehydrate => "512K 压缩无损回水 (Rehydrate)",
        }
    }

    pub fn subtitle(self) -> &'static str {
        match self {
            PluginId::Codemode => "Eager 挂载 · read_file / grep / outline / git_diff / 跨会话检索 search_sessions + 行为校准",
            PluginId::OutputGuard => "ANSI/重复行降噪 + 超36KB/850行落盘折叠 + 自动抽提中间段 Error/Fail 报错 + 编辑语法自检",
            PluginId::Rehydrate => "PreInvocation 零缓存损耗按需回水：时间线 / /fork 溯源 / 对话 / 规范文档 / 读写文件",
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

fn embedded_files(id: PluginId) -> &'static [EmbeddedFile] {
    match id {
        PluginId::Codemode => CODEMODE_FILES,
        PluginId::OutputGuard => OUTPUT_GUARD_FILES,
        PluginId::Rehydrate => REHYDRATE_FILES,
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

const CODEMODE_PERMISSION_KEY: &str = "mcp(agy-codemode_agy_codemode/codemode)";

#[derive(Debug, Clone, Default)]
pub struct PermissionOptimization {
    pub codemode_preauthorized: bool,
    pub non_workspace_and_gitignore_allowed: bool,
}

fn ensure_allow_entry(user_settings: &mut serde_json::Map<String, Value>, entry: &str) {
    if !user_settings.contains_key("globalPermissionGrants")
        || !user_settings["globalPermissionGrants"].is_object()
    {
        user_settings.insert("globalPermissionGrants".to_string(), json!({ "allow": [] }));
    }
    let grants = user_settings
        .get_mut("globalPermissionGrants")
        .unwrap()
        .as_object_mut()
        .unwrap();
    if !grants.contains_key("allow") || !grants["allow"].is_array() {
        grants.insert("allow".to_string(), json!([]));
    }
    let allow_arr = grants.get_mut("allow").unwrap().as_array_mut().unwrap();
    if !allow_arr.iter().any(|v| v.as_str() == Some(entry)) {
        allow_arr.push(Value::String(entry.to_string()));
    }
}

pub fn inspect_permission_optimization() -> PermissionOptimization {
    let root = read_config_json();
    let Some(us) = root.get("userSettings").and_then(|v| v.as_object()) else {
        return PermissionOptimization::default();
    };
    let codemode_preauthorized = root
        .pointer("/userSettings/globalPermissionGrants/allow")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|x| x.as_str() == Some(CODEMODE_PERMISSION_KEY)))
        .unwrap_or(false);

    let non_ws = us
        .get("nonWorkspaceFileAccessPolicy")
        .and_then(|v| v.as_str())
        == Some("AGENT_SETTING_POLICY_ALLOW")
        && us
            .get("allowAgentAccessGitignoreFiles")
            .and_then(|v| v.as_bool())
            == Some(true);

    PermissionOptimization {
        codemode_preauthorized,
        non_workspace_and_gitignore_allowed: non_ws,
    }
}

pub fn set_permission_optimization(enable_non_ws_gitignore: bool) -> Result<String, String> {
    let p = config_json_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let mut root = read_config_json();
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    if !obj.contains_key("userSettings") || !obj["userSettings"].is_object() {
        obj.insert("userSettings".to_string(), json!({}));
    }
    let us = obj.get_mut("userSettings").unwrap().as_object_mut().unwrap();
    ensure_allow_entry(us, CODEMODE_PERMISSION_KEY);

    if enable_non_ws_gitignore {
        us.insert(
            "nonWorkspaceFileAccessPolicy".to_string(),
            json!("AGENT_SETTING_POLICY_ALLOW"),
        );
        us.insert("allowAgentAccessNonWorkspaceFiles".to_string(), json!(true));
        us.insert("allowAgentAccessGitignoreFiles".to_string(), json!(true));
        us.insert("allowCascadeAccessGitignoreFiles".to_string(), json!(true));
    } else {
        us.remove("nonWorkspaceFileAccessPolicy");
        us.remove("allowAgentAccessNonWorkspaceFiles");
        us.remove("allowAgentAccessGitignoreFiles");
        us.remove("allowCascadeAccessGitignoreFiles");
    }

    let out = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, out).map_err(|e| format!("写入临时配置失败: {}", e))?;
    fs::rename(&tmp, &p).map_err(|e| format!("原子更新 config.json 失败: {}", e))?;

    Ok(if enable_non_ws_gitignore {
        "✔ 已开启免弹窗预授权 (codemode 白名单 + 允许跨目录与 .gitignore 文件访问)".to_string()
    } else {
        "✔ 已关闭跨目录与 .gitignore 免弹窗访问 (保留 codemode 白名单)".to_string()
    })
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

    // Automatically pre-authorize codemode in globalPermissionGrants.allow when enabled
    if dir_name == "agy-codemode" && enabled {
        if !obj.contains_key("userSettings") || !obj["userSettings"].is_object() {
            obj.insert("userSettings".to_string(), json!({}));
        }
        let us = obj.get_mut("userSettings").unwrap().as_object_mut().unwrap();
        ensure_allow_entry(us, CODEMODE_PERMISSION_KEY);
    }

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
    if let Ok(msg) = set_permission_optimization(true) {
        logs.push(msg);
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

    logs
}

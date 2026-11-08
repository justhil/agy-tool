use crate::asar::{repack_asar_in_memory, AsarArchive};
use crate::patcher::{local_appdata_dir, ContextMode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tungstenite::Message;

pub const AGY_HUD_JS: &str = include_str!("assets/agy-hud.js");
pub const AGY_HUD_MAIN_JS: &str = include_str!("assets/agy-hud-main.js");

const LEGACY_FILES: &[&str] = &[
    "dist/meter-main.js",
    "dist/meter-core.js",
    "dist/meter-renderer.js",
    "dist/meter-collector.js",
    "dist/attachment_scan.py",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HudInstallState {
    NotFound,
    Stock,
    LegacyTopBarInstalled,
    AgyComposerHudInstalled,
}

impl HudInstallState {
    pub fn label(&self) -> &'static str {
        match self {
            HudInstallState::NotFound => "未找到 app.asar",
            HudInstallState::Stock => "官方原版 (未注入 HUD)",
            HudInstallState::LegacyTopBarInstalled => "检测到旧版顶栏插件 (待清理迁移)",
            HudInstallState::AgyComposerHudInstalled => "已注入底部 Composer HUD (Request Review 左侧)",
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct HudInspection {
    pub asar_path: PathBuf,
    pub bak_path: PathBuf,
    pub asar_exists: bool,
    pub bak_exists: bool,
    pub app_version: String,
    pub state: HudInstallState,
    pub cdp_port: Option<u16>,
    pub error: Option<String>,
}

pub fn antigravity_asar_path() -> PathBuf {
    local_appdata_dir()
        .join("Programs")
        .join("antigravity")
        .join("resources")
        .join("app.asar")
}

pub fn roam_appdata_dir() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p);
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join("AppData").join("Roaming");
    }
    PathBuf::from("C:/Users/Administrator/AppData/Roaming")
}

pub fn detect_active_cdp_port() -> Option<u16> {
    let port_file = roam_appdata_dir()
        .join("Antigravity")
        .join("DevToolsActivePort");
    let content = fs::read_to_string(port_file).ok()?;
    let first_line = content.lines().next()?.trim();
    let port: u16 = first_line.parse().ok()?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        Some(port)
    } else {
        None
    }
}

pub fn inspect_hud_state() -> HudInspection {
    let asar_path = antigravity_asar_path();
    let bak_path = PathBuf::from(format!("{}.bak", asar_path.display()));
    let asar_exists = asar_path.exists();
    let cdp_port = detect_active_cdp_port();

    if !asar_exists {
        return HudInspection {
            asar_path,
            bak_path,
            asar_exists: false,
            bak_exists: false,
            app_version: String::new(),
            state: HudInstallState::NotFound,
            cdp_port,
            error: None,
        };
    }

    match fs::read(&asar_path) {
        Ok(raw) => match AsarArchive::parse(&raw) {
            Ok(arch) => {
                let app_version = arch
                    .extract_file("package.json")
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(String::from))
                    .unwrap_or_else(|| "unknown".to_string());

                let has_agy_hud = arch.lookup_node("dist/agy-hud.js").is_some();
                let has_legacy = arch.lookup_node("dist/meter-renderer.js").is_some();

                let state = if has_agy_hud {
                    HudInstallState::AgyComposerHudInstalled
                } else if has_legacy {
                    HudInstallState::LegacyTopBarInstalled
                } else {
                    HudInstallState::Stock
                };

                let legacy_bak = find_legacy_context_meter_backup(&app_version);
                let bak_exists = bak_path.exists() || legacy_bak.is_some();

                HudInspection {
                    asar_path,
                    bak_path,
                    asar_exists: true,
                    bak_exists,
                    app_version,
                    state,
                    cdp_port,
                    error: None,
                }
            }
            Err(e) => {
                let bak_exists = bak_path.exists();
                HudInspection {
                    asar_path,
                    bak_path,
                    asar_exists: true,
                    bak_exists,
                    app_version: String::new(),
                    state: HudInstallState::Stock,
                    cdp_port,
                    error: Some(e),
                }
            }
        },
        Err(e) => {
            let bak_exists = bak_path.exists();
            HudInspection {
                asar_path,
                bak_path,
                asar_exists: true,
                bak_exists,
                app_version: String::new(),
                state: HudInstallState::Stock,
                cdp_port,
                error: Some(format!("读取 app.asar 失败: {}", e)),
            }
        }
    }
}

fn find_legacy_context_meter_backup(version: &str) -> Option<PathBuf> {
    let dir = local_appdata_dir()
        .join("AntigravityContextMeter")
        .join("backups");
    let candidate = dir.join(format!("app-{}-base.asar", version));
    if candidate.exists() {
        return Some(candidate);
    }
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("app-") && n.ends_with("-base.asar"))
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }
    None
}

/// 剥离 dist/utils.js 中旧版 antigravity-context-viewer 或已有的 agy-hud 钩子，还原出纯净源码
fn sanitize_utils_js(raw_utils: &str) -> String {
    raw_utils
        .replace("try { require(\"./agy-hud-main\"); } catch {}\n", "")
        .replace("try { require(\"./agy-hud-main\"); } catch {}\r\n", "")
        .replace(
            "try { require(\"./meter-main\").ensureProxyEnvironment(process.env); } catch {}\n",
            "",
        )
        .replace(
            "\r\ntry { require(\"./meter-main\").ensureProxyEnvironment(process.env); } catch {}",
            "",
        )
        .replace(
            "\n    try { require(\"./meter-main\").ensureProxyEnvironment(env); } catch {}",
            "",
        )
        .replace(
            "\r\n    try { require(\"./meter-main\").ensureProxyEnvironment(env); } catch {}",
            "",
        )
        .replace("    require(\"./meter-main\").installContextMeter(win);\n", "")
        .replace("    require(\"./meter-main\").installContextMeter(win);\r\n", "")
        .replace("    require(\"./agy-hud-main\").installAgyHud(win);\n", "")
        .replace("    require(\"./agy-hud-main\").installAgyHud(win);\r\n", "")
}

/// 剥离 dist/preload.js 中旧版 antigravity-context-viewer 注入的 contextMeterAPI
fn sanitize_preload_js(raw_preload: &str) -> String {
    let marker = "// Context Meter v2: narrow read-only conversation scan API";
    if let Some(idx) = raw_preload.find(marker) {
        let prefix = raw_preload[..idx].trim_end();
        format!("{}\n", prefix)
    } else {
        raw_preload.to_string()
    }
}

/// 确保拥有一份纯净官方 app.asar.bak 备份，返回备份二进制内容
fn ensure_clean_asar_backup(asar_path: &Path, bak_path: &Path) -> Result<Vec<u8>, String> {
    if bak_path.exists() {
        let bak_raw = fs::read(bak_path).map_err(|e| format!("读取备份失败: {}", e))?;
        let bak_arch = AsarArchive::parse(&bak_raw)?;
        // 若已存在的 .bak 意外含有旧版插件，顺手净化它
        if bak_arch.lookup_node("dist/meter-renderer.js").is_some()
            || bak_arch.lookup_node("dist/agy-hud.js").is_some()
        {
            let cleaned = build_clean_stock_asar(&bak_raw)?;
            let _ = fs::write(bak_path, &cleaned);
            return Ok(cleaned);
        }
        return Ok(bak_raw);
    }

    let cur_raw = fs::read(asar_path).map_err(|e| format!("读取当前 app.asar 失败: {}", e))?;
    let cur_arch = AsarArchive::parse(&cur_raw)?;
    let version = cur_arch
        .extract_file("package.json")
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| "unknown".to_string());

    // 优先采用旧版 AntigravityContextMeter 留下的官方原版 base 备份
    if let Some(legacy_base) = find_legacy_context_meter_backup(&version) {
        if let Ok(base_raw) = fs::read(&legacy_base) {
            let _ = fs::write(bak_path, &base_raw);
            return Ok(base_raw);
        }
    }

    // 否则从当前 app.asar 逆向剥离任何钩子得到 100% 纯净原版并存为 .bak
    let cleaned = build_clean_stock_asar(&cur_raw)?;
    let _ = fs::write(bak_path, &cleaned);
    Ok(cleaned)
}

fn build_clean_stock_asar(source_raw: &[u8]) -> Result<Vec<u8>, String> {
    let arch = AsarArchive::parse(source_raw)?;
    let utils_raw = String::from_utf8(arch.extract_file("dist/utils.js")?)
        .map_err(|e| format!("dist/utils.js UTF-8 错误: {}", e))?;
    let preload_raw = String::from_utf8(arch.extract_file("dist/preload.js")?)
        .map_err(|e| format!("dist/preload.js UTF-8 错误: {}", e))?;

    let mut overrides = BTreeMap::new();
    overrides.insert(
        "dist/utils.js".to_string(),
        sanitize_utils_js(&utils_raw).into_bytes(),
    );
    overrides.insert(
        "dist/preload.js".to_string(),
        sanitize_preload_js(&preload_raw).into_bytes(),
    );

    let mut removals: BTreeSet<String> = LEGACY_FILES.iter().map(|s| s.to_string()).collect();
    removals.insert("dist/agy-hud-main.js".to_string());
    removals.insert("dist/agy-hud.js".to_string());

    repack_asar_in_memory(source_raw, &overrides, &removals)
}

/// 将新 HUD 写入 app.asar（同时清理旧版顶栏插件）并通过 CDP 热注入当前正在运行的窗口
pub fn install_composer_hud() -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    let asar_path = antigravity_asar_path();
    if !asar_path.exists() {
        return Err(format!("未找到目标文件: {}", asar_path.display()));
    }
    let bak_path = PathBuf::from(format!("{}.bak", asar_path.display()));
    let base_raw = ensure_clean_asar_backup(&asar_path, &bak_path)?;
    logs.push(format!("✔ 已确认纯净基准备份: {}", bak_path.display()));

    let base_arch = AsarArchive::parse(&base_raw)?;
    let clean_utils = sanitize_utils_js(
        &String::from_utf8(base_arch.extract_file("dist/utils.js")?)
            .map_err(|e| e.to_string())?,
    );
    let clean_preload = sanitize_preload_js(
        &String::from_utf8(base_arch.extract_file("dist/preload.js")?)
            .map_err(|e| e.to_string())?,
    );

    let marker = "    void win.loadURL(url);";
    if !clean_utils.contains(marker) {
        return Err("dist/utils.js 中未找到 win.loadURL(url) 锚点".to_string());
    }
    let hook_line = "    require(\"./agy-hud-main\").installAgyHud(win);\n    void win.loadURL(url);";
    let patched_utils = format!(
        "try {{ require(\"./agy-hud-main\"); }} catch {{}}\n{}",
        clean_utils.replacen(marker, hook_line, 1)
    );

    let mut overrides = BTreeMap::new();
    overrides.insert("dist/utils.js".to_string(), patched_utils.into_bytes());
    overrides.insert("dist/preload.js".to_string(), clean_preload.into_bytes());
    overrides.insert(
        "dist/agy-hud-main.js".to_string(),
        AGY_HUD_MAIN_JS.as_bytes().to_vec(),
    );
    overrides.insert(
        "dist/agy-hud.js".to_string(),
        AGY_HUD_JS.as_bytes().to_vec(),
    );

    let removals: BTreeSet<String> = LEGACY_FILES.iter().map(|s| s.to_string()).collect();
    let new_asar = repack_asar_in_memory(&base_raw, &overrides, &removals)?;

    match write_asar_with_rename_fallback(&asar_path, &new_asar) {
        Ok(_) => {
            logs.push(format!(
                "✔ 已成功写入持久化包: {} (已剥离旧版顶栏插件并注入底部 HUD)",
                asar_path.display()
            ));
        }
        Err(e) => {
            logs.push(format!(
                "⚠ app.asar 当前被运行中的 Antigravity 进程锁定 ({})，跳过磁盘覆写，转为执行 CDP 实时热注入（关闭客户端后再次点击即可持久化写入磁盘）",
                e
            ));
        }
    }

    match hot_inject_via_cdp() {
        Ok(n) if n > 0 => {
            logs.push(format!(
                "⚡ 已通过 CDP 实时热替换 {} 个活动窗口：已清除右上角旧版插件并挂载底部 Request Review 左侧 HUD！",
                n
            ));
        }
        Ok(_) => {
            logs.push("ℹ 当前未检测到活动聊天页面，下次启动 Antigravity 时自动生效".to_string());
        }
        Err(e) => {
            logs.push(format!("ℹ CDP 实时热注入未连接 ({})，重启客户端后生效", e));
        }
    }

    Ok(logs)
}

/// 还原 app.asar 至 100% 官方纯净状态，并通过 CDP 立即卸载页面上的 HUD
pub fn restore_stock_asar() -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    let asar_path = antigravity_asar_path();
    if !asar_path.exists() {
        return Err(format!("未找到目标文件: {}", asar_path.display()));
    }
    let bak_path = PathBuf::from(format!("{}.bak", asar_path.display()));
    let clean_raw = ensure_clean_asar_backup(&asar_path, &bak_path)?;

    match write_asar_with_rename_fallback(&asar_path, &clean_raw) {
        Ok(_) => logs.push(format!("✔ 已还原官方纯净 app.asar: {}", asar_path.display())),
        Err(e) => logs.push(format!(
            "⚠ app.asar 被进程锁定暂时无法覆写磁盘 ({})，请关闭客户端后重试磁盘还原",
            e
        )),
    }

    if let Ok(n) = hot_remove_via_cdp() {
        if n > 0 {
            logs.push(format!("⚡ 已通过 CDP 从 {} 个运行中窗口实时卸载全部 HUD 组件", n));
        }
    }
    Ok(logs)
}

fn write_asar_with_rename_fallback(target: &Path, data: &[u8]) -> Result<(), String> {
    if fs::write(target, data).is_ok() {
        return Ok(());
    }
    // Windows 下若文件正被 Electron 以 FILE_SHARE_DELETE 打开，尝试先 rename 为临时名再写入新文件
    let stale_tmp = PathBuf::from(format!("{}.stale_running", target.display()));
    let _ = fs::remove_file(&stale_tmp);
    if fs::rename(target, &stale_tmp).is_ok() {
        match fs::write(target, data) {
            Ok(_) => {
                let _ = fs::remove_file(&stale_tmp);
                return Ok(());
            }
            Err(e) => {
                let _ = fs::rename(&stale_tmp, target);
                return Err(e.to_string());
            }
        }
    }
    Err("EBUSY / 文件被进程独占锁定".to_string())
}

// ============================================================================
// Chrome DevTools Protocol (CDP) 实时热注入与卸载
// ============================================================================

fn fetch_cdp_targets(port: u16) -> Result<Vec<Value>, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1200))
        .map_err(|e| format!("连接 CDP 端口 {} 失败: {}", port, e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1000)));

    let req = format!(
        "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        port
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送 CDP 请求失败: {}", e))?;

    let mut resp = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                resp.extend_from_slice(&buf[..n]);
                if let Some(pos) = resp.windows(4).position(|w| w == b"\r\n\r\n") {
                    let body = &resp[pos + 4..];
                    if let (Some(s), Some(e)) = (
                        body.iter().position(|&b| b == b'['),
                        body.iter().rposition(|&b| b == b']'),
                    ) {
                        if let Ok(parsed) = serde_json::from_slice::<Vec<Value>>(&body[s..=e]) {
                            return Ok(parsed);
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }

    let text = String::from_utf8_lossy(&resp);
    let body = text
        .split_once("\r\n\r\n")
        .map(|x| x.1)
        .unwrap_or(&text)
        .trim();

    let json_start = body.find('[').ok_or("CDP /json/list 未返回 JSON 数组")?;
    let json_end = body.rfind(']').ok_or("CDP /json/list JSON 不完整")?;
    serde_json::from_str(&body[json_start..=json_end])
        .map_err(|e| format!("解析 CDP JSON 失败: {}", e))
}

fn eval_js_on_ws(ws_url: &str, expression: &str) -> Result<Value, String> {
    let (mut socket, _resp) =
        tungstenite::connect(ws_url).map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    let payload = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": false
        }
    });
    socket
        .send(Message::Text(payload.to_string()))
        .map_err(|e| format!("WebSocket 发送失败: {}", e))?;

    for _ in 0..16 {
        let msg = socket
            .read()
            .map_err(|e| format!("WebSocket 读取失败: {}", e))?;
        if let Message::Text(txt) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
                    let _ = socket.close(None);
                    return Ok(v);
                }
            }
        }
    }
    let _ = socket.close(None);
    Err("等待 Runtime.evaluate 响应超时".to_string())
}

pub fn detect_configured_ctx_cap() -> u32 {
    let home = crate::patcher::user_home_dir();
    let cfg_path = home.join(".gemini").join("config").join("config.json");
    if let Ok(s) = fs::read_to_string(cfg_path) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(cw) = v.get("contextWindow").and_then(|x| x.as_str()) {
                return match cw.to_ascii_uppercase().as_str() {
                    "900K" | "1M" => 983040,
                    "512K" => 512000,
                    _ => 0,
                };
            }
        }
    }
    0
}

pub fn set_hud_context_cap_via_cdp(mode: ContextMode) -> Result<usize, String> {
    let cap: u32 = match mode {
        ContextMode::Stock => 0,
        ContextMode::Unlock512K => 512000,
        ContextMode::Unlock900K => 983040,
    };
    let port = detect_active_cdp_port().ok_or("未检测到运行中的 DevToolsActivePort")?;
    let targets = fetch_cdp_targets(port)?;
    let mut updated = 0usize;
    let js = format!(
        "(() => {{ try {{ if ({cap} > 0) localStorage.setItem('agy-hud-ctx-cap', '{cap}'); else localStorage.removeItem('agy-hud-ctx-cap'); globalThis.__AGY_HUD__?.setContextCap?.({cap}); return true; }} catch {{ return false; }} }})()"
    );
    for t in targets {
        let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let Some(ws_url) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else {
            continue;
        };
        if is_page && url.starts_with("https://127.0.0.1:") {
            if eval_js_on_ws(ws_url, &js).is_ok() {
                updated += 1;
            }
        }
    }
    Ok(updated)
}

pub fn find_latest_cascade_id_on_disk() -> String {
    let dir = crate::patcher::user_home_dir()
        .join(".gemini")
        .join("antigravity")
        .join("conversations");
    let Ok(rd) = fs::read_dir(dir) else {
        return String::new();
    };
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in rd.flatten() {
        let p = entry.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".db") {
            continue;
        }
        let id = name.trim_end_matches(".db").to_string();
        if let Ok(meta) = entry.metadata() {
            if let Ok(mtime) = meta.modified() {
                if best.as_ref().map(|b| mtime > b.0).unwrap_or(true) {
                    best = Some((mtime, id));
                }
            }
        }
    }
    best.map(|b| b.1).unwrap_or_default()
}

pub fn hot_inject_via_cdp() -> Result<usize, String> {
    let port = detect_active_cdp_port().ok_or("未检测到运行中的 DevToolsActivePort")?;
    let targets = fetch_cdp_targets(port)?;
    let cap = detect_configured_ctx_cap();
    let latest_id = find_latest_cascade_id_on_disk();
    let payload_js = format!(
        "(() => {{ try {{ if ({cap} > 0) localStorage.setItem('agy-hud-ctx-cap', '{cap}'); else localStorage.removeItem('agy-hud-ctx-cap'); window.__AGY_LATEST_CASCADE_ID__ = {:?}; }} catch {{}} }})();\n{}",
        latest_id,
        AGY_HUD_JS
    );
    let mut injected = 0usize;

    for t in targets {
        let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let Some(ws_url) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else {
            continue;
        };
        if is_page && url.starts_with("https://127.0.0.1:") {
            if eval_js_on_ws(ws_url, &payload_js).is_ok() {
                injected += 1;
            }
        }
    }
    Ok(injected)
}

pub fn set_hud_ctx_text_via_cdp(show: bool) -> Result<usize, String> {
    let port = detect_active_cdp_port().ok_or("未检测到运行中的 DevToolsActivePort")?;
    let targets = fetch_cdp_targets(port)?;
    let mut updated = 0usize;
    let js = format!(
        "(() => {{ try {{ localStorage.setItem('agy-hud-show-ctx-text', '{}'); globalThis.__AGY_HUD__?.setShowContextText?.({}); return true; }} catch {{ return false; }} }})()",
        if show { "1" } else { "0" },
        if show { "true" } else { "false" }
    );
    for t in targets {
        let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let Some(ws_url) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else {
            continue;
        };
        if is_page && url.starts_with("https://127.0.0.1:") {
            if eval_js_on_ws(ws_url, &js).is_ok() {
                updated += 1;
            }
        }
    }
    Ok(updated)
}

pub fn hot_remove_via_cdp() -> Result<usize, String> {
    let port = detect_active_cdp_port().ok_or("未检测到运行中的 DevToolsActivePort")?;
    let targets = fetch_cdp_targets(port)?;
    let mut removed = 0usize;
    let cleanup_js = r#"(() => {
        try { globalThis.__AGY_HUD__?.dispose?.(); } catch {}
        try { globalThis.__AGContextMeter?.dispose?.(); } catch {}
        try { document.getElementById('agy-composer-hud')?.remove?.(); } catch {}
        try { document.getElementById('ag-context-meter')?.remove?.(); } catch {}
        try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch {}
        try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch {}
        return true;
    })()"#;

    for t in targets {
        let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
        let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let Some(ws_url) = t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else {
            continue;
        };
        if is_page && url.starts_with("https://127.0.0.1:") {
            if eval_js_on_ws(ws_url, cleanup_js).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

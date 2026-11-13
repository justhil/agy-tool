use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Default)]
pub struct PromptPatch {
    pub name: String,
    /// 槽位名 (如 "system_prompts/guidelines.tmpl") -> 目标全文 ("" 表示清空该模板)
    pub slots: BTreeMap<String, String>,
}

impl PromptPatch {
    pub fn stock() -> Self {
        Self::default()
    }
}

pub fn normalize_slot_key(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    while s.starts_with('/') {
        s.remove(0);
    }
    let full_prefix = "google3/third_party/jetski/prompt/template_provider/templates/";
    if let Some(rest) = s.strip_prefix(full_prefix) {
        s = rest.to_string();
    }
    if !s.starts_with("system_prompts/") {
        s = format!("system_prompts/{}", s);
    }
    if !s.ends_with(".tmpl") {
        s.push_str(".tmpl");
    }
    s
}

pub fn display_slot_name(short_name: &str) -> &str {
    short_name
        .strip_prefix("system_prompts/")
        .unwrap_or(short_name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContextMode {
    Stock,
    Unlock512K,
    Unlock900K,
}

impl ContextMode {
    pub fn label(&self) -> &'static str {
        match self {
            ContextMode::Stock => "官方默认 (256K / 128K)",
            ContextMode::Unlock512K => "已解锁 512K 上下文",
            ContextMode::Unlock900K => "已解锁 900K / 1M 上下文",
        }
    }

    pub fn from_cli_str(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "restore" | "stock" | "reset" | "default" => Some(ContextMode::Stock),
            "512k" | "512" => Some(ContextMode::Unlock512K),
            "900k" | "1m" | "900" | "max" => Some(ContextMode::Unlock900K),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContextSignature {
    pub id: &'static str,
    pub desc: &'static str,
    pub stock_hex: &'static str,
    pub patch_512k_hex: &'static str,
    pub patch_900k_hex: &'static str,
}

pub const CONTEXT_SIGNATURES: &[ContextSignature] = &[
    ContextSignature {
        id: "cli_main_256k_cap",
        desc: "CLI/Desktop GetCheckpointConfig 主路径 256K (0x3e800) cmovb 封顶",
        stock_hex: "8b54244c81fa00e80300be00e803000f42f289742450",
        patch_512k_hex: "8b54244c81fa00d00700be00d007000f42f289742450",
        patch_900k_hex: "8b54244c81fa00e8030089d690909090909089742450",
    },
    ContextSignature {
        id: "cli_fallback_256k_cap",
        desc: "CLI/Desktop GetCheckpointConfig 兜底 256K (0x3e800) 赋值",
        stock_hex: "837a14007f07c7400c00e80300",
        patch_512k_hex: "837a14007f07c7400c00d00700",
        patch_900k_hex: "837a14007f07c7400ca0bb0d00",
    },
    ContextSignature {
        id: "cli_serializer_max_ctx",
        desc: "CLI/Desktop populateContextWindowMetadata 前端上限显示值",
        stock_hex: "4889442470488b8c24a80100008908b830000000",
        patch_512k_hex: "4889442470c70000d0070090909090b830000000",
        patch_900k_hex: "4889442470c70000000f0090909090b830000000",
    },
    ContextSignature {
        id: "ide_main_128k_cap",
        desc: "IDE GetCheckpointConfig 主路径 128K (0x1f400) cmovb 封顶",
        stock_hex: "8b4c245429d181f900f40100ba00f401000f42d18954244c",
        patch_512k_hex: "8b4c245429d181f900d00700ba00d007000f42d18954244c",
        patch_900k_hex: "8b4c245429d181f900f4010089ca9090909090908954244c",
    },
];

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TemplateSlot {
    pub short_name: String,
    pub full_name: String,
    pub entry_offset: usize,
    pub data_offset: usize,
    pub data_length: usize,
    pub active_bytes: usize,
    pub is_stripped: bool,
    pub is_modified: bool,
    pub preview: String,
    pub content: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ContextGateHit {
    pub id: &'static str,
    pub desc: &'static str,
    pub mode: ContextMode,
    pub offset: usize,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct BinaryInspection {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub exists: bool,
    pub bak_exists: bool,
    pub file_size_mb: f64,
    pub modified_slot_count: usize,
    pub stripped_slot_count: usize,
    pub total_slot_capacity: usize,
    pub active_slot_bytes: usize,
    pub slots: Vec<TemplateSlot>,
    pub context_gates: Vec<ContextGateHit>,
    pub error: Option<String>,
}

impl BinaryInspection {
    pub fn effective_context_mode(&self) -> ContextMode {
        if self
            .context_gates
            .iter()
            .any(|g| g.mode == ContextMode::Unlock900K)
        {
            ContextMode::Unlock900K
        } else if self
            .context_gates
            .iter()
            .any(|g| g.mode == ContextMode::Unlock512K)
        {
            ContextMode::Unlock512K
        } else {
            ContextMode::Stock
        }
    }

    pub fn is_prompt_stock(&self) -> bool {
        self.modified_slot_count == 0
    }

    pub fn prompt_status_label(&self, matched_preset_name: Option<&str>) -> String {
        if self.modified_slot_count == 0 {
            "官方原版 (未修改)".to_string()
        } else if let Some(name) = matched_preset_name {
            name.to_string()
        } else {
            format!(
                "自定义修改 ({} 项变更 / {} 项清空)",
                self.modified_slot_count, self.stripped_slot_count
            )
        }
    }

    pub fn prompt_status_short(&self, matched_preset_name: Option<&str>) -> String {
        if self.modified_slot_count == 0 {
            "官方原版".to_string()
        } else if let Some(name) = matched_preset_name {
            name.to_string()
        } else {
            format!("自定义 ({}项已改)", self.modified_slot_count)
        }
    }
}

pub fn local_appdata_dir() -> PathBuf {
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(p);
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join("AppData").join("Local");
    }
    PathBuf::from("C:/Users/Administrator/AppData/Local")
}

pub fn user_home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from("C:/Users/Administrator")
}

pub fn app_backup_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("backup")))
        .unwrap_or_else(|| PathBuf::from("backup"))
}

pub fn binary_backup_path(id: &str, target_path: &Path) -> PathBuf {
    let fname = target_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let bak_name = if id == "ide_hub" {
        format!("ide_hub_{}.bak", fname)
    } else {
        format!("{}.bak", fname)
    };
    app_backup_dir().join(bak_name)
}

fn resolve_existing_binary_bak(id: &str, target_path: &Path) -> Option<PathBuf> {
    let primary = binary_backup_path(id, target_path);
    if primary.exists() {
        return Some(primary);
    }
    let legacy = PathBuf::from(format!("{}.bak", target_path.display()));
    if legacy.exists() {
        return Some(legacy);
    }
    None
}

fn resolve_standalone_agy_path() -> PathBuf {
    let default_path = local_appdata_dir().join("agy").join("bin").join("agy.exe");
    if default_path.exists() {
        return default_path;
    }
    if let Ok(out) = Command::new("where.exe")
        .arg("agy.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return p;
                }
            }
        }
    }
    default_path
}

pub fn target_binaries() -> Vec<(String, String, PathBuf)> {
    let local = local_appdata_dir();
    let home = user_home_dir();

    let desktop_path = local
        .join("Programs")
        .join("antigravity")
        .join("resources")
        .join("bin")
        .join("language_server.exe");

    let standalone_path = resolve_standalone_agy_path();

    let ide_legacy_path = local
        .join("Programs")
        .join("Antigravity IDE")
        .join("resources")
        .join("app")
        .join("extensions")
        .join("antigravity")
        .join("bin")
        .join("language_server_windows_x64.exe");

    let ide_hub_path = home.join(".gemini").join("bin").join("agy.exe");

    let mut list = vec![
        (
            "cli".to_string(),
            "桌面端内核 (language_server.exe)".to_string(),
            desktop_path,
        ),
        (
            "standalone".to_string(),
            "独立版 CLI (agy.exe)".to_string(),
            standalone_path.clone(),
        ),
    ];

    if ide_legacy_path.exists() || !ide_hub_path.exists() {
        list.push((
            "ide".to_string(),
            "IDE 插件内核 (language_server_windows_x64.exe)".to_string(),
            ide_legacy_path.clone(),
        ));
    }
    if ide_hub_path.exists() && ide_hub_path != standalone_path {
        list.push((
            "ide_hub".to_string(),
            "IDE 2.6+ 后端 (~/.gemini/bin/agy.exe)".to_string(),
            ide_hub_path,
        ));
    }

    list
}

// ============================================================================
// PE64 + Go embed.FS 解析器
// ============================================================================

#[derive(Debug, Clone, Copy)]
struct PeSection {
    v_size: u32,
    v_addr: u32,
    raw_size: u32,
    raw_ptr: u32,
}

fn read_u16_le(buf: &[u8], off: usize) -> Option<u16> {
    buf.get(off..off + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
}

fn read_u32_le(buf: &[u8], off: usize) -> Option<u32> {
    buf.get(off..off + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_u64_le(buf: &[u8], off: usize) -> Option<u64> {
    buf.get(off..off + 8).map(|s| {
        u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn compute_active_bytes(raw_text: &str) -> (usize, bool) {
    // 兼容读取历史版本写入的 {{- /* ... */ -}} 与当前统一使用的不吞换行注释 {{/* ... */}}
    if raw_text.ends_with("*/}}") {
        if let Some(idx) = raw_text.rfind("{{/*") {
            if idx + 8 <= raw_text.len() && raw_text[idx + 4..raw_text.len() - 4].bytes().all(|b| b == b' ') {
                return (idx, idx == 0);
            }
        }
    }
    if raw_text.ends_with("*/ -}}") {
        if let Some(idx) = raw_text.rfind("{{- /*") {
            if idx + 12 <= raw_text.len() && raw_text[idx + 6..raw_text.len() - 6].bytes().all(|b| b == b' ') {
                return (idx, idx == 0);
            }
        }
    }
    (raw_text.len(), false)
}

pub fn parse_pe_embed_templates(buf: &[u8]) -> Result<BTreeMap<String, TemplateSlot>, String> {
    let pe_offset = read_u32_le(buf, 0x3c).ok_or("Invalid PE header offset")? as usize;
    let num_sections = read_u16_le(buf, pe_offset + 6).ok_or("Invalid PE num_sections")? as usize;
    let opt_hdr_size = read_u16_le(buf, pe_offset + 20).ok_or("Invalid PE opt_hdr_size")? as usize;
    let image_base = read_u64_le(buf, pe_offset + 24 + 24).ok_or("Invalid PE image_base")?;
    let sec_table_off = pe_offset + 24 + opt_hdr_size;

    let mut sections = Vec::with_capacity(num_sections);
    for i in 0..num_sections {
        let off = sec_table_off + i * 40;
        let v_size = read_u32_le(buf, off + 8).ok_or("Section v_size OOB")?;
        let v_addr = read_u32_le(buf, off + 12).ok_or("Section v_addr OOB")?;
        let raw_size = read_u32_le(buf, off + 16).ok_or("Section raw_size OOB")?;
        let raw_ptr = read_u32_le(buf, off + 20).ok_or("Section raw_ptr OOB")?;
        sections.push(PeSection {
            v_size,
            v_addr,
            raw_size,
            raw_ptr,
        });
    }

    let file_offset_to_va = |foff: usize| -> Option<u64> {
        let f = foff as u32;
        for s in &sections {
            if f >= s.raw_ptr && f < s.raw_ptr.saturating_add(s.raw_size) {
                return Some(image_base + (s.v_addr + (f - s.raw_ptr)) as u64);
            }
        }
        None
    };

    let va_to_file_offset = |va: u64| -> Option<usize> {
        if va < image_base {
            return None;
        }
        let rva = (va - image_base) as u32;
        for s in &sections {
            if rva >= s.v_addr && rva < s.v_addr.saturating_add(s.v_size) {
                return Some((s.raw_ptr + (rva - s.v_addr)) as usize);
            }
        }
        None
    };

    let anchor_name =
        b"google3/third_party/jetski/prompt/template_provider/templates/system_prompts/identity.tmpl";
    let foff = find_subslice(buf, anchor_name)
        .ok_or_else(|| "Cannot find identity.tmpl path string in binary".to_string())?;
    let va = file_offset_to_va(foff).ok_or("Cannot map identity.tmpl file offset to VA")?;

    let mut needle = [0u8; 16];
    needle[0..8].copy_from_slice(&va.to_le_bytes());
    needle[8..16].copy_from_slice(&(anchor_name.len() as u64).to_le_bytes());

    let entry_off = find_subslice(buf, &needle)
        .ok_or_else(|| "Cannot locate Go embed.FS slice entry for identity.tmpl".to_string())?;

    let prefix = "google3/third_party/jetski/prompt/template_provider/templates/";
    let sys_prefix =
        "google3/third_party/jetski/prompt/template_provider/templates/system_prompts/";
    let mut templates = BTreeMap::new();

    for k in -12isize..=12isize {
        let e_signed = entry_off as isize + k * 48;
        if e_signed < 0 {
            continue;
        }
        let e = e_signed as usize;
        if e + 48 > buf.len() {
            continue;
        }
        let n_va = match read_u64_le(buf, e) {
            Some(v) => v,
            None => continue,
        };
        let n_len = match read_u64_le(buf, e + 8) {
            Some(v) => v as usize,
            None => continue,
        };
        let d_va = match read_u64_le(buf, e + 16) {
            Some(v) => v,
            None => continue,
        };
        let d_len = match read_u64_le(buf, e + 24) {
            Some(v) => v as usize,
            None => continue,
        };

        if n_len == 0 || n_len >= 240 {
            continue;
        }
        let n_off = match va_to_file_offset(n_va) {
            Some(o) if o + n_len <= buf.len() => o,
            _ => continue,
        };
        let d_off = match va_to_file_offset(d_va) {
            Some(o) if o + d_len <= buf.len() => o,
            _ => continue,
        };

        let full_name = match std::str::from_utf8(&buf[n_off..n_off + n_len]) {
            Ok(s) => s.to_string(),
            Err(_) => continue,
        };
        if !full_name.starts_with(sys_prefix) {
            continue;
        }
        let short_name = full_name.trim_start_matches(prefix).to_string();
        let raw_str = String::from_utf8_lossy(&buf[d_off..d_off + d_len]);
        let (active_bytes, is_stripped) = compute_active_bytes(&raw_str);
        let is_modified = active_bytes != d_len;
        let content = raw_str
            .get(..active_bytes.min(raw_str.len()))
            .unwrap_or(&raw_str)
            .to_string();
        let preview_slice: String = content.chars().take(140).collect();

        templates.insert(
            short_name.clone(),
            TemplateSlot {
                short_name,
                full_name,
                entry_offset: e,
                data_offset: d_off,
                data_length: d_len,
                active_bytes,
                is_stripped,
                is_modified,
                preview: if is_stripped {
                    "[STRIPPED 0B — {{- /* ... */ -}}]".to_string()
                } else {
                    preview_slice.replace('\n', " ")
                },
                content,
            },
        );
    }

    if templates.is_empty() {
        return Err("No embed.FS prompt templates parsed".to_string());
    }
    Ok(templates)
}

pub fn write_padded_template(
    buf: &mut [u8],
    slot: &TemplateSlot,
    new_text: &str,
) -> Result<usize, String> {
    let encoded = new_text.as_bytes();
    if encoded.len() > slot.data_length {
        return Err(format!(
            "模板 {} 超出上限: 当前 {}B > 上限 {}B (超出 {}B)",
            display_slot_name(&slot.short_name),
            encoded.len(),
            slot.data_length,
            encoded.len() - slot.data_length
        ));
    }
    let pad_len = slot.data_length - encoded.len();
    // 统一使用不带连字符的 {{/*   */}}，避免吃掉用户正文末尾换行符
    let padding = if pad_len >= 8 {
        let mut s = String::with_capacity(pad_len);
        s.push_str("{{/*");
        s.push_str(&" ".repeat(pad_len - 8));
        s.push_str("*/}}");
        s.into_bytes()
    } else {
        vec![b' '; pad_len]
    };

    let start = slot.data_offset;
    buf[start..start + encoded.len()].copy_from_slice(encoded);
    buf[start + encoded.len()..start + slot.data_length].copy_from_slice(&padding);
    Ok(encoded.len())
}

pub fn inspect_context_state(buf: &[u8]) -> Vec<ContextGateHit> {
    let mut results = Vec::new();
    for sig in CONTEXT_SIGNATURES {
        let b_stock = hex::decode(sig.stock_hex).unwrap_or_default();
        let b_512 = hex::decode(sig.patch_512k_hex).unwrap_or_default();
        let b_900 = hex::decode(sig.patch_900k_hex).unwrap_or_default();

        if let Some(off) = find_subslice(buf, &b_stock) {
            results.push(ContextGateHit {
                id: sig.id,
                desc: sig.desc,
                mode: ContextMode::Stock,
                offset: off,
            });
        } else if let Some(off) = find_subslice(buf, &b_512) {
            results.push(ContextGateHit {
                id: sig.id,
                desc: sig.desc,
                mode: ContextMode::Unlock512K,
                offset: off,
            });
        } else if let Some(off) = find_subslice(buf, &b_900) {
            results.push(ContextGateHit {
                id: sig.id,
                desc: sig.desc,
                mode: ContextMode::Unlock900K,
                offset: off,
            });
        }
    }
    results
}

pub fn inspect_all_binaries() -> Vec<BinaryInspection> {
    let targets = target_binaries();
    std::thread::scope(|s| {
        let handles: Vec<_> = targets
            .into_iter()
            .map(|(id, label, path)| s.spawn(move || inspect_single_binary(id, label, path)))
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect()
    })
}

fn inspect_single_binary(id: String, label: String, path: PathBuf) -> BinaryInspection {
    let exists = path.exists();
    let existing_bak = resolve_existing_binary_bak(&id, &path);
    let bak_exists = existing_bak.is_some();

    if !exists {
        return BinaryInspection {
            id,
            label,
            path,
            exists: false,
            bak_exists,
            file_size_mb: 0.0,
            modified_slot_count: 0,
            stripped_slot_count: 0,
            total_slot_capacity: 0,
            active_slot_bytes: 0,
            slots: Vec::new(),
            context_gates: Vec::new(),
            error: None,
        };
    }

    match fs::read(&path) {
        Ok(buf) => {
            let file_size_mb = buf.len() as f64 / (1024.0 * 1024.0);
            let bak_buf_opt = existing_bak.as_ref().and_then(|p| fs::read(p).ok());
            let bak_templates_opt = bak_buf_opt
                .as_deref()
                .and_then(|bb| parse_pe_embed_templates(bb).ok());

            match parse_pe_embed_templates(&buf) {
                Ok(mut templates) => {
                    for (name, slot) in templates.iter_mut() {
                        if let (Some(bak_buf), Some(bak_map)) =
                            (bak_buf_opt.as_deref(), bak_templates_opt.as_ref())
                        {
                            if let Some(bak_slot) = bak_map.get(name) {
                                let cur_end = (slot.data_offset + slot.data_length).min(buf.len());
                                let bak_end =
                                    (bak_slot.data_offset + bak_slot.data_length).min(bak_buf.len());
                                slot.is_modified = buf[slot.data_offset..cur_end]
                                    != bak_buf[bak_slot.data_offset..bak_end];
                            }
                        }
                    }

                    let context_gates = inspect_context_state(&buf);
                    let slots: Vec<TemplateSlot> = templates.into_values().collect();
                    let total_slot_capacity: usize = slots.iter().map(|s| s.data_length).sum();
                    let active_slot_bytes: usize = slots.iter().map(|s| s.active_bytes).sum();
                    let modified_slot_count = slots.iter().filter(|s| s.is_modified).count();
                    let stripped_slot_count = slots.iter().filter(|s| s.is_stripped).count();

                    BinaryInspection {
                        id,
                        label,
                        path,
                        exists: true,
                        bak_exists,
                        file_size_mb,
                        modified_slot_count,
                        stripped_slot_count,
                        total_slot_capacity,
                        active_slot_bytes,
                        slots,
                        context_gates,
                        error: None,
                    }
                }
                Err(e) => BinaryInspection {
                    id,
                    label,
                    path,
                    exists: true,
                    bak_exists,
                    file_size_mb,
                    modified_slot_count: 0,
                    stripped_slot_count: 0,
                    total_slot_capacity: 0,
                    active_slot_bytes: 0,
                    slots: Vec::new(),
                    context_gates: Vec::new(),
                    error: Some(e),
                },
            }
        }
        Err(e) => BinaryInspection {
            id,
            label,
            path,
            exists: true,
            bak_exists,
            file_size_mb: 0.0,
            modified_slot_count: 0,
            stripped_slot_count: 0,
            total_slot_capacity: 0,
            active_slot_bytes: 0,
            slots: Vec::new(),
            context_gates: Vec::new(),
            error: Some(format!("读取失败: {}", e)),
        },
    }
}

pub fn apply_prompt_patch_to_buffer(
    buf: &mut [u8],
    bak_buf: &[u8],
    patch: &PromptPatch,
) -> Result<String, String> {
    let bak_templates = parse_pe_embed_templates(bak_buf)?;
    let cur_templates = parse_pe_embed_templates(buf)?;

    // 预先校验各目标槽位字节上限
    let mut ops: Vec<(String, &String)> = Vec::with_capacity(patch.slots.len());
    for (raw_key, text) in &patch.slots {
        let key = normalize_slot_key(raw_key);
        let Some(cur_slot) = cur_templates.get(&key) else {
            continue;
        };
        if text.len() > cur_slot.data_length {
            return Err(format!(
                "模板 {} 超出上限: 当前 {}B > 上限 {}B (超出 {}B)",
                display_slot_name(&key),
                text.len(),
                cur_slot.data_length,
                text.len() - cur_slot.data_length
            ));
        }
        ops.push((key, text));
    }

    // Step 1: 先从 .bak 完整还原模板槽位，保证任意预设切换 100% 干净无损
    for (key, cur_slot) in &cur_templates {
        if let Some(bak_slot) = bak_templates.get(key) {
            if cur_slot.data_length == bak_slot.data_length && cur_slot.data_length > 0 {
                buf[cur_slot.data_offset..cur_slot.data_offset + cur_slot.data_length]
                    .copy_from_slice(
                        &bak_buf[bak_slot.data_offset..bak_slot.data_offset + bak_slot.data_length],
                    );
            }
        }
    }

    let mut replaced_count = 0usize;
    let mut stripped_count = 0usize;
    for (key, text) in &ops {
        let cur_slot = &cur_templates[key];
        write_padded_template(buf, cur_slot, text)?;
        if text.is_empty() {
            stripped_count += 1;
        } else {
            replaced_count += 1;
        }
    }

    let is_stock = ops.is_empty();

    // 处理 CLI v2.29+ genericsystemprompt.applyEdits 的启动模板子串强校验 (防止 code=2 panic)
    // 原版特征: mov rsi,[rcx+10h]; mov [rsp+58h],rsi; mov rsi,[rcx+18h]; mov [rsp+38h],rsi; mov rcx,rdx; call strings.Count; cmp rax,1; je -0x8c
    let apply_edits_prefix =
        hex::decode("488b71104889742458488b711848897424384889d1").unwrap_or_default();
    let apply_edits_tail_stock = hex::decode("4883f8010f8474ffffff").unwrap_or_default();
    let apply_edits_tail_bypass = hex::decode("4883f801e975ffffff90").unwrap_or_default();

    if let Some(prefix_off) = find_subslice(bak_buf, &apply_edits_prefix) {
        let tail_off = prefix_off + apply_edits_prefix.len() + 5; // 跳过 5 字节 call strings.Count
        if tail_off + 10 <= bak_buf.len()
            && &bak_buf[tail_off..tail_off + 10] == apply_edits_tail_stock.as_slice()
        {
            if is_stock {
                buf[tail_off..tail_off + 10].copy_from_slice(&apply_edits_tail_stock);
            } else {
                buf[tail_off..tail_off + 10].copy_from_slice(&apply_edits_tail_bypass);
            }
        }
    }

    if is_stock {
        Ok(format!(
            "已将全部 {} 个 .tmpl 槽位还原为 100% 官方原版",
            cur_templates.len()
        ))
    } else {
        Ok(format!(
            "已应用预设 [{}]: 清空 {} 槽, 改写 {} 槽",
            patch.name, stripped_count, replaced_count
        ))
    }
}

pub fn apply_context_patch_to_buffer(
    buf: &mut [u8],
    bak_buf: &[u8],
    mode: ContextMode,
) -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    for sig in CONTEXT_SIGNATURES {
        let b_stock = hex::decode(sig.stock_hex).map_err(|e| e.to_string())?;
        let off_in_bak = match find_subslice(bak_buf, &b_stock) {
            Some(off) => off,
            None => continue,
        };
        let replacement = match mode {
            ContextMode::Stock => b_stock,
            ContextMode::Unlock512K => hex::decode(sig.patch_512k_hex).map_err(|e| e.to_string())?,
            ContextMode::Unlock900K => hex::decode(sig.patch_900k_hex).map_err(|e| e.to_string())?,
        };
        buf[off_in_bak..off_in_bak + replacement.len()].copy_from_slice(&replacement);
        logs.push(format!("{} @{} -> {:?}", sig.desc, off_in_bak, mode));
    }
    Ok(logs)
}

pub fn sync_settings_json_context_window(mode: ContextMode) -> Vec<String> {
    let home = user_home_dir();
    let paths = [
        home.join(".gemini").join("config").join("config.json"),
        home.join(".gemini")
            .join("antigravity-cli")
            .join("settings.json"),
    ];
    let mut logs = Vec::new();
    for sp in &paths {
        let Some(parent) = sp.parent() else { continue };
        if !parent.exists() {
            continue;
        }
        let mut obj: serde_json::Value = if sp.exists() {
            fs::read_to_string(sp)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        if let Some(map) = obj.as_object_mut() {
            match mode {
                ContextMode::Stock => {
                    map.remove("contextWindow");
                }
                ContextMode::Unlock512K => {
                    map.insert(
                        "contextWindow".to_string(),
                        serde_json::Value::String("512K".to_string()),
                    );
                }
                ContextMode::Unlock900K => {
                    map.insert(
                        "contextWindow".to_string(),
                        serde_json::Value::String("900K".to_string()),
                    );
                }
            }
            if let Ok(serialized) = serde_json::to_string_pretty(&obj) {
                if fs::write(sp, format!("{}\n", serialized)).is_ok() {
                    logs.push(format!("已同步配置文件: {}", sp.display()));
                }
            }
        }
    }
    logs
}

pub fn execute_patch_operations(
    prompt_patch: Option<&PromptPatch>,
    context_mode: Option<ContextMode>,
) -> Result<Vec<String>, String> {
    let mut logs = Vec::new();
    let mut any_error = None;
    let mut processed_count = 0usize;

    for (id, label, path) in target_binaries() {
        if !path.exists() {
            continue;
        }
        processed_count += 1;
        logs.push(format!("▶ 正在处理: {} ({})", label, path.display()));
        let bak_path = binary_backup_path(&id, &path);
        if !bak_path.exists() {
            if let Some(parent) = bak_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建备份目录失败 ({}): {}", parent.display(), e))?;
            }
            let legacy_bak = PathBuf::from(format!("{}.bak", path.display()));
            let src_for_bak = if legacy_bak.exists() {
                &legacy_bak
            } else {
                &path
            };
            fs::copy(src_for_bak, &bak_path)
                .map_err(|e| format!("创建备份失败 ({}): {}", bak_path.display(), e))?;
            logs.push(format!("  [BACKUP] 已创建原始备份: {}", bak_path.display()));
        }

        let orig_disk_buf =
            fs::read(&path).map_err(|e| format!("读取目标二进制失败: {}", e))?;
        let mut cur_buf = orig_disk_buf.clone();
        let bak_buf = fs::read(&bak_path).map_err(|e| format!("读取备份二进制失败: {}", e))?;

        if let Some(patch) = prompt_patch {
            let msg = apply_prompt_patch_to_buffer(&mut cur_buf, &bak_buf, patch)?;
            logs.push(format!("  [PROMPT] {}", msg));
        }
        if let Some(mode) = context_mode {
            let ctx_logs = apply_context_patch_to_buffer(&mut cur_buf, &bak_buf, mode)?;
            for l in ctx_logs {
                logs.push(format!("  [CTX] {}", l));
            }
        }

        match write_binary_with_unlock(&path, &orig_disk_buf, &cur_buf) {
            Ok(written_bytes) => logs.push(format!(
                "  [SUCCESS] 已写入变更 ({} Bytes): {}",
                written_bytes,
                path.display()
            )),
            Err(e) => {
                let err_msg = format!(
                    "  [ERROR] 写入 {} 失败: {}",
                    path.file_name().unwrap_or_default().to_string_lossy(),
                    e
                );
                logs.push(err_msg.clone());
                any_error = Some(err_msg);
            }
        }
    }

    if processed_count == 0 {
        return Err(
            "未检测到任何已安装的 Antigravity 内核文件（已检查桌面端 language_server.exe、独立版 %LOCALAPPDATA%\\agy\\bin\\agy.exe 及 IDE 端）".to_string()
        );
    }

    if let Some(mode) = context_mode {
        for l in sync_settings_json_context_window(mode) {
            logs.push(format!("  [CFG] {}", l));
        }
        let _ = crate::injector::set_hud_context_cap_via_cdp(mode);
    }

    if let Some(err) = any_error {
        return Err(format!("{}\n{}", logs.join("\n"), err));
    }
    Ok(logs)
}

// ============================================================================
// 进程状态检测与辅助管理
// ============================================================================

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct ProcessStatus {
    pub antigravity_app_running: bool,
    pub language_server_running: bool,
}

fn write_binary_with_unlock(
    path: &Path,
    old_buf: &[u8],
    new_buf: &[u8],
) -> std::io::Result<usize> {
    if old_buf == new_buf {
        return Ok(0);
    }

    let stale_path = PathBuf::from(format!("{}.old_run", path.display()));
    let _ = fs::remove_file(&stale_path);

    // 1. 若进程未运行（文件未锁定），直接原位增量写入变更段（<5ms）
    if let Ok(n) = write_changed_ranges_in_place(path, old_buf, new_buf) {
        return Ok(n);
    }

    // 2. 若 language_server 正在运行锁定文件：利用 Windows 允许将运行中 .exe 同目录重命名的特性，
    //    不杀进程（避免正在打开的 Antigravity 页面断连），将旧运行实例改名为 .old_run 后写入新二进制
    if fs::rename(path, &stale_path).is_ok() {
        match fs::write(path, new_buf) {
            Ok(_) => {
                let _ = fs::remove_file(&stale_path);
                return Ok(new_buf.len());
            }
            Err(e) => {
                let _ = fs::rename(&stale_path, path);
                return Err(e);
            }
        }
    }

    // 3. 极端情况（上次遗留的 .old_run 仍被占用）：短暂释放旧进程后再原位写入
    let _ = kill_language_servers();
    for wait_ms in [40u64, 80, 150] {
        std::thread::sleep(Duration::from_millis(wait_ms));
        let _ = fs::remove_file(&stale_path);
        if let Ok(n) = write_changed_ranges_in_place(path, old_buf, new_buf) {
            return Ok(n);
        }
    }

    write_changed_ranges_in_place(path, old_buf, new_buf)
}

fn write_changed_ranges_in_place(
    path: &Path,
    old_buf: &[u8],
    new_buf: &[u8],
) -> std::io::Result<usize> {
    if old_buf.len() != new_buf.len() {
        fs::write(path, new_buf)?;
        return Ok(new_buf.len());
    }
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let len = new_buf.len();
    let mut i = 0;
    let mut total_written = 0usize;

    while i < len {
        if old_buf[i] != new_buf[i] {
            let start = i;
            i += 1;
            while i < len && old_buf[i] != new_buf[i] {
                i += 1;
            }
            file.seek(SeekFrom::Start(start as u64))?;
            file.write_all(&new_buf[start..i])?;
            total_written += i - start;
        } else {
            i += 1;
        }
    }
    file.flush()?;
    Ok(total_written)
}

pub fn check_running_processes() -> ProcessStatus {
    let output = Command::new("tasklist")
        .args(["/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(out) = output else {
        return ProcessStatus::default();
    };
    let text = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
    ProcessStatus {
        antigravity_app_running: text.contains("\"antigravity.exe\""),
        language_server_running: text.contains("\"language_server.exe\"")
            || text.contains("\"language_server_windows_x64.exe\"")
            || text.contains("\"agy.exe\""),
    }
}

pub fn kill_language_servers() -> Vec<String> {
    let mut logs = Vec::new();
    for img in [
        "language_server.exe",
        "language_server_windows_x64.exe",
        "agy.exe",
    ] {
        if let Ok(out) = Command::new("taskkill")
            .args(["/F", "/IM", img])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if out.status.success() {
                logs.push(format!("已终止进程: {}", img));
            }
        }
    }
    if logs.is_empty() {
        logs.push("当前无运行中的 language_server 进程".to_string());
    }
    logs
}

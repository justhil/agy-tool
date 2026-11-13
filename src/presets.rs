use crate::patcher::{display_slot_name, normalize_slot_key, PromptPatch, TemplateSlot};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct PromptPreset {
    pub name: String,
    pub slots: BTreeMap<String, String>,
}

impl PromptPreset {
    pub fn to_patch(&self) -> PromptPatch {
        PromptPatch {
            name: self.name.clone(),
            slots: self.slots.clone(),
        }
    }

    pub fn summary(&self) -> String {
        let stripped: Vec<&str> = self
            .slots
            .iter()
            .filter(|(_, v)| v.is_empty())
            .map(|(k, _)| display_slot_name(k))
            .collect();
        let replaced: Vec<&str> = self
            .slots
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, _)| display_slot_name(k))
            .collect();

        match (stripped.is_empty(), replaced.is_empty()) {
            (false, false) => format!(
                "清空 {} 个模板，替换 {}",
                stripped.len(),
                replaced.join(", ")
            ),
            (false, true) => {
                if stripped.len() <= 3 {
                    format!("清空 {} 个模板 ({})", stripped.len(), stripped.join(", "))
                } else {
                    format!("清空 {} 个模板，其余保持原版", stripped.len())
                }
            }
            (true, false) => format!("替换 {}", replaced.join(", ")),
            (true, true) => "无修改".to_string(),
        }
    }
}

pub fn presets_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("presets")))
}

fn collect_tmpl_files(base: &Path, cur: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
    let entries = fs::read_dir(cur)
        .map_err(|e| format!("读取预设目录失败 ({}): {}", cur.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_tmpl_files(base, &path, out)?;
        } else if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("tmpl"))
            .unwrap_or(false)
        {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let raw = fs::read_to_string(&path)
                .map_err(|e| format!("读取模板文件失败 ({}): {}", path.display(), e))?;
            out.insert(normalize_slot_key(&rel_str), raw.replace("\r\n", "\n"));
        }
    }
    Ok(())
}

pub fn load_preset_dir(dir: &Path) -> Result<PromptPreset, String> {
    let mut slots = BTreeMap::new();
    collect_tmpl_files(dir, dir, &mut slots)?;
    if slots.is_empty() {
        return Err(format!("预设目录中未找到任何 .tmpl 文件: {}", dir.display()));
    }
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(PromptPreset {
        name,
        slots,
    })
}

fn discover_presets_in(root: &Path) -> Vec<PromptPreset> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort();

    let mut list = Vec::new();
    for sub in subdirs {
        if let Ok(preset) = load_preset_dir(&sub) {
            list.push(preset);
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

pub fn discover_presets() -> Vec<PromptPreset> {
    presets_dir()
        .map(|root| discover_presets_in(&root))
        .unwrap_or_default()
}

pub fn resolve_preset(query: &str) -> Result<PromptPreset, String> {
    let trimmed = query.trim();
    let q_lower = trimmed.to_ascii_lowercase();
    let presets = discover_presets();
    if let Some(exact) = presets
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(&q_lower))
    {
        return Ok(exact.clone());
    }
    let prefix_hits: Vec<&PromptPreset> = presets
        .iter()
        .filter(|p| p.name.to_ascii_lowercase().starts_with(&q_lower))
        .collect();
    if prefix_hits.len() == 1 {
        return Ok(prefix_hits[0].clone());
    }

    let names: Vec<&str> = presets.iter().map(|p| p.name.as_str()).collect();
    if names.is_empty() {
        let dir_hint = presets_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "presets".to_string());
        Err(format!("未找到预设 '{}'，且 {} 下无预设文件夹", trimmed, dir_hint))
    } else {
        Err(format!(
            "未找到预设 '{}' (可用预设文件夹: {})",
            trimmed,
            names.join(", ")
        ))
    }
}

pub fn match_binary_to_preset<'a>(
    slots: &[TemplateSlot],
    presets: &'a [PromptPreset],
) -> Option<&'a PromptPreset> {
    if slots.is_empty() || slots.iter().all(|s| !s.is_modified) {
        return None;
    }
    'outer: for p in presets {
        for s in slots {
            if let Some(expected) = p.slots.get(&s.short_name) {
                if expected.is_empty() {
                    if !s.is_stripped && s.active_bytes != 0 {
                        continue 'outer;
                    }
                } else if s.content != *expected {
                    continue 'outer;
                }
            } else if s.is_modified {
                continue 'outer;
            }
        }
        return Some(p);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preset_folders_discover_and_fit_slot_caps() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("presets");
        let presets = discover_presets_in(&root);
        assert!(presets.len() >= 4, "expected >= 4 preset folders");
        for prefix in ["tier1", "tier2", "tier3", "tier4"] {
            let p = presets
                .iter()
                .find(|p| p.name.starts_with(prefix))
                .expect("resolve preset folder");
            if let Some(g) = p.slots.get("system_prompts/guidelines.tmpl") {
                assert!(g.len() <= 691, "{} guidelines {}B > 691B", p.name, g.len());
            }
            if let Some(fc) = p.slots.get("system_prompts/function_call.tmpl") {
                assert!(fc.len() <= 605, "{} function_call {}B > 605B", p.name, fc.len());
            }
            if let Some(cs) = p.slots.get("system_prompts/communication_style.tmpl") {
                assert!(
                    cs.len() <= 2034,
                    "{} communication_style {}B > 2034B",
                    p.name,
                    cs.len()
                );
            }
        }
    }
}

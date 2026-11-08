use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const BLOCK_SIZE: usize = 4 * 1024 * 1024;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn compute_integrity(data: &[u8]) -> Value {
    let mut blocks = Vec::new();
    if data.is_empty() {
        blocks.push(Value::String(sha256_hex(&[])));
    } else {
        let mut i = 0;
        while i < data.len() {
            let end = (i + BLOCK_SIZE).min(data.len());
            blocks.push(Value::String(sha256_hex(&data[i..end])));
            i = end;
        }
    }
    json!({
        "algorithm": "SHA256",
        "hash": sha256_hex(data),
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    })
}

#[allow(dead_code)]
pub struct AsarArchive<'a> {
    pub root: Value,
    pub base_offset: usize,
    pub payload: &'a [u8],
}

impl<'a> AsarArchive<'a> {
    pub fn parse(raw: &'a [u8]) -> Result<Self, String> {
        if raw.len() < 16 {
            return Err("ASAR 文件过小 (<16 bytes)".to_string());
        }
        let header_size = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
        let json_len = u32::from_le_bytes([raw[12], raw[13], raw[14], raw[15]]) as usize;
        let base_offset = 8usize.saturating_add(header_size);
        if 16 + json_len > raw.len() || base_offset > raw.len() {
            return Err("ASAR 头部偏移越界".to_string());
        }
        let root: Value = serde_json::from_slice(&raw[16..16 + json_len])
            .map_err(|e| format!("解析 ASAR JSON 树失败: {}", e))?;
        Ok(Self {
            root,
            base_offset,
            payload: &raw[base_offset..],
        })
    }

    pub fn lookup_node(&self, rel_path: &str) -> Option<&Value> {
        let mut cur = &self.root;
        for seg in rel_path.trim_matches('/').split('/') {
            if seg.is_empty() {
                continue;
            }
            cur = cur.get("files")?.get(seg)?;
        }
        Some(cur)
    }

    pub fn extract_file(&self, rel_path: &str) -> Result<Vec<u8>, String> {
        let node = self
            .lookup_node(rel_path)
            .ok_or_else(|| format!("ASAR 内未找到文件: {}", rel_path))?;
        if node.get("unpacked").and_then(|v| v.as_bool()) == Some(true) {
            return Err(format!("文件 {} 标记为 unpacked，不在 ASAR 载荷内", rel_path));
        }
        let offset_str = node
            .get("offset")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("文件 {} 缺少 offset 字段", rel_path))?;
        let offset: usize = offset_str
            .parse()
            .map_err(|_| format!("文件 {} offset 非法: {}", rel_path, offset_str))?;
        let size = node
            .get("size")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("文件 {} 缺少 size 字段", rel_path))? as usize;

        if offset.saturating_add(size) > self.payload.len() {
            return Err(format!("文件 {} 载荷越界", rel_path));
        }
        Ok(self.payload[offset..offset + size].to_vec())
    }
}

/// 在内存中对 ASAR 归档执行外科手术级增删改并重打包，保持其余全部文件与 unpacked 标记 100% 原样
pub fn repack_asar_in_memory(
    source_raw: &[u8],
    overrides: &BTreeMap<String, Vec<u8>>,
    removals: &BTreeSet<String>,
) -> Result<Vec<u8>, String> {
    let parsed = AsarArchive::parse(source_raw)?;
    let mut root = parsed.root;
    let source_payload = parsed.payload;

    // 1. 先在目录树中执行删除与新增节点注册
    for rem_path in removals {
        remove_node_at_path(&mut root, rem_path);
    }
    for add_path in overrides.keys() {
        ensure_file_node_at_path(&mut root, add_path)?;
    }

    // 2. 递归遍历目录树，重排 offset 并写入新 payload
    let mut new_payload = Vec::with_capacity(source_payload.len() + 64 * 1024);
    repack_walk(
        &mut root,
        "",
        source_payload,
        overrides,
        &mut new_payload,
    )?;

    // 3. 序列化新头部并按 4 字节对齐组装完整 ASAR
    let json_bytes =
        serde_json::to_vec(&root).map_err(|e| format!("序列化 ASAR 头部失败: {}", e))?;
    let aligned_len = (json_bytes.len() + 3) & !3;
    let header_body_size = (aligned_len + 4) as u32;
    let header_size = (aligned_len + 8) as u32;

    let mut out = Vec::with_capacity(16 + aligned_len + new_payload.len());
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&header_size.to_le_bytes());
    out.extend_from_slice(&header_body_size.to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&json_bytes);
    if aligned_len > json_bytes.len() {
        out.resize(16 + aligned_len, 0u8);
    }
    out.extend_from_slice(&new_payload);

    Ok(out)
}

fn remove_node_at_path(root: &mut Value, rel_path: &str) {
    let segs: Vec<&str> = rel_path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segs.is_empty() {
        return;
    }
    let mut cur = root;
    for &seg in &segs[..segs.len() - 1] {
        let Some(next) = cur.get_mut("files").and_then(|f| f.get_mut(seg)) else {
            return;
        };
        cur = next;
    }
    if let Some(files_obj) = cur.get_mut("files").and_then(|f| f.as_object_mut()) {
        files_obj.remove(segs[segs.len() - 1]);
    }
}

fn ensure_file_node_at_path(root: &mut Value, rel_path: &str) -> Result<(), String> {
    let segs: Vec<&str> = rel_path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segs.is_empty() {
        return Err("非法空文件路径".to_string());
    }
    let mut cur = root;
    for &seg in &segs[..segs.len() - 1] {
        let files_obj = cur
            .get_mut("files")
            .and_then(|f| f.as_object_mut())
            .ok_or_else(|| format!("路径 {} 中间节点不是目录", rel_path))?;
        if !files_obj.contains_key(seg) {
            files_obj.insert(seg.to_string(), json!({ "files": {} }));
        }
        cur = files_obj.get_mut(seg).unwrap();
    }
    let leaf = segs[segs.len() - 1];
    let files_obj = cur
        .get_mut("files")
        .and_then(|f| f.as_object_mut())
        .ok_or_else(|| format!("路径 {} 父节点不是目录", rel_path))?;
    if !files_obj.contains_key(leaf) {
        files_obj.insert(
            leaf.to_string(),
            json!({
                "size": 0,
                "offset": "0",
            }),
        );
    }
    Ok(())
}

fn repack_walk(
    node: &mut Value,
    cur_path: &str,
    source_payload: &[u8],
    overrides: &BTreeMap<String, Vec<u8>>,
    new_payload: &mut Vec<u8>,
) -> Result<(), String> {
    if let Some(files_map) = node.get_mut("files").and_then(|f| f.as_object_mut()) {
        let keys: Vec<String> = files_map.keys().cloned().collect();
        for k in keys {
            let child_path = if cur_path.is_empty() {
                k.clone()
            } else {
                format!("{}/{}", cur_path, k)
            };
            if let Some(child) = files_map.get_mut(&k) {
                repack_walk(child, &child_path, source_payload, overrides, new_payload)?;
            }
        }
        return Ok(());
    }

    if node.get("link").is_some()
        || node.get("unpacked").and_then(|v| v.as_bool()) == Some(true)
    {
        return Ok(());
    }

    if let Some(override_bytes) = overrides.get(cur_path) {
        let new_off = new_payload.len();
        new_payload.extend_from_slice(override_bytes);
        if let Some(obj) = node.as_object_mut() {
            obj.insert("size".to_string(), json!(override_bytes.len()));
            obj.insert("offset".to_string(), json!(new_off.to_string()));
            obj.insert("integrity".to_string(), compute_integrity(override_bytes));
        }
    } else {
        let old_off_str = node
            .get("offset")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("节点 {} 缺少 offset", cur_path))?;
        let old_off: usize = old_off_str
            .parse()
            .map_err(|_| format!("节点 {} offset 解析失败", cur_path))?;
        let size = node
            .get("size")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("节点 {} 缺少 size", cur_path))? as usize;

        if old_off.saturating_add(size) > source_payload.len() {
            return Err(format!("原文件 {} 偏移越界", cur_path));
        }
        let new_off = new_payload.len();
        new_payload.extend_from_slice(&source_payload[old_off..old_off + size]);
        if let Some(obj) = node.as_object_mut() {
            obj.insert("offset".to_string(), json!(new_off.to_string()));
        }
    }

    Ok(())
}

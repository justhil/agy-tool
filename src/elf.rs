//! ELF64 (x86-64) 解析器：为 Linux 版 agy 提供与 PE 版等价的 Go embed.FS 模板槽位定位能力。
//!
//! 与 PE 路径的关键差异：
//! 1. Linux 版为 PIE (ET_DYN)，模板数据位于只读 PT_LOAD 段，file offset 与 VA 不相等；
//! 2. PIE 下 embed.FS 条目内的 string 指针在磁盘上是 0，真实地址由 `.rela.dyn`
//!    的 R_X86_64_RELATIVE 重定位在加载时写入，因此必须先解析重定位表才能还原 name/data 指针；
//! 3. 条目结构仍为 48 字节 `{ name string; data string; hash [16]byte }`，步长与 PE 版一致。

use crate::patcher::{compute_active_bytes, TemplateSlot};
use std::collections::BTreeMap;

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const SHT_RELA: u32 = 4;
const DT_NULL: i64 = 0;
const DT_RELA: i64 = 7;
const DT_RELASZ: i64 = 8;

const ENTRY_STRIDE: usize = 48;
const FULL_PREFIX: &str = "google3/third_party/jetski/prompt/template_provider/templates/";
const SYS_PREFIX: &str =
    "google3/third_party/jetski/prompt/template_provider/templates/system_prompts/";

pub fn is_elf64_le(buf: &[u8]) -> bool {
    buf.len() > 64 && &buf[0..4] == b"\x7fELF" && buf[4] == 2 && buf[5] == 1
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
    buf.get(off..off + 8)
        .map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

pub fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[derive(Debug, Clone, Copy)]
struct LoadSeg {
    file_off: u64,
    vaddr: u64,
    file_size: u64,
}

/// ELF64 镜像：PT_LOAD 段映射表 + `.rela.dyn` 重定位区间
pub struct ElfImage {
    segs: Vec<LoadSeg>,
    rela_ranges: Vec<(u64, u64)>, // (file offset, byte size)
}

impl ElfImage {
    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if !is_elf64_le(buf) {
            return Err("不是 ELF64 小端镜像".to_string());
        }
        let phoff = read_u64_le(buf, 0x20).ok_or("Invalid ELF e_phoff")? as usize;
        let phentsize = read_u16_le(buf, 0x36).ok_or("Invalid ELF e_phentsize")? as usize;
        let phnum = read_u16_le(buf, 0x38).ok_or("Invalid ELF e_phnum")? as usize;
        if phentsize < 56 {
            return Err("ELF e_phentsize 非法".to_string());
        }

        let mut segs = Vec::new();
        let mut dynamic: Option<(u64, u64)> = None;
        for i in 0..phnum {
            let o = phoff + i * phentsize;
            let p_type = read_u32_le(buf, o).ok_or("Program header OOB")?;
            let p_offset = read_u64_le(buf, o + 8).ok_or("Program header p_offset OOB")?;
            let p_vaddr = read_u64_le(buf, o + 16).ok_or("Program header p_vaddr OOB")?;
            let p_filesz = read_u64_le(buf, o + 32).ok_or("Program header p_filesz OOB")?;
            match p_type {
                PT_LOAD => segs.push(LoadSeg {
                    file_off: p_offset,
                    vaddr: p_vaddr,
                    file_size: p_filesz,
                }),
                PT_DYNAMIC => dynamic = Some((p_offset, p_filesz)),
                _ => {}
            }
        }
        if segs.is_empty() {
            return Err("ELF 中没有可用的 PT_LOAD 段".to_string());
        }
        segs.sort_by_key(|s| s.vaddr);

        let mut img = ElfImage {
            segs,
            rela_ranges: Vec::new(),
        };

        // 优先使用 PT_DYNAMIC 的 DT_RELA / DT_RELASZ（不依赖 section header，剥离更彻底时依然可用）
        if let Some((dyn_off, dyn_size)) = dynamic {
            let dyn_off = dyn_off as usize;
            let mut rela_va = None;
            let mut rela_sz = None;
            let n = (dyn_size / 16) as usize;
            for i in 0..n {
                let o = dyn_off + i * 16;
                let Some(tag) = read_u64_le(buf, o).map(|v| v as i64) else {
                    break;
                };
                if tag == DT_NULL {
                    break;
                }
                let val = read_u64_le(buf, o + 8).unwrap_or(0);
                match tag {
                    DT_RELA => rela_va = Some(val),
                    DT_RELASZ => rela_sz = Some(val),
                    _ => {}
                }
            }
            if let (Some(va), Some(sz)) = (rela_va, rela_sz) {
                if let Some(off) = img.va_to_off(va) {
                    img.rela_ranges.push((off as u64, sz));
                }
            }
        }

        // 兜底：遍历 section header 中的 SHT_RELA
        if img.rela_ranges.is_empty() {
            if let (Some(shoff), Some(shentsize), Some(shnum)) = (
                read_u64_le(buf, 0x28),
                read_u16_le(buf, 0x3a),
                read_u16_le(buf, 0x3c),
            ) {
                let (shoff, shentsize, shnum) = (shoff as usize, shentsize as usize, shnum as usize);
                if shentsize >= 64 {
                    for i in 0..shnum {
                        let o = shoff + i * shentsize;
                        if read_u32_le(buf, o + 4) == Some(SHT_RELA) {
                            if let (Some(off), Some(sz)) =
                                (read_u64_le(buf, o + 24), read_u64_le(buf, o + 32))
                            {
                                img.rela_ranges.push((off, sz));
                            }
                        }
                    }
                }
            }
        }

        if img.rela_ranges.is_empty() {
            return Err("ELF 中未找到 .rela 重定位表，无法还原 embed.FS 指针".to_string());
        }
        Ok(img)
    }

    pub fn off_to_va(&self, off: u64) -> Option<u64> {
        for s in &self.segs {
            if off >= s.file_off && off < s.file_off + s.file_size {
                return Some(s.vaddr + (off - s.file_off));
            }
        }
        None
    }

    pub fn va_to_off(&self, va: u64) -> Option<u64> {
        for s in &self.segs {
            if va >= s.vaddr && va < s.vaddr + s.file_size {
                return Some(s.file_off + (va - s.vaddr));
            }
        }
        None
    }

    fn u64_at(&self, buf: &[u8], va: u64) -> Option<u64> {
        let off = self.va_to_off(va)? as usize;
        read_u64_le(buf, off)
    }

    fn bytes_at<'a>(&self, buf: &'a [u8], va: u64, len: usize) -> Option<&'a [u8]> {
        let off = self.va_to_off(va)? as usize;
        if off + len > buf.len() {
            return None;
        }
        Some(&buf[off..off + len])
    }

    /// 遍历所有 RELA 条目，回调 (RELA 记录自身的文件偏移, r_offset 所在 VA, r_addend)
    fn for_each_reloc<F: FnMut(usize, u64, u64)>(&self, buf: &[u8], mut f: F) {
        for (start, size) in &self.rela_ranges {
            let n = (*size / 24) as usize;
            let base = *start as usize;
            for i in 0..n {
                let o = base + i * 24;
                let (Some(loc), Some(addend)) = (read_u64_le(buf, o), read_u64_le(buf, o + 16))
                else {
                    break;
                };
                f(o, loc, addend);
            }
        }
    }
}

/// 解析 ELF 版 agy 内嵌的全部 `system_prompts/` 模板槽位
pub fn parse_elf_embed_templates(buf: &[u8]) -> Result<BTreeMap<String, TemplateSlot>, String> {
    let img = ElfImage::parse(buf)?;

    let anchor = format!("{}system_prompts/identity.tmpl", FULL_PREFIX);
    let anchor_len = anchor.len() as u64;
    let anchor_off = find_subslice(buf, anchor.as_bytes())
        .ok_or_else(|| "ELF 中找不到 identity.tmpl 路径字符串".to_string())?;
    let anchor_va = img
        .off_to_va(anchor_off as u64)
        .ok_or_else(|| "identity.tmpl 文件偏移无法映射到 VA".to_string())?;

    // 1) 找到 name 指针指向 identity.tmpl 的 embed.FS 条目
    let mut entry_locs: Vec<u64> = Vec::new();
    img.for_each_reloc(buf, |_, loc, addend| {
        if addend == anchor_va && img.u64_at(buf, loc + 8) == Some(anchor_len) {
            entry_locs.push(loc);
        }
    });
    if entry_locs.is_empty() {
        return Err("ELF 中找不到 identity.tmpl 的 embed.FS 条目".to_string());
    }
    let loc0 = entry_locs[0];

    // 2) 仅收集条目表附近窗口的重定位，避免为百万级重定位建立全量映射
    let span = (ENTRY_STRIDE * 160) as u64;
    let lo = loc0.saturating_sub(span);
    let hi = loc0 + span;
    // 值 = (addend / 即 data 指针 VA, RELA 记录文件偏移 —— 改写 addend 即可重定位指针)
    let mut local: BTreeMap<u64, (u64, usize)> = BTreeMap::new();
    img.for_each_reloc(buf, |rec, loc, addend| {
        if loc >= lo && loc <= hi {
            local.insert(loc, (addend, rec));
        }
    });

    let slot_name_at = |loc: u64| -> Option<(String, u64)> {
        let name_va = local.get(&loc)?.0;
        let name_len = img.u64_at(buf, loc + 8)?;
        if name_len == 0 || name_len > 512 {
            return None;
        }
        let raw = img.bytes_at(buf, name_va, name_len as usize)?;
        let name = std::str::from_utf8(raw).ok()?.to_string();
        if !name.starts_with(FULL_PREFIX) {
            return None;
        }
        Some((name, name_len))
    };

    // 3) 反向对齐到条目表起点
    let mut start = loc0;
    while let Some(prev) = start.checked_sub(ENTRY_STRIDE as u64) {
        if prev < lo || slot_name_at(prev).is_none() {
            break;
        }
        start = prev;
    }

    // 4) 正向遍历整张表（目录条目 data 指针为空，跳过但继续）
    let mut templates = BTreeMap::new();
    let mut loc = start;
    while loc <= hi {
        let Some((full_name, _)) = slot_name_at(loc) else {
            break;
        };
        let data_len = img.u64_at(buf, loc + 24).unwrap_or(0);
        let data_ptr = local.get(&(loc + 16)).copied();
        if let (Some((data_va, data_reloc)), true) = (data_ptr, data_len > 0) {
            if let Some(data_off) = img.va_to_off(data_va) {
                let (data_off, data_len) = (data_off as usize, data_len as usize);
                if data_off + data_len <= buf.len() && full_name.starts_with(SYS_PREFIX) {
                    // 与 PE 路径保持一致：槽位键保留 `system_prompts/` 前缀
                    let short_name = full_name
                        .strip_prefix(FULL_PREFIX)
                        .unwrap_or(&full_name)
                        .to_string();
                    let raw_str = String::from_utf8_lossy(&buf[data_off..data_off + data_len]);
                    let (active_bytes, is_stripped) = compute_active_bytes(&raw_str);
                    let is_modified = active_bytes != data_len;
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
                            // 注意：embed 条目表位于 `VA = 文件偏移 + 段内偏移` 的可写段，
                            // 这里必须换算成文件偏移，否则改写 data_len 会写到 2MB 之外的另一条目上。
                            entry_offset: img.va_to_off(loc).unwrap_or(loc) as usize,
                            data_offset: data_off,
                            data_length: data_len,
                            data_va,
                            data_reloc_offset: Some(data_reloc),
                            active_bytes,
                            is_stripped,
                            is_modified,
                            preview: if is_stripped {
                                "[STRIPPED 0B — {{/* ... */}}]".to_string()
                            } else {
                                preview_slice.replace('\n', " ")
                            },
                            content,
                        },
                    );
                }
            }
        }
        loc += ENTRY_STRIDE as u64;
    }

    if templates.is_empty() {
        return Err("ELF 中未解析出任何 system_prompts 模板槽位".to_string());
    }
    Ok(templates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_elf() {
        assert!(!is_elf64_le(b"MZ\x90\x00"));
        assert!(ElfImage::parse(b"MZ\x90\x00").is_err());
    }

    #[test]
    fn rejects_truncated_elf() {
        let mut fake = vec![0u8; 128];
        fake[0..4].copy_from_slice(b"\x7fELF");
        fake[4] = 2;
        fake[5] = 1;
        assert!(is_elf64_le(&fake));
        assert!(ElfImage::parse(&fake).is_err());
    }
}

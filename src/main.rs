mod asar;
mod gui;
mod injector;
mod patcher;
mod presets;

use eframe::egui;
use gui::AgyToolApp;
use injector::{
    hot_inject_via_cdp, hot_remove_via_cdp, inspect_hud_state, install_composer_hud,
    restore_stock_asar,
};
use patcher::{execute_patch_operations, inspect_all_binaries, ContextMode, PromptPatch};
use presets::{discover_presets, match_binary_to_preset, resolve_preset};

fn print_cli_status() {
    let presets = discover_presets();
    println!("=========================================================================");
    println!(" AGY-TOOL // Antigravity 二进制与底部 Composer HUD 状态扫描");
    println!("=========================================================================");
    for bin in inspect_all_binaries() {
        println!("\n▶ {}", bin.label);
        println!("  路径: {}", bin.path.display());
        if !bin.exists {
            println!("  [未安装] 未找到该二进制文件，跳过。");
            continue;
        }
        println!(
            "  备份: {}",
            if bin.bak_exists {
                "已存在 (.bak)"
            } else {
                "尚未创建 (首次修改时自动备份)"
            }
        );
        let matched = match_binary_to_preset(&bin.slots, &presets).map(|p| p.name.as_str());
        println!("  提示词状态: {}", bin.prompt_status_label(matched));
        println!(
            "  embed.FS 容量: {:.1} KB 有效 / {:.1} KB 总计 ({} 个模板槽位)",
            bin.active_slot_bytes as f64 / 1024.0,
            bin.total_slot_capacity as f64 / 1024.0,
            bin.slots.len()
        );
        for g in &bin.context_gates {
            println!(
                "  上下文门禁: [{}] ({} @0x{:X})",
                g.mode.label(),
                g.desc,
                g.offset
            );
        }
    }

    let hud = inspect_hud_state();
    println!("\n▶ Antigravity Desktop 前端包 (app.asar)");
    println!("  路径: {}", hud.asar_path.display());
    println!("  版本: {}", if hud.app_version.is_empty() { "-" } else { &hud.app_version });
    println!("  状态: {}", hud.state.label());
    println!(
        "  CDP 端口: {}",
        hud.cdp_port
            .map(|p| format!("127.0.0.1:{} (在线)", p))
            .unwrap_or_else(|| "未检测到活动端口".to_string())
    );
    println!();
}

fn print_help() {
    println!(
        "\
AGY-TOOL v1.0 — Antigravity (Gemini 4 Argon) 提示词精简、百万上下文解锁与底部 HUD 工具箱

用法:
  agy-tool.exe                                  # 启动独立轻量高密度 GUI 面板 (默认)
  agy-tool.exe --status | --inspect             # 只读扫描本机二进制与 HUD 状态
  agy-tool.exe --prompt <preset|restore>        # 应用 presets/ 下的预设目录，或 restore 还原官方原版
  agy-tool.exe --context <512k|900k|restore>    # 单独切换上下文窗口门禁档位
  agy-tool.exe --inject-hud                     # 注入底部 Request Review 左侧 HUD (自动清理旧版顶栏)
  agy-tool.exe --hot-hud                        # 仅通过 CDP 向运行中窗口实时热注入底部 HUD
  agy-tool.exe --restore-hud                    # 卸载 HUD 并还原官方纯净 app.asar
  agy-tool.exe --full                           # 解锁 900K 上下文 + 底部 HUD (可配合 --prompt)
  agy-tool.exe --restore                        # 一键全部恢复官方默认状态"
    );
}

fn launch_gui(dump_ui_path: Option<String>) -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("AGY-TOOL — Antigravity 提示词精简、上下文解锁与状态栏工具")
            .with_inner_size([1080.0, 840.0])
            .with_min_inner_size([920.0, 680.0]),
        ..Default::default()
    };
    eframe::run_native(
        "agy-tool",
        options,
        Box::new(move |cc| Ok(Box::new(AgyToolApp::new(cc, dump_ui_path)))),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || (args.len() == 1 && args[0] == "--gui") {
        if let Err(e) = launch_gui(None) {
            eprintln!("GUI 启动失败: {}", e);
            std::process::exit(1);
        }
        return;
    }
    if args.len() == 2 && args[0] == "--dump-ui" {
        let _ = launch_gui(Some(args[1].clone()));
        return;
    }

    let mut inspect_only = false;
    let mut full_restore = false;
    let mut full_recommended = false;
    let mut preset_query: Option<String> = None;
    let mut restore_all_prompts = false;
    let mut context_mode: Option<ContextMode> = None;
    let mut do_inject_hud = false;
    let mut do_hot_hud = false;
    let mut do_restore_hud = false;

    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "--help" | "-h" => {
                print_help();
                return;
            }
            "--inspect" | "-i" | "--status" => {
                inspect_only = true;
            }
            "--restore" | "--reset" => {
                full_restore = true;
            }
            "--full" | "--recommended" => {
                full_recommended = true;
            }
            "--inject-hud" | "--hud" => {
                do_inject_hud = true;
            }
            "--hot-hud" => {
                do_hot_hud = true;
            }
            "--restore-hud" => {
                do_restore_hud = true;
            }
            "--prompt" | "-p" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    if matches!(
                        val.trim().to_ascii_lowercase().as_str(),
                        "0" | "restore" | "stock" | "reset"
                    ) {
                        restore_all_prompts = true;
                    } else {
                        preset_query = Some(val.clone());
                    }
                }
            }
            "--context" | "-c" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    context_mode = ContextMode::from_cli_str(val);
                    if context_mode.is_none() {
                        eprintln!("无效的 --context 参数: {}", val);
                        std::process::exit(1);
                    }
                }
            }
            _ if a.starts_with("--prompt=") => {
                let val = &a["--prompt=".len()..];
                if matches!(
                    val.trim().to_ascii_lowercase().as_str(),
                    "0" | "restore" | "stock" | "reset"
                ) {
                    restore_all_prompts = true;
                } else {
                    preset_query = Some(val.to_string());
                }
            }
            _ if a.starts_with("--context=") => {
                let val = &a["--context=".len()..];
                context_mode = ContextMode::from_cli_str(val);
            }
            _ => {
                eprintln!("未知参数: {} (使用 --help 查看帮助)", a);
                std::process::exit(1);
            }
        }
        i += 1;
    }

    if inspect_only {
        print_cli_status();
        return;
    }

    let mut prompt_patch: Option<PromptPatch> = None;

    if full_recommended {
        context_mode = Some(ContextMode::Unlock900K);
        do_inject_hud = true;
    }

    if full_restore {
        restore_all_prompts = true;
        context_mode = Some(ContextMode::Stock);
        do_restore_hud = true;
    }

    if restore_all_prompts {
        prompt_patch = Some(PromptPatch::stock());
    } else if let Some(q) = preset_query {
        match resolve_preset(&q) {
            Ok(p) => prompt_patch = Some(p.to_patch()),
            Err(e) => {
                eprintln!("✖ {}", e);
                std::process::exit(1);
            }
        }
    }

    if prompt_patch.is_some() || context_mode.is_some() {
        match execute_patch_operations(prompt_patch.as_ref(), context_mode) {
            Ok(logs) => {
                for l in logs {
                    println!("{}", l);
                }
            }
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    if do_inject_hud {
        if full_recommended && !inspect_hud_state().asar_exists {
            println!("ℹ 未检测到桌面版客户端 (app.asar)，已跳过桌面状态栏注入。");
        } else {
            match install_composer_hud() {
                Ok(logs) => {
                    for l in logs {
                        println!("{}", l);
                    }
                }
                Err(e) => {
                    eprintln!("✖ HUD 注入失败: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    if do_hot_hud {
        match hot_inject_via_cdp() {
            Ok(n) => println!(
                "⚡ CDP 实时热替换完成，已在 {} 个窗口清理旧版顶栏并挂载底部 Request Review 左侧 HUD。",
                n
            ),
            Err(e) => {
                eprintln!("✖ CDP 热注入失败: {}", e);
                std::process::exit(1);
            }
        }
    }

    if do_restore_hud {
        if full_restore && !inspect_hud_state().asar_exists {
            println!("ℹ 未检测到桌面版客户端 (app.asar)，已跳过 app.asar 还原。");
        } else {
            match restore_stock_asar() {
                Ok(logs) => {
                    for l in logs {
                        println!("{}", l);
                    }
                }
                Err(e) => {
                    eprintln!("✖ 还原 app.asar 失败: {}", e);
                    std::process::exit(1);
                }
            }
            let _ = hot_remove_via_cdp();
        }
    }
}

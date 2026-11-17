use crate::injector::{
    detect_active_cdp_port, hot_inject_via_cdp, hot_remove_via_cdp, inspect_hud_state,
    install_composer_hud, restore_stock_asar, set_hud_ctx_text_via_cdp, HudInspection,
    HudInstallState,
};
use crate::patcher::{
    check_running_processes, display_slot_name, execute_patch_operations, inspect_all_binaries,
    kill_language_servers, local_appdata_dir, BinaryInspection, ContextMode, ProcessStatus,
    PromptPatch, TemplateSlot,
};
use crate::plugins::{
    detect_node, detect_pi_ecosystem, inspect_all_plugins, install_all_plugins, install_plugin,
    plugins_root_dir, run_plugin_smoke_checks, toggle_plugin_enabled, uninstall_all_plugins,
    uninstall_plugin, NodeDetection, PiEcosystemStatus, PluginId, PluginInspection,
};
use crate::presets::{discover_presets, match_binary_to_preset, PromptPreset};
use eframe::egui::{
    self, Align, Color32, CursorIcon, FontData, FontDefinitions, FontFamily, FontId, Layout,
    Margin, Pos2, Rect, RichText, Rounding, Sense, Stroke, Vec2,
};
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

// ============================================================================
// 日间浅色主题调色板（避免纯白 #FFF 刺眼眩光与纯黑 #000）
// ============================================================================
const BG_APP: Color32 = Color32::from_rgb(243, 245, 249);
const BG_PANEL: Color32 = Color32::from_rgb(252, 253, 255);
const BG_SUBTLE: Color32 = Color32::from_rgb(241, 245, 249);
const BG_HOVER: Color32 = Color32::from_rgb(226, 232, 240);
const BORDER_LINE: Color32 = Color32::from_rgb(209, 217, 228);
const BORDER_HOVER: Color32 = Color32::from_rgb(148, 163, 184);

const FG_MAIN: Color32 = Color32::from_rgb(15, 23, 42);
const FG_SUB: Color32 = Color32::from_rgb(51, 65, 85);
const FG_MUTED: Color32 = Color32::from_rgb(100, 116, 139);

const ACCENT_BLUE: Color32 = Color32::from_rgb(2, 132, 199);
const ACCENT_INDIGO: Color32 = Color32::from_rgb(79, 70, 229);
const ACCENT_GREEN: Color32 = Color32::from_rgb(5, 150, 105);
const ACCENT_AMBER: Color32 = Color32::from_rgb(217, 119, 6);
const ACCENT_RED: Color32 = Color32::from_rgb(220, 38, 38);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainTab {
    ComplianceHub,
    LegacyBinaryPatch,
}

pub enum WorkerEvent {
    Log(String),
    FullState {
        binaries: Vec<BinaryInspection>,
        presets: Vec<PromptPreset>,
        hud: HudInspection,
        proc_status: ProcessStatus,
        plugins: Vec<PluginInspection>,
        node: NodeDetection,
        pi: PiEcosystemStatus,
        init_select: bool,
    },
    LightTick {
        proc_status: ProcessStatus,
        cdp_port: Option<u16>,
    },
    TaskFinished,
}

pub struct AgyToolApp {
    pub active_tab: MainTab,
    pub binaries: Vec<BinaryInspection>,
    pub presets: Vec<PromptPreset>,
    pub selected_preset_idx: Option<usize>,
    pub hud: HudInspection,
    pub proc_status: ProcessStatus,
    pub plugins: Vec<PluginInspection>,
    pub node_info: NodeDetection,
    pub pi_info: PiEcosystemStatus,
    pub selected_context_mode: ContextMode,
    pub selected_binary_tab: usize,
    pub show_slot_table: bool,
    pub hud_show_ctx_text: bool,
    pub logs: Vec<String>,
    pub busy: bool,
    pub busy_label: String,
    pub dump_ui_path: Option<String>,
    frame_count: u32,
    tx: Sender<WorkerEvent>,
    rx: Receiver<WorkerEvent>,
    last_proc_poll: Instant,
    tick_in_flight: bool,
}

impl AgyToolApp {
    pub fn new(cc: &eframe::CreationContext<'_>, dump_ui_path: Option<String>) -> Self {
        setup_fonts(&cc.egui_ctx);
        setup_daylight_visuals(&cc.egui_ctx);

        let (tx, rx) = mpsc::channel();
        let placeholder_hud = HudInspection {
            asar_path: local_appdata_dir()
                .join("Programs")
                .join("antigravity")
                .join("resources")
                .join("app.asar"),
            bak_path: PathBuf::new(),
            asar_exists: true,
            bak_exists: false,
            app_version: "扫描中…".to_string(),
            state: HudInstallState::Stock,
            cdp_port: None,
            error: None,
        };

        let is_dump = dump_ui_path.is_some();
        let mut app = Self {
            active_tab: MainTab::ComplianceHub,
            binaries: Vec::new(),
            presets: Vec::new(),
            selected_preset_idx: None,
            hud: placeholder_hud,
            proc_status: ProcessStatus::default(),
            plugins: Vec::new(),
            node_info: NodeDetection {
                in_path: false,
                resolved_path: None,
                version: None,
            },
            pi_info: PiEcosystemStatus {
                has_pi_dir: false,
                has_fast_context: false,
                has_pi_search: false,
                has_devin_search: false,
                has_jiti: false,
            },
            selected_context_mode: ContextMode::Unlock900K,
            selected_binary_tab: 0,
            show_slot_table: false,
            hud_show_ctx_text: false,
            logs: Vec::new(),
            busy: true,
            busy_label: "正在后台扫描合规插件与本机环境…".to_string(),
            dump_ui_path,
            frame_count: 0,
            tx,
            rx,
            last_proc_poll: Instant::now(),
            tick_in_flight: false,
        };

        if is_dump {
            let binaries = inspect_all_binaries();
            let presets = discover_presets();
            let hud = inspect_hud_state();
            let proc_status = check_running_processes();
            let node = detect_node();
            let plugins = inspect_all_plugins(&node);
            let pi = detect_pi_ecosystem();
            app.apply_full_state(binaries, presets, hud, proc_status, plugins, node, pi, true);
            app.busy = false;
            app.busy_label.clear();
            app.append_log("已扫描 Antigravity 合规插件目录、Node.js 与内核状态。");
        } else {
            app.spawn_refresh(cc.egui_ctx.clone(), true);
        }

        app
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_full_state(
        &mut self,
        binaries: Vec<BinaryInspection>,
        presets: Vec<PromptPreset>,
        hud: HudInspection,
        proc_status: ProcessStatus,
        plugins: Vec<PluginInspection>,
        node: NodeDetection,
        pi: PiEcosystemStatus,
        init_select: bool,
    ) {
        if init_select {
            if let Some((idx, b)) = binaries.iter().enumerate().find(|(_, b)| b.exists) {
                self.selected_binary_tab = idx;
                if let Some(matched) = match_binary_to_preset(&b.slots, &presets) {
                    self.selected_preset_idx = presets.iter().position(|p| p.name == matched.name);
                } else {
                    self.selected_preset_idx = None;
                }
                let m = b.effective_context_mode();
                self.selected_context_mode = if m == ContextMode::Stock {
                    ContextMode::Unlock900K
                } else {
                    m
                };
            }
        } else {
            if self.selected_binary_tab >= binaries.len() && !binaries.is_empty() {
                self.selected_binary_tab = 0;
            }
            if let Some(p_idx) = self.selected_preset_idx {
                if p_idx >= presets.len() {
                    self.selected_preset_idx = None;
                }
            }
        }
        self.binaries = binaries;
        self.presets = presets;
        self.hud = hud;
        self.proc_status = proc_status;
        self.plugins = plugins;
        self.node_info = node;
        self.pi_info = pi;
    }

    fn append_log(&mut self, msg: impl Into<String>) {
        let s = msg.into();
        for line in s.lines() {
            if !line.trim().is_empty() {
                self.logs.push(line.to_string());
            }
        }
    }

    fn spawn_refresh(&mut self, egui_ctx: egui::Context, init_select: bool) {
        self.busy = true;
        self.busy_label = "正在后台刷新状态…".to_string();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let binaries = inspect_all_binaries();
            let presets = discover_presets();
            let hud = inspect_hud_state();
            let proc_status = check_running_processes();
            let node = detect_node();
            let plugins = inspect_all_plugins(&node);
            let pi = detect_pi_ecosystem();
            let _ = tx.send(WorkerEvent::FullState {
                binaries,
                presets,
                hud,
                proc_status,
                plugins,
                node,
                pi,
                init_select,
            });
            if init_select {
                let _ = tx.send(WorkerEvent::Log(
                    "✔ 已完成合规插件、Node/Pi 生态与内核状态扫描。".to_string(),
                ));
            }
            let _ = tx.send(WorkerEvent::TaskFinished);
            egui_ctx.request_repaint();
        });
    }

    fn spawn_light_tick(&mut self, egui_ctx: egui::Context) {
        if self.tick_in_flight || self.busy {
            return;
        }
        self.tick_in_flight = true;
        self.last_proc_poll = Instant::now();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let proc_status = check_running_processes();
            let cdp_port = detect_active_cdp_port();
            let _ = tx.send(WorkerEvent::LightTick {
                proc_status,
                cdp_port,
            });
            egui_ctx.request_repaint();
        });
    }

    fn spawn_task<F>(&mut self, egui_ctx: egui::Context, label: &str, job: F)
    where
        F: FnOnce(&Sender<WorkerEvent>) + Send + 'static,
    {
        if self.busy {
            return;
        }
        self.busy = true;
        self.busy_label = label.to_string();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            job(&tx);
            let binaries = inspect_all_binaries();
            let presets = discover_presets();
            let hud = inspect_hud_state();
            let proc_status = check_running_processes();
            let node = detect_node();
            let plugins = inspect_all_plugins(&node);
            let pi = detect_pi_ecosystem();
            let _ = tx.send(WorkerEvent::FullState {
                binaries,
                presets,
                hud,
                proc_status,
                plugins,
                node,
                pi,
                init_select: false,
            });
            let _ = tx.send(WorkerEvent::TaskFinished);
            egui_ctx.request_repaint();
        });
    }

    fn run_install_all_plugins_async(&mut self, egui_ctx: egui::Context) {
        let node = self.node_info.clone();
        self.spawn_task(egui_ctx, "正在部署并自检 4 个合规插件…", move |tx| {
            let _ = tx.send(WorkerEvent::Log(
                "=== 部署全部 4 个官方合规插件 (0 改二进制) ===".to_string(),
            ));
            match install_all_plugins(&node) {
                Ok(lines) => {
                    for l in lines {
                        let _ = tx.send(WorkerEvent::Log(l));
                    }
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::Log(format!("[错误] 安装插件失败: {}", e)));
                    return;
                }
            }
            for l in run_plugin_smoke_checks(&node) {
                let _ = tx.send(WorkerEvent::Log(l));
            }
        });
    }

    fn run_smoke_check_async(&mut self, egui_ctx: egui::Context) {
        let node = self.node_info.clone();
        self.spawn_task(egui_ctx, "正在实机冒烟测试插件 MCP 与 Hook…", move |tx| {
            let _ = tx.send(WorkerEvent::Log("=== 执行合规插件实机冒烟检测 ===".to_string()));
            for l in run_plugin_smoke_checks(&node) {
                let _ = tx.send(WorkerEvent::Log(l));
            }
        });
    }

    fn run_uninstall_all_plugins_async(&mut self, egui_ctx: egui::Context) {
        self.spawn_task(egui_ctx, "正在卸载全部合规插件…", move |tx| {
            let _ = tx.send(WorkerEvent::Log("=== 卸载全部合规插件 ===".to_string()));
            match uninstall_all_plugins() {
                Ok(lines) => {
                    for l in lines {
                        let _ = tx.send(WorkerEvent::Log(l));
                    }
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::Log(format!("[错误] 卸载失败: {}", e)));
                }
            }
        });
    }

    fn run_binary_patch_async(
        &mut self,
        egui_ctx: egui::Context,
        prompt: Option<PromptPatch>,
        ctx_mode: Option<ContextMode>,
    ) {
        self.spawn_task(egui_ctx, "正在后台写入内核补丁…", move |tx| {
            match execute_patch_operations(prompt.as_ref(), ctx_mode) {
                Ok(lines) => {
                    for l in lines {
                        let _ = tx.send(WorkerEvent::Log(l));
                    }
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::Log(format!("[错误] 修改失败: {}", e)));
                }
            }
        });
    }

    fn selected_prompt_patch(&self) -> Option<PromptPatch> {
        if let Some(idx) = self.selected_preset_idx {
            self.presets.get(idx).map(|p| p.to_patch())
        } else if !self.presets.is_empty() {
            Some(PromptPatch::stock())
        } else {
            None
        }
    }

    fn run_full_recommended_async(&mut self, egui_ctx: egui::Context) {
        self.selected_context_mode = ContextMode::Unlock900K;
        let prompt_patch = self.selected_prompt_patch();

        self.spawn_task(egui_ctx, "正在后台应用旧版推荐补丁…", move |tx| {
            match execute_patch_operations(prompt_patch.as_ref(), Some(ContextMode::Unlock900K)) {
                Ok(lines) => {
                    for l in lines {
                        let _ = tx.send(WorkerEvent::Log(l));
                    }
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::Log(format!("[错误] 内核修改失败: {}", e)));
                }
            }
            if inspect_hud_state().asar_exists {
                match install_composer_hud() {
                    Ok(lines) => {
                        for l in lines {
                            let _ = tx.send(WorkerEvent::Log(l));
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(WorkerEvent::Log(format!("[错误] 状态栏注入失败: {}", e)));
                    }
                }
            } else {
                let _ = tx.send(WorkerEvent::Log(
                    "  [HUD] 未检测到桌面客户端 (app.asar)，已跳过桌面状态栏注入".to_string(),
                ));
            }
        });
    }

    fn run_full_restore_async(&mut self, egui_ctx: egui::Context) {
        self.selected_preset_idx = None;
        self.spawn_task(egui_ctx, "正在后台恢复官方默认设置…", move |tx| {
            let _ = tx.send(WorkerEvent::Log(
                "=== 开始恢复官方默认设置 (还原提示词、上下文上限与 app.asar) ===".to_string(),
            ));
            let restore_patch = PromptPatch::stock();
            match execute_patch_operations(Some(&restore_patch), Some(ContextMode::Stock)) {
                Ok(lines) => {
                    for l in lines {
                        let _ = tx.send(WorkerEvent::Log(l));
                    }
                }
                Err(e) => {
                    let _ = tx.send(WorkerEvent::Log(format!("[错误] 还原失败: {}", e)));
                }
            }
            if inspect_hud_state().asar_exists {
                match restore_stock_asar() {
                    Ok(lines) => {
                        for l in lines {
                            let _ = tx.send(WorkerEvent::Log(l));
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(WorkerEvent::Log(format!("[错误] 还原 app.asar 失败: {}", e)));
                    }
                }
            } else {
                let _ = tx.send(WorkerEvent::Log(
                    "  [HUD] 未检测到桌面客户端 (app.asar)，已跳过 app.asar 还原".to_string(),
                ));
            }
        });
    }

    fn calc_preset_char_stats(&self, preset: Option<&PromptPreset>) -> (usize, usize, Option<String>) {
        let Some(bin) = self.binaries.get(self.selected_binary_tab) else {
            return (0, 0, None);
        };
        if bin.slots.is_empty() {
            return (0, 0, None);
        }
        let stock_total: usize = bin.slots.iter().map(|s| s.data_length).sum();
        let Some(p) = preset else {
            return (stock_total, 0, None);
        };

        let mut remain = 0usize;
        let mut overflow = None;
        for s in &bin.slots {
            if let Some(new_txt) = p.slots.get(&s.short_name) {
                if new_txt.len() > s.data_length && overflow.is_none() {
                    overflow = Some(format!(
                        "{} 超限 ({}B > {}B)",
                        display_slot_name(&s.short_name),
                        new_txt.len(),
                        s.data_length
                    ));
                }
                remain += new_txt.len();
            } else {
                remain += s.data_length;
            }
        }
        let saved = stock_total.saturating_sub(remain);
        (remain, saved, overflow)
    }
}

impl eframe::App for AgyToolApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                WorkerEvent::Log(line) => self.append_log(line),
                WorkerEvent::FullState {
                    binaries,
                    presets,
                    hud,
                    proc_status,
                    plugins,
                    node,
                    pi,
                    init_select,
                } => {
                    self.apply_full_state(
                        binaries,
                        presets,
                        hud,
                        proc_status,
                        plugins,
                        node,
                        pi,
                        init_select,
                    );
                }
                WorkerEvent::LightTick {
                    proc_status,
                    cdp_port,
                } => {
                    self.proc_status = proc_status;
                    self.hud.cdp_port = cdp_port;
                    self.tick_in_flight = false;
                }
                WorkerEvent::TaskFinished => {
                    self.busy = false;
                    self.busy_label.clear();
                }
            }
        }

        self.frame_count += 1;
        if let Some(ref path) = self.dump_ui_path {
            if self.frame_count == 2 {
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot);
            }
            let mut saved = false;
            ctx.input(|i| {
                for ev in &i.raw.events {
                    if let egui::Event::Screenshot { image, .. } = ev {
                        save_color_image_as_bmp(image, path);
                        saved = true;
                    }
                }
            });
            if saved || self.frame_count > 10 {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            ctx.request_repaint();
        }

        if self.last_proc_poll.elapsed() > Duration::from_secs(4) {
            self.spawn_light_tick(ctx.clone());
        }

        // 1. 顶部主标题与工作区切换栏
        egui::TopBottomPanel::top("top_header")
            .frame(
                egui::Frame::none()
                    .fill(BG_PANEL)
                    .inner_margin(Margin::symmetric(16.0, 9.0))
                    .stroke(Stroke::new(1.0_f32, BORDER_LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("AGY-TOOL v2.0")
                            .size(15.5)
                            .strong()
                            .color(ACCENT_BLUE),
                    );
                    ui.label(
                        RichText::new("Antigravity 合规增强中心与工具箱")
                            .size(12.0)
                            .color(FG_SUB),
                    );
                    if self.busy {
                        ui.add_space(6.0);
                        draw_badge(ui, &self.busy_label, ACCENT_BLUE);
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let refresh_btn = egui::Button::new(
                            RichText::new("↻ 刷新状态").size(11.5).color(FG_MAIN),
                        )
                        .fill(BG_SUBTLE)
                        .rounding(Rounding::same(5.0))
                        .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                        .min_size(Vec2::new(72.0, 24.0));
                        if ui.add_enabled(!self.busy, refresh_btn).clicked() {
                            self.spawn_refresh(ctx.clone(), false);
                        }

                        draw_badge(
                            ui,
                            &if let Some(p) = self.hud.cdp_port {
                                format!("调试端口 127.0.0.1:{}", p)
                            } else {
                                "客户端未连接".to_string()
                            },
                            if self.hud.cdp_port.is_some() {
                                ACCENT_GREEN
                            } else {
                                FG_MUTED
                            },
                        );

                        draw_badge(
                            ui,
                            if self.proc_status.language_server_running {
                                "内核运行中"
                            } else {
                                "内核未运行"
                            },
                            if self.proc_status.language_server_running {
                                ACCENT_BLUE
                            } else {
                                FG_MUTED
                            },
                        );
                    });
                });

                ui.add_space(7.0);

                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    let tab1_active = self.active_tab == MainTab::ComplianceHub;
                    let tab2_active = self.active_tab == MainTab::LegacyBinaryPatch;

                    let t1_btn = egui::Button::new(
                        RichText::new("✦ 合规插件中心 (0 改二进制 · 推荐)")
                            .size(12.0)
                            .strong()
                            .color(if tab1_active {
                                Color32::from_rgb(250, 252, 255)
                            } else {
                                FG_SUB
                            }),
                    )
                    .fill(if tab1_active { ACCENT_BLUE } else { BG_SUBTLE })
                    .rounding(Rounding::same(6.0))
                    .stroke(Stroke::new(
                        1.0_f32,
                        if tab1_active { ACCENT_BLUE } else { BORDER_LINE },
                    ))
                    .min_size(Vec2::new(230.0, 28.0));
                    if ui.add(t1_btn).clicked() {
                        self.active_tab = MainTab::ComplianceHub;
                    }

                    let t2_btn = egui::Button::new(
                        RichText::new("⚠ 旧版高风险区 (presets 提示词 / 上下文)")
                            .size(11.5)
                            .strong()
                            .color(if tab2_active {
                                Color32::from_rgb(250, 252, 255)
                            } else {
                                ACCENT_AMBER
                            }),
                    )
                    .fill(if tab2_active {
                        ACCENT_AMBER
                    } else {
                        Color32::from_rgba_unmultiplied(217, 119, 6, 14)
                    })
                    .rounding(Rounding::same(6.0))
                    .stroke(Stroke::new(
                        1.0_f32,
                        if tab2_active {
                            ACCENT_AMBER
                        } else {
                            Color32::from_rgba_unmultiplied(217, 119, 6, 80)
                        },
                    ))
                    .min_size(Vec2::new(260.0, 28.0));
                    if ui.add(t2_btn).clicked() {
                        self.active_tab = MainTab::LegacyBinaryPatch;
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let active_cnt =
                            self.plugins.iter().filter(|p| p.installed && p.enabled).count();
                        draw_badge(
                            ui,
                            &format!("合规插件已启用 {}/{}", active_cnt, PluginId::ALL.len()),
                            if active_cnt == PluginId::ALL.len() {
                                ACCENT_GREEN
                            } else if active_cnt > 0 {
                                ACCENT_BLUE
                            } else {
                                FG_MUTED
                            },
                        );
                    });
                });
            });

        // 2. 底部操作日志栏
        egui::TopBottomPanel::bottom("bottom_logs")
            .resizable(true)
            .default_height(130.0)
            .min_height(72.0)
            .frame(
                egui::Frame::none()
                    .fill(BG_PANEL)
                    .inner_margin(Margin::symmetric(16.0, 6.0))
                    .stroke(Stroke::new(1.0_f32, BORDER_LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("操作日志")
                            .size(11.0)
                            .strong()
                            .color(FG_MUTED),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui
                            .small_button(RichText::new("清空").size(10.5).color(FG_SUB))
                            .clicked()
                        {
                            self.logs.clear();
                        }
                    });
                });
                ui.add_space(2.0);
                egui::ScrollArea::vertical()
                    .stick_to_bottom(true)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        for line in &self.logs {
                            let color = if line.contains("[错误]")
                                || line.contains("[ERROR]")
                                || line.contains("✖")
                            {
                                ACCENT_RED
                            } else if line.contains("⚠") {
                                ACCENT_AMBER
                            } else if line.contains("✔")
                                || line.contains("[SUCCESS]")
                                || line.contains("⚡")
                            {
                                ACCENT_GREEN
                            } else if line.starts_with("===") || line.starts_with("▶") {
                                ACCENT_BLUE
                            } else {
                                FG_SUB
                            };
                            ui.label(
                                RichText::new(line)
                                    .font(FontId::new(11.0, FontFamily::Monospace))
                                    .color(color),
                            );
                        }
                    });
            });

        // 3. 中央主面板
        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(BG_APP)
                    .inner_margin(Margin::symmetric(16.0, 10.0)),
            )
            .show(ctx, |ui| {
                let egui_ctx = ctx.clone();
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| match self.active_tab {
                        MainTab::ComplianceHub => {
                            self.render_compliance_hub(ui, &egui_ctx);
                        }
                        MainTab::LegacyBinaryPatch => {
                            self.render_legacy_binary_view(ui, &egui_ctx);
                        }
                    });
            });
    }
}

impl AgyToolApp {
    fn render_compliance_hub(&mut self, ui: &mut egui::Ui, egui_ctx: &egui::Context) {
        panel_card().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("官方标准插件体系 (~/.gemini/config/plugins/)")
                        .size(12.5)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.label(
                    RichText::new("  ·  零修改二进制，支持三端热加载")
                        .size(11.0)
                        .color(FG_MUTED),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let uninst_all = egui::Button::new(
                        RichText::new("全部卸载").size(11.5).color(ACCENT_RED),
                    )
                    .fill(BG_SUBTLE)
                    .rounding(Rounding::same(5.0))
                    .stroke(Stroke::new(
                        1.0_f32,
                        Color32::from_rgba_unmultiplied(220, 38, 38, 90),
                    ))
                    .min_size(Vec2::new(78.0, 26.0));
                    if ui.add_enabled(!self.busy, uninst_all).clicked() {
                        self.run_uninstall_all_plugins_async(egui_ctx.clone());
                    }

                    let check_btn = egui::Button::new(
                        RichText::new("实机冒烟自检").size(11.5).color(ACCENT_INDIGO),
                    )
                    .fill(Color32::from_rgba_unmultiplied(79, 70, 229, 14))
                    .rounding(Rounding::same(5.0))
                    .stroke(Stroke::new(1.0_f32, ACCENT_INDIGO))
                    .min_size(Vec2::new(104.0, 26.0));
                    if ui.add_enabled(!self.busy, check_btn).clicked() {
                        self.run_smoke_check_async(egui_ctx.clone());
                    }

                    let install_all = egui::Button::new(
                        RichText::new("一键部署并启用全部 4 个插件")
                            .size(11.5)
                            .strong()
                            .color(Color32::from_rgb(250, 252, 255)),
                    )
                    .fill(ACCENT_GREEN)
                    .rounding(Rounding::same(5.0))
                    .min_size(Vec2::new(196.0, 26.0));
                    if ui.add_enabled(!self.busy, install_all).clicked() {
                        self.run_install_all_plugins_async(egui_ctx.clone());
                    }
                });
            });
        });

        ui.add_space(8.0);

        let avail = ui.available_width();
        let left_w = (avail * 0.59).floor();
        let right_w = (avail - left_w - 10.0).max(300.0);

        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;

            ui.allocate_ui_with_layout(
                Vec2::new(left_w, 0.0),
                Layout::top_down(Align::Min),
                |ui| {
                    let plugins_snapshot = self.plugins.clone();
                    let node_snapshot = self.node_info.clone();

                    for p in plugins_snapshot {
                        self.render_plugin_card(ui, egui_ctx, &p, &node_snapshot);
                        ui.add_space(7.0);
                    }
                },
            );

            ui.allocate_ui_with_layout(
                Vec2::new(right_w, 0.0),
                Layout::top_down(Align::Min),
                |ui| {
                    self.render_env_and_pi_card(ui);
                    ui.add_space(8.0);
                    self.render_section_04_hud(ui, egui_ctx);
                },
            );
        });
    }

    fn render_plugin_card(
        &mut self,
        ui: &mut egui::Ui,
        egui_ctx: &egui::Context,
        p: &PluginInspection,
        node: &NodeDetection,
    ) {
        let border_col = if p.installed && p.enabled {
            ACCENT_GREEN
        } else if p.installed {
            ACCENT_AMBER
        } else {
            BORDER_LINE
        };

        egui::Frame::none()
            .fill(BG_PANEL)
            .rounding(Rounding::same(7.0))
            .inner_margin(Margin::symmetric(12.0, 9.0))
            .stroke(Stroke::new(
                if p.installed && p.enabled { 1.3_f32 } else { 1.0_f32 },
                border_col,
            ))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(p.id.title())
                            .size(12.5)
                            .strong()
                            .color(FG_MAIN),
                    );
                    ui.label(
                        RichText::new(format!("({})", p.dir_name))
                            .font(FontId::new(11.0, FontFamily::Monospace))
                            .color(FG_MUTED),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let (badge_txt, badge_col) = if !p.installed {
                            ("未安装", FG_MUTED)
                        } else if !p.files_match {
                            ("需更新覆盖", ACCENT_AMBER)
                        } else if p.enabled {
                            ("已启用 · 最新", ACCENT_GREEN)
                        } else {
                            ("已停用", ACCENT_AMBER)
                        };
                        draw_badge(ui, badge_txt, badge_col);
                    });
                });

                ui.add_space(3.0);
                ui.label(RichText::new(p.id.subtitle()).size(11.0).color(FG_SUB));
                ui.add_space(6.0);

                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(match p.id {
                            PluginId::Codemode => "MCP: codemode, batch_reads  |  Rules: AGENTS.md",
                            PluginId::OutputGuard => "Hook: PostToolUse (overwriteResult 转存指针)",
                            PluginId::Rehydrate => "Hook: PreInvocation (4层回水 + /fork 祖先拼接)",
                            PluginId::PiBridge => "Agents: oracle, librarian, worker, frontend-*  |  MCP 桥接",
                        })
                        .font(FontId::new(10.5, FontFamily::Monospace))
                        .color(FG_MUTED),
                    );

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if p.installed {
                            let del_btn = egui::Button::new(
                                RichText::new("卸载").size(11.0).color(FG_SUB),
                            )
                            .fill(BG_SUBTLE)
                            .rounding(Rounding::same(4.0))
                            .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                            .min_size(Vec2::new(46.0, 23.0));
                            if ui.add_enabled(!self.busy, del_btn).clicked() {
                                let pid = p.id;
                                self.spawn_task(egui_ctx.clone(), "正在卸载插件…", move |tx| {
                                    match uninstall_plugin(pid) {
                                        Ok(lines) => {
                                            for l in lines {
                                                let _ = tx.send(WorkerEvent::Log(l));
                                            }
                                        }
                                        Err(e) => {
                                            let _ = tx.send(WorkerEvent::Log(format!("[错误] {}", e)));
                                        }
                                    }
                                });
                            }
                        }

                        if p.installed && !p.files_match {
                            let upd_btn = egui::Button::new(
                                RichText::new("更新文件").size(11.0).color(ACCENT_AMBER),
                            )
                            .fill(Color32::from_rgba_unmultiplied(217, 119, 6, 16))
                            .rounding(Rounding::same(4.0))
                            .stroke(Stroke::new(1.0_f32, ACCENT_AMBER))
                            .min_size(Vec2::new(66.0, 23.0));
                            if ui.add_enabled(!self.busy, upd_btn).clicked() {
                                let pid = p.id;
                                let node_c = node.clone();
                                self.spawn_task(egui_ctx.clone(), "正在更新插件文件…", move |tx| {
                                    match install_plugin(pid, &node_c) {
                                        Ok(lines) => {
                                            for l in lines {
                                                let _ = tx.send(WorkerEvent::Log(l));
                                            }
                                        }
                                        Err(e) => {
                                            let _ = tx.send(WorkerEvent::Log(format!("[错误] {}", e)));
                                        }
                                    }
                                });
                            }
                        }

                        let (act_txt, act_fill, act_fg) = if !p.installed {
                            ("安装并启用", ACCENT_BLUE, Color32::from_rgb(250, 252, 255))
                        } else if p.enabled {
                            ("停用", BG_SUBTLE, ACCENT_AMBER)
                        } else {
                            ("启用", ACCENT_GREEN, Color32::from_rgb(250, 252, 255))
                        };

                        let toggle_btn = egui::Button::new(
                            RichText::new(act_txt).size(11.0).strong().color(act_fg),
                        )
                        .fill(act_fill)
                        .rounding(Rounding::same(4.0))
                        .stroke(Stroke::new(
                            1.0_f32,
                            if !p.installed || !p.enabled {
                                act_fill
                            } else {
                                BORDER_LINE
                            },
                        ))
                        .min_size(Vec2::new(if p.installed { 56.0 } else { 76.0 }, 23.0));

                        if ui.add_enabled(!self.busy, toggle_btn).clicked() {
                            let pid = p.id;
                            let was_installed = p.installed;
                            let next_en = !p.enabled;
                            let node_c = node.clone();
                            self.spawn_task(egui_ctx.clone(), "正在切换插件状态…", move |tx| {
                                let res = if !was_installed {
                                    install_plugin(pid, &node_c)
                                } else {
                                    toggle_plugin_enabled(pid, next_en, &node_c)
                                };
                                match res {
                                    Ok(lines) => {
                                        for l in lines {
                                            let _ = tx.send(WorkerEvent::Log(l));
                                        }
                                    }
                                    Err(e) => {
                                        let _ = tx.send(WorkerEvent::Log(format!("[错误] {}", e)));
                                    }
                                }
                            });
                        }
                    });
                });
            });
    }

    fn render_env_and_pi_card(&self, ui: &mut egui::Ui) {
        panel_card().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("本地环境与 Pi 扩展探测")
                        .size(12.0)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let ver = self.node_info.version.as_deref().unwrap_or("未检测到 Node");
                    draw_badge(
                        ui,
                        &format!("Node {}", ver),
                        if self.node_info.version.is_some() {
                            ACCENT_GREEN
                        } else {
                            ACCENT_RED
                        },
                    );
                });
            });

            ui.add_space(5.0);
            egui::Frame::none()
                .fill(BG_SUBTLE)
                .rounding(Rounding::same(5.0))
                .inner_margin(Margin::symmetric(8.0, 6.0))
                .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.label(
                        RichText::new(format!("插件部署目录: {}", plugins_root_dir().display()))
                            .font(FontId::new(10.5, FontFamily::Monospace))
                            .color(FG_SUB),
                    );
                    ui.label(
                        RichText::new(format!(
                            "Node 解析方式: {} ({})",
                            self.node_info.command_for_config(),
                            if self.node_info.in_path {
                                "全局 PATH"
                            } else {
                                "自动定位绝对路径"
                            }
                        ))
                        .font(FontId::new(10.5, FontFamily::Monospace))
                        .color(FG_SUB),
                    );
                    ui.add_space(3.0);
                    ui.horizontal_wrapped(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        draw_kv_tag(
                            ui,
                            "fast-context",
                            if self.pi_info.has_fast_context { "已就绪" } else { "未安装" },
                            if self.pi_info.has_fast_context { ACCENT_GREEN } else { FG_MUTED },
                        );
                        draw_kv_tag(
                            ui,
                            "pi-search",
                            if self.pi_info.has_pi_search && self.pi_info.has_jiti {
                                "已就绪"
                            } else {
                                "未安装"
                            },
                            if self.pi_info.has_pi_search && self.pi_info.has_jiti {
                                ACCENT_GREEN
                            } else {
                                FG_MUTED
                            },
                        );
                        draw_kv_tag(
                            ui,
                            "devin-search",
                            if self.pi_info.has_devin_search && self.pi_info.has_jiti {
                                "已就绪"
                            } else {
                                "未安装"
                            },
                            if self.pi_info.has_devin_search && self.pi_info.has_jiti {
                                ACCENT_GREEN
                            } else {
                                FG_MUTED
                            },
                        );
                    });
                });

            ui.add_space(5.0);
            let installed_bins: Vec<&BinaryInspection> =
                self.binaries.iter().filter(|b| b.exists).collect();
            ui.label(
                RichText::new(format!("已发现 {} 个 Antigravity 内核文件：", installed_bins.len()))
                    .size(11.0)
                    .strong()
                    .color(FG_SUB),
            );
            for b in installed_bins {
                ui.label(
                    RichText::new(format!("  • {}", b.label))
                        .size(10.5)
                        .color(FG_MUTED),
                );
            }
        });
    }

    fn render_legacy_binary_view(&mut self, ui: &mut egui::Ui, egui_ctx: &egui::Context) {
        egui::Frame::none()
            .fill(Color32::from_rgba_unmultiplied(217, 119, 6, 14))
            .rounding(Rounding::same(6.0))
            .inner_margin(Margin::symmetric(12.0, 7.0))
            .stroke(Stroke::new(
                1.0_f32,
                Color32::from_rgba_unmultiplied(217, 119, 6, 95),
            ))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("⚠ 高风险进阶操作：修改 .exe 二进制提示词与上下文门禁可能触发风控或随更新失效。新版 agy 已原生支持 512K，推荐仅使用「合规插件中心」。")
                            .size(11.5)
                            .color(ACCENT_AMBER),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui
                            .add_enabled(
                                !self.busy,
                                egui::Button::new(RichText::new("全部还原官方默认").size(11.0).color(FG_SUB))
                                    .fill(BG_PANEL)
                                    .rounding(Rounding::same(5.0))
                                    .stroke(Stroke::new(1.0_f32, BORDER_LINE)),
                            )
                            .clicked()
                        {
                            self.run_full_restore_async(egui_ctx.clone());
                        }
                        if ui
                            .add_enabled(
                                !self.busy,
                                egui::Button::new(
                                    RichText::new("一键应用选中配置")
                                        .size(11.0)
                                        .color(Color32::from_rgb(250, 252, 255)),
                                )
                                .fill(ACCENT_AMBER)
                                .rounding(Rounding::same(5.0)),
                            )
                            .clicked()
                        {
                            self.run_full_recommended_async(egui_ctx.clone());
                        }
                        if self.proc_status.language_server_running
                            && ui
                                .add_enabled(
                                    !self.busy,
                                    egui::Button::new(RichText::new("停止内核释放锁").size(11.0).color(ACCENT_RED))
                                        .fill(BG_PANEL)
                                        .rounding(Rounding::same(5.0)),
                                )
                                .clicked()
                        {
                            self.spawn_task(egui_ctx.clone(), "正在停止内核进程…", |tx| {
                                for l in kill_language_servers() {
                                    let _ = tx.send(WorkerEvent::Log(l));
                                }
                            });
                        }
                    });
                });
            });

        ui.add_space(7.0);
        self.render_section_01_binaries(ui);
        ui.add_space(8.0);

        ui.columns(2, |cols| {
            self.render_section_02_prompts(&mut cols[0], egui_ctx);
            self.render_section_03_context(&mut cols[1], egui_ctx);
        });
    }

    fn render_section_01_binaries(&mut self, ui: &mut egui::Ui) {
        panel_card().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("1. 目标内核文件与提示词模板分布")
                        .size(12.0)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let toggle_txt = if self.show_slot_table {
                        "[-] 收起模板列表"
                    } else {
                        "[+] 查看全部模板明细"
                    };
                    if ui
                        .add(
                            egui::Button::new(
                                RichText::new(toggle_txt).size(11.0).color(ACCENT_BLUE),
                            )
                            .fill(Color32::from_rgba_unmultiplied(2, 132, 199, 14))
                            .rounding(Rounding::same(4.0))
                            .stroke(Stroke::new(1.0_f32, ACCENT_BLUE)),
                        )
                        .clicked()
                    {
                        self.show_slot_table = !self.show_slot_table;
                    }
                });
            });
            ui.add_space(5.0);

            if self.binaries.is_empty() {
                ui.label(
                    RichText::new("正在后台读取内核文件，请稍候…")
                        .size(11.5)
                        .color(FG_MUTED),
                );
                return;
            }

            let mut clicked_tab = None;
            let col_count = self.binaries.len().max(1);
            ui.columns(col_count, |cols| {
                for (idx, bin) in self.binaries.iter().enumerate() {
                    let col = &mut cols[idx];
                    let is_selected = self.selected_binary_tab == idx;
                    let fill = if is_selected {
                        Color32::from_rgba_unmultiplied(2, 132, 199, 12)
                    } else {
                        BG_SUBTLE
                    };
                    let stroke = if is_selected {
                        Stroke::new(1.4_f32, ACCENT_BLUE)
                    } else {
                        Stroke::new(1.0_f32, BORDER_LINE)
                    };

                    let matched_name =
                        match_binary_to_preset(&bin.slots, &self.presets).map(|p| p.name.as_str());
                    let prompt_st = bin.prompt_status_short(matched_name);

                    let resp = egui::Frame::none()
                        .fill(fill)
                        .rounding(Rounding::same(6.0))
                        .inner_margin(Margin::symmetric(10.0, 6.0))
                        .stroke(stroke)
                        .show(col, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal(|ui| {
                                let dot_col = if bin.exists { ACCENT_GREEN } else { FG_MUTED };
                                ui.label(RichText::new("●").size(11.0).color(dot_col));
                                ui.label(
                                    RichText::new(&bin.label)
                                        .size(11.5)
                                        .strong()
                                        .color(if is_selected { ACCENT_BLUE } else { FG_MAIN }),
                                );
                            });

                            if !bin.exists {
                                ui.label(
                                    RichText::new("未安装该端程序").size(11.0).color(FG_MUTED),
                                );
                                return;
                            }

                            ui.add_space(3.0);
                            let ctx_mode = bin.effective_context_mode();
                            let ctx_short = match ctx_mode {
                                ContextMode::Stock => "256K/128K 默认",
                                ContextMode::Unlock512K => "512K 已解锁",
                                ContextMode::Unlock900K => "900K/1M 已解锁",
                            };
                            let saved_chars = bin
                                .total_slot_capacity
                                .saturating_sub(bin.active_slot_bytes);

                            ui.horizontal_wrapped(|ui| {
                                ui.spacing_mut().item_spacing.x = 6.0;
                                draw_kv_tag(
                                    ui,
                                    "提示词",
                                    &prompt_st,
                                    if bin.is_prompt_stock() { FG_SUB } else { ACCENT_BLUE },
                                );
                                draw_kv_tag(
                                    ui,
                                    "上下文",
                                    ctx_short,
                                    match ctx_mode {
                                        ContextMode::Stock => FG_SUB,
                                        ContextMode::Unlock512K => ACCENT_AMBER,
                                        ContextMode::Unlock900K => ACCENT_GREEN,
                                    },
                                );
                                draw_kv_tag(
                                    ui,
                                    "字数",
                                    &if saved_chars > 0 {
                                        format!(
                                            "{} (减 {})",
                                            fmt_int(bin.active_slot_bytes),
                                            fmt_int(saved_chars)
                                        )
                                    } else {
                                        fmt_int(bin.total_slot_capacity)
                                    },
                                    if saved_chars > 0 { ACCENT_INDIGO } else { FG_SUB },
                                );
                            });
                        })
                        .response;

                    let interact = col.interact(
                        resp.rect,
                        col.id().with(("bin_tab_card", idx)),
                        Sense::click(),
                    );
                    if interact.hovered() {
                        col.ctx().set_cursor_icon(CursorIcon::PointingHand);
                    }
                    if interact.clicked() {
                        clicked_tab = Some(idx);
                    }
                }
            });
            if let Some(idx) = clicked_tab {
                self.selected_binary_tab = idx;
            }

            if let Some(active_bin) = self.binaries.get(self.selected_binary_tab) {
                if active_bin.exists && !active_bin.slots.is_empty() {
                    ui.add_space(6.0);
                    draw_embed_fs_memory_bar(
                        ui,
                        &active_bin.slots,
                        active_bin.total_slot_capacity,
                    );

                    if self.show_slot_table {
                        ui.add_space(6.0);
                        render_slot_details_table(ui, &active_bin.slots);
                    }
                }
            }
        });
    }

    fn render_section_02_prompts(&mut self, ui: &mut egui::Ui, egui_ctx: &egui::Context) {
        panel_card().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("2. 系统提示词修改 (presets 预设目录)")
                        .size(12.0)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(
                        RichText::new("保留身份校验区与 19 个原生工具")
                            .size(10.5)
                            .color(FG_MUTED),
                    );
                });
            });
            ui.add_space(5.0);

            if self.presets.is_empty() {
                egui::Frame::none()
                    .fill(BG_SUBTLE)
                    .rounding(Rounding::same(6.0))
                    .inner_margin(Margin::symmetric(8.0, 6.0))
                    .stroke(Stroke::new(1.0_f32, ACCENT_AMBER))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(
                            RichText::new("未找到 presets 预设目录（请将 presets 文件夹放在 agy-tool.exe 同级目录）")
                                .size(11.0)
                                .color(ACCENT_AMBER),
                        );
                    });
                ui.add_space(4.0);
            }

            let presets_snapshot = self.presets.clone();
            for (idx, preset) in presets_snapshot.iter().enumerate() {
                let selected = self.selected_preset_idx == Some(idx);
                let (remain_chars, saved_chars, overflow_err) =
                    self.calc_preset_char_stats(Some(preset));
                let (char_badge, badge_col) = if let Some(ref err) = overflow_err {
                    (err.clone(), ACCENT_RED)
                } else if remain_chars == 0 {
                    ("读取中…".to_string(), ACCENT_BLUE)
                } else {
                    (
                        format!(
                            "剩 {} 字 (减 {} 字)",
                            fmt_int(remain_chars),
                            fmt_int(saved_chars)
                        ),
                        ACCENT_BLUE,
                    )
                };
                let desc = preset.summary();

                if draw_selectable_option_card(
                    ui,
                    ("prompt_opt", idx),
                    selected,
                    &preset.name,
                    &char_badge,
                    &desc,
                    ACCENT_BLUE,
                    badge_col,
                ) {
                    self.selected_preset_idx = Some(idx);
                }
                ui.add_space(2.5);
            }

            let stock_selected = self.selected_preset_idx.is_none();
            let (stock_chars, _, _) = self.calc_preset_char_stats(None);
            let stock_badge = if stock_chars == 0 {
                "读取中…".to_string()
            } else {
                format!("共 {} 字 · 原版", fmt_int(stock_chars))
            };
            if draw_selectable_option_card(
                ui,
                ("prompt_opt", 9999),
                stock_selected,
                "官方原版 (不修改)",
                &stock_badge,
                "从 backup/ 备份还原全部官方默认提示词模板",
                ACCENT_BLUE,
                FG_MUTED,
            ) {
                self.selected_preset_idx = None;
            }

            let selected_preset = self
                .selected_preset_idx
                .and_then(|i| self.presets.get(i));
            let (_, _, sel_overflow) = self.calc_preset_char_stats(selected_preset);
            let target_label = selected_preset
                .map(|p| p.name.as_str())
                .unwrap_or("官方原版");

            ui.add_space(4.0);
            let apply_btn = egui::Button::new(
                RichText::new(format!("应用选中的提示词: {}", target_label))
                    .size(12.0)
                    .strong()
                    .color(Color32::from_rgb(250, 252, 255)),
            )
            .fill(ACCENT_BLUE)
            .rounding(Rounding::same(6.0))
            .min_size(Vec2::new(ui.available_width(), 27.0));

            if ui
                .add_enabled(!self.busy && sel_overflow.is_none(), apply_btn)
                .clicked()
            {
                let patch = selected_preset
                    .map(|p| p.to_patch())
                    .unwrap_or_else(PromptPatch::stock);
                self.run_binary_patch_async(egui_ctx.clone(), Some(patch), None);
            }
        });
    }

    fn render_section_03_context(&mut self, ui: &mut egui::Ui, egui_ctx: &egui::Context) {
        panel_card().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("3. 二进制上下文门禁修改")
                        .size(12.0)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(
                        RichText::new("仅针对尚未原生开放 512K 的旧版内核")
                            .size(10.5)
                            .color(FG_MUTED),
                    );
                });
            });
            ui.add_space(5.0);

            let modes = [
                (
                    ContextMode::Unlock900K,
                    "解锁 900K / 1M 上下文",
                    "上限 983,040 token",
                    "解除旧版内核 256K(桌面端) / 128K(IDE) 封顶并同步前端显示为 983,040",
                    ACCENT_GREEN,
                ),
                (
                    ContextMode::Unlock512K,
                    "解锁 512K 上下文",
                    "上限 512,000 token",
                    "将旧版内核压缩阈值与前端显示上限同步提升至 512,000",
                    ACCENT_AMBER,
                ),
                (
                    ContextMode::Stock,
                    "恢复官方默认上限",
                    "默认原版",
                    "从 backup/ 备份还原默认上下文阈值，并移除配置文件中的自定义窗口项",
                    FG_MUTED,
                ),
            ];

            for (idx, (mode, title, badge, desc, badge_col)) in modes.into_iter().enumerate() {
                let selected = self.selected_context_mode == mode;
                if draw_selectable_option_card(
                    ui,
                    ("ctx_opt", idx),
                    selected,
                    title,
                    badge,
                    desc,
                    ACCENT_GREEN,
                    badge_col,
                ) {
                    self.selected_context_mode = mode;
                }
                ui.add_space(4.0);
            }

            ui.add_space(3.0);
            let apply_ctx_btn = egui::Button::new(
                RichText::new(format!(
                    "应用选中的上下文上限: {}",
                    self.selected_context_mode.label()
                ))
                .size(12.0)
                .strong()
                .color(Color32::from_rgb(250, 252, 255)),
            )
            .fill(ACCENT_GREEN)
            .rounding(Rounding::same(6.0))
            .min_size(Vec2::new(ui.available_width(), 28.0));

            if ui.add_enabled(!self.busy, apply_ctx_btn).clicked() {
                let m = self.selected_context_mode;
                self.run_binary_patch_async(egui_ctx.clone(), None, Some(m));
            }
        });
    }

    fn render_section_04_hud(&mut self, ui: &mut egui::Ui, egui_ctx: &egui::Context) {
        panel_card().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("桌面端输入框状态栏 (HUD)")
                        .size(12.0)
                        .strong()
                        .color(FG_MAIN),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let (short_st, state_color) = match self.hud.state {
                        HudInstallState::AgyComposerHudInstalled => {
                            ("已注入底部状态栏", ACCENT_GREEN)
                        }
                        HudInstallState::LegacyTopBarInstalled => {
                            ("检测到旧版顶栏插件", ACCENT_AMBER)
                        }
                        HudInstallState::Stock => ("未注入", FG_MUTED),
                        HudInstallState::NotFound => ("未找到 app.asar", ACCENT_RED),
                    };
                    draw_badge(ui, short_st, state_color);
                });
            });

            ui.add_space(4.0);
            ui.label(
                RichText::new(format!(
                    "客户端版本: v{}  |  位置: 输入框 Request Review 按钮左侧",
                    if self.hud.app_version.is_empty() {
                        "-"
                    } else {
                        &self.hud.app_version
                    }
                ))
                .size(10.5)
                .color(FG_SUB),
            );

            if ui
                .checkbox(
                    &mut self.hud_show_ctx_text,
                    RichText::new("默认在圆圈旁显示上下文数值")
                        .size(11.0)
                        .color(FG_MAIN),
                )
                .changed()
            {
                let show = self.hud_show_ctx_text;
                let tx = self.tx.clone();
                std::thread::spawn(move || {
                    match set_hud_ctx_text_via_cdp(show) {
                        Ok(n) if n > 0 => {
                            let _ = tx.send(WorkerEvent::Log(format!(
                                "已切换圆圈旁上下文数值显示: {}",
                                if show { "开启" } else { "关闭 (仅显示圆圈)" }
                            )));
                        }
                        _ => {
                            let _ = tx.send(WorkerEvent::Log(
                                "设置已保存，将在客户端连接后生效。".to_string(),
                            ));
                        }
                    }
                });
            }

            ui.add_space(3.0);
            egui::Frame::none()
                .fill(BG_SUBTLE)
                .rounding(Rounding::same(5.0))
                .inner_margin(Margin::symmetric(8.0, 5.0))
                .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.label(
                        RichText::new("• 左侧圆圈：鼠标悬停显示精确 token 用量与占比。")
                            .size(10.5)
                            .color(FG_SUB),
                    );
                    ui.label(
                        RichText::new("• 右侧速度：显示 tok/s 速度，悬停显示流式速率与首字耗时。")
                            .size(10.5)
                            .color(FG_SUB),
                    );
                    ui.label(
                        RichText::new("• 点击展开：查看提示词/工具/对话分词与真实返回 model id 监控。")
                            .size(10.5)
                            .color(FG_SUB),
                    );
                });

            ui.add_space(6.0);
            let avail = ui.available_width();
            let gap = 6.0;
            let bw1 = (avail * 0.44).floor();
            let bw2 = (avail * 0.28).floor();
            let bw3 = (avail - bw1 - bw2 - gap * 2.0).max(76.0);

            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = gap;

                let inject_btn = egui::Button::new(
                    RichText::new("注入状态栏")
                        .size(11.5)
                        .strong()
                        .color(Color32::from_rgb(250, 252, 255)),
                )
                .fill(ACCENT_INDIGO)
                .rounding(Rounding::same(6.0))
                .min_size(Vec2::new(bw1, 28.0));

                if ui.add_enabled(!self.busy, inject_btn).clicked() {
                    self.spawn_task(egui_ctx.clone(), "正在后台注入状态栏…", |tx| {
                        match install_composer_hud() {
                            Ok(lines) => {
                                for l in lines {
                                    let _ = tx.send(WorkerEvent::Log(l));
                                }
                            }
                            Err(e) => {
                                let _ = tx.send(WorkerEvent::Log(format!("[错误] 注入失败: {}", e)));
                            }
                        }
                    });
                }

                let cdp_btn = egui::Button::new(
                    RichText::new("免重启刷新")
                        .size(11.5)
                        .color(ACCENT_BLUE),
                )
                .fill(BG_SUBTLE)
                .rounding(Rounding::same(6.0))
                .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                .min_size(Vec2::new(bw2, 28.0));

                if ui.add_enabled(!self.busy, cdp_btn).clicked() {
                    self.spawn_task(egui_ctx.clone(), "正在实时刷新客户端状态栏…", |tx| {
                        match hot_inject_via_cdp() {
                            Ok(n) => {
                                let _ = tx.send(WorkerEvent::Log(format!(
                                    "已实时刷新 {} 个打开的窗口。",
                                    n
                                )));
                            }
                            Err(e) => {
                                let _ = tx.send(WorkerEvent::Log(format!(
                                    "[错误] 实时刷新失败: {}",
                                    e
                                )));
                            }
                        }
                    });
                }

                let uninst_btn = egui::Button::new(
                    RichText::new("卸载还原")
                        .size(11.5)
                        .color(FG_SUB),
                )
                .fill(BG_SUBTLE)
                .rounding(Rounding::same(6.0))
                .stroke(Stroke::new(1.0_f32, BORDER_LINE))
                .min_size(Vec2::new(bw3, 28.0));

                if ui.add_enabled(!self.busy, uninst_btn).clicked() {
                    self.spawn_task(egui_ctx.clone(), "正在卸载状态栏并还原 app.asar…", |tx| {
                        match restore_stock_asar() {
                            Ok(lines) => {
                                for l in lines {
                                    let _ = tx.send(WorkerEvent::Log(l));
                                }
                            }
                            Err(e) => {
                                let _ = tx.send(WorkerEvent::Log(format!("[错误] 还原失败: {}", e)));
                            }
                        }
                        let _ = hot_remove_via_cdp();
                    });
                }
            });
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_selectable_option_card(
    ui: &mut egui::Ui,
    id_salt: (&str, usize),
    selected: bool,
    title: &str,
    badge: &str,
    desc: &str,
    accent: Color32,
    badge_color: Color32,
) -> bool {
    let id = ui.id().with(id_salt);
    let fill = if selected {
        Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 14)
    } else {
        BG_SUBTLE
    };
    let stroke = if selected {
        Stroke::new(1.4_f32, accent)
    } else {
        Stroke::new(1.0_f32, BORDER_LINE)
    };

    let inner = egui::Frame::none()
        .fill(fill)
        .rounding(Rounding::same(6.0))
        .inner_margin(Margin::symmetric(8.0, 3.5))
        .stroke(stroke)
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let (r_rect, _) = ui.allocate_exact_size(Vec2::new(14.0, 14.0), Sense::hover());
                let center = r_rect.center();
                let p = ui.painter();
                p.circle_stroke(
                    center,
                    5.8,
                    Stroke::new(1.4_f32, if selected { accent } else { FG_MUTED }),
                );
                if selected {
                    p.circle_filled(center, 3.2, accent);
                }

                ui.label(
                    RichText::new(title)
                        .size(11.5)
                        .strong()
                        .color(if selected { FG_MAIN } else { FG_SUB }),
                );

                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    draw_badge(ui, badge, badge_color);
                });
            });
            ui.label(RichText::new(desc).size(10.5).color(FG_MUTED));
        });

    let interact = ui.interact(inner.response.rect, id, Sense::click());
    if interact.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        if !selected {
            ui.painter().rect_stroke(
                inner.response.rect,
                Rounding::same(6.0),
                Stroke::new(1.0_f32, BORDER_HOVER),
            );
        }
    }
    interact.clicked()
}

fn draw_embed_fs_memory_bar(ui: &mut egui::Ui, slots: &[TemplateSlot], total_cap: usize) {
    if total_cap == 0 {
        return;
    }
    let desired = Vec2::new(ui.available_width(), 16.0);
    let (rect, _resp) = ui.allocate_exact_size(desired, Sense::hover());
    let painter = ui.painter_at(rect);

    painter.rect_filled(rect, Rounding::same(4.0), Color32::from_rgb(226, 232, 240));

    let mut x = rect.left();
    let total_w = rect.width();

    for (idx, slot) in slots.iter().enumerate() {
        let w = if idx == slots.len() - 1 {
            (rect.right() - x).max(1.0)
        } else {
            ((slot.data_length as f32 / total_cap as f32) * total_w).max(2.0)
        };
        let seg_rect = Rect::from_min_max(
            Pos2::new(x, rect.top()),
            Pos2::new((x + w - 1.0).min(rect.right()), rect.bottom()),
        );

        let color = if slot.short_name.contains("identity.tmpl") {
            ACCENT_GREEN
        } else if slot.is_stripped {
            Color32::from_rgb(203, 213, 225)
        } else if slot.is_modified {
            ACCENT_BLUE
        } else {
            ACCENT_INDIGO
        };

        painter.rect_filled(seg_rect, Rounding::same(2.0), color);

        if !slot.is_stripped && slot.active_bytes < slot.data_length {
            let active_ratio = slot.active_bytes as f32 / slot.data_length.max(1) as f32;
            let fill_w = (seg_rect.width() * active_ratio).max(2.0);
            let active_rect = Rect::from_min_max(
                seg_rect.min,
                Pos2::new(seg_rect.left() + fill_w, seg_rect.bottom()),
            );
            painter.rect_filled(active_rect, Rounding::same(2.0), ACCENT_BLUE);
        }

        let seg_resp = ui.interact(seg_rect, ui.id().with(("slot_bar", idx)), Sense::hover());
        if seg_resp.hovered() {
            painter.rect_stroke(seg_rect, Rounding::same(2.0), Stroke::new(1.2_f32, FG_MAIN));
            seg_resp.on_hover_ui(|ui| {
                ui.label(
                    RichText::new(&slot.short_name)
                        .strong()
                        .color(ACCENT_BLUE)
                        .size(12.0),
                );
                ui.label(
                    RichText::new(format!(
                        "文件偏移: @0x{:X}  |  当前字数: {} 字 / 原容量: {} 字",
                        slot.data_offset, slot.active_bytes, slot.data_length
                    ))
                    .font(FontId::new(11.0, FontFamily::Monospace))
                    .color(FG_SUB),
                );
                ui.label(
                    RichText::new(&slot.preview)
                        .font(FontId::new(11.0, FontFamily::Monospace))
                        .color(FG_MUTED),
                );
            });
        }

        x += w;
    }

    ui.add_space(3.0);
    ui.horizontal(|ui| {
        legend_dot(ui, ACCENT_GREEN, "identity (身份校验区，固定保留)");
        ui.add_space(10.0);
        legend_dot(ui, ACCENT_BLUE, "已修改的核心模板");
        ui.add_space(10.0);
        legend_dot(ui, ACCENT_INDIGO, "保留原版的模板");
        ui.add_space(10.0);
        legend_dot(ui, Color32::from_rgb(180, 192, 208), "已清空的模板 (0 字)");
    });
}

fn legend_dot(ui: &mut egui::Ui, color: Color32, text: &str) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        let (r, _) = ui.allocate_exact_size(Vec2::new(8.0, 8.0), Sense::hover());
        ui.painter().rect_filled(r, Rounding::same(2.0), color);
        ui.label(RichText::new(text).size(10.5).color(FG_MUTED));
    });
}

fn render_slot_details_table(ui: &mut egui::Ui, slots: &[TemplateSlot]) {
    egui::Frame::none()
        .fill(BG_SUBTLE)
        .rounding(Rounding::same(5.0))
        .inner_margin(Margin::symmetric(8.0, 5.0))
        .stroke(Stroke::new(1.0_f32, BORDER_LINE))
        .show(ui, |ui| {
            egui::Grid::new("embed_slots_grid")
                .striped(true)
                .spacing(Vec2::new(14.0, 3.0))
                .show(ui, |ui| {
                    ui.label(RichText::new("模板名称").size(10.5).strong().color(FG_SUB));
                    ui.label(RichText::new("文件偏移").size(10.5).strong().color(FG_SUB));
                    ui.label(RichText::new("当前字数 / 原字数").size(10.5).strong().color(FG_SUB));
                    ui.label(RichText::new("状态").size(10.5).strong().color(FG_SUB));
                    ui.end_row();

                    for s in slots {
                        ui.label(
                            RichText::new(&s.short_name)
                                .font(FontId::new(11.0, FontFamily::Monospace))
                                .color(FG_MAIN),
                        );
                        ui.label(
                            RichText::new(format!("0x{:08X}", s.data_offset))
                                .font(FontId::new(11.0, FontFamily::Monospace))
                                .color(FG_MUTED),
                        );
                        ui.label(
                            RichText::new(format!(
                                "{} / {} 字",
                                fmt_int(s.active_bytes),
                                fmt_int(s.data_length)
                            ))
                            .font(FontId::new(11.0, FontFamily::Monospace))
                            .color(FG_SUB),
                        );
                        let (st_txt, st_col) = if s.short_name.contains("identity.tmpl") {
                            ("固定保留 (网关校验)", ACCENT_GREEN)
                        } else if s.is_stripped {
                            ("已清空 (0 字)", FG_MUTED)
                        } else if s.is_modified {
                            ("已修改", ACCENT_BLUE)
                        } else {
                            ("官方原版", ACCENT_INDIGO)
                        };
                        ui.label(RichText::new(st_txt).size(10.5).color(st_col));
                        ui.end_row();
                    }
                });
        });
}

fn fmt_int(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (idx, ch) in s.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn panel_card() -> egui::Frame {
    egui::Frame::none()
        .fill(BG_PANEL)
        .rounding(Rounding::same(7.0))
        .inner_margin(Margin::symmetric(11.0, 8.0))
        .stroke(Stroke::new(1.0_f32, BORDER_LINE))
}

fn draw_badge(ui: &mut egui::Ui, text: &str, color: Color32) {
    egui::Frame::none()
        .fill(Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), 16))
        .rounding(Rounding::same(4.0))
        .inner_margin(Margin::symmetric(6.0, 1.5))
        .stroke(Stroke::new(
            1.0_f32,
            Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), 85),
        ))
        .show(ui, |ui| {
            ui.label(RichText::new(text).size(10.5).strong().color(color));
        });
}

fn draw_kv_tag(ui: &mut egui::Ui, k: &str, v: &str, v_col: Color32) {
    egui::Frame::none()
        .fill(BG_PANEL)
        .rounding(Rounding::same(4.0))
        .inner_margin(Margin::symmetric(6.0, 2.0))
        .stroke(Stroke::new(1.0_f32, BORDER_LINE))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                ui.label(RichText::new(format!("{}:", k)).size(10.5).color(FG_MUTED));
                ui.label(RichText::new(v).size(10.5).strong().color(v_col));
            });
        });
}

fn setup_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();

    let cjk_candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyh.ttf",
        "C:/Windows/Fonts/simhei.ttf",
    ];
    for path in cjk_candidates {
        if let Ok(bytes) = fs::read(path) {
            fonts
                .font_data
                .insert("msyh".to_string(), FontData::from_owned(bytes));
            if let Some(fam) = fonts.families.get_mut(&FontFamily::Proportional) {
                fam.insert(0, "msyh".to_string());
            }
            if let Some(fam) = fonts.families.get_mut(&FontFamily::Monospace) {
                fam.push("msyh".to_string());
            }
            break;
        }
    }

    if let Ok(bytes) = fs::read("C:/Windows/Fonts/seguisym.ttf") {
        fonts
            .font_data
            .insert("seguisym".to_string(), FontData::from_owned(bytes));
        if let Some(fam) = fonts.families.get_mut(&FontFamily::Proportional) {
            fam.push("seguisym".to_string());
        }
        if let Some(fam) = fonts.families.get_mut(&FontFamily::Monospace) {
            fam.push("seguisym".to_string());
        }
    }

    if let Ok(bytes) = fs::read("C:/Windows/Fonts/consola.ttf") {
        fonts
            .font_data
            .insert("consolas".to_string(), FontData::from_owned(bytes));
        if let Some(fam) = fonts.families.get_mut(&FontFamily::Monospace) {
            fam.insert(0, "consolas".to_string());
        }
    }

    ctx.set_fonts(fonts);
}

fn setup_daylight_visuals(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::light();
    visuals.panel_fill = BG_APP;
    visuals.window_fill = BG_PANEL;
    visuals.override_text_color = Some(FG_MAIN);
    visuals.widgets.noninteractive.bg_fill = BG_PANEL;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER_LINE);
    visuals.widgets.inactive.bg_fill = BG_SUBTLE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER_LINE);
    visuals.widgets.hovered.bg_fill = BG_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT_BLUE);
    visuals.widgets.active.bg_fill = Color32::from_rgb(219, 234, 254);
    visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(2, 132, 199, 28);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT_BLUE);
    ctx.set_visuals(visuals);
}

fn save_color_image_as_bmp(img: &egui::ColorImage, path: &str) {
    let w = img.width() as u32;
    let h = img.height() as u32;
    let row_stride = (w * 3 + 3) & !3;
    let pixel_data_size = row_stride * h;
    let file_size = 54 + pixel_data_size;

    let mut buf = Vec::with_capacity(file_size as usize);
    buf.extend_from_slice(b"BM");
    buf.extend_from_slice(&file_size.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&54u32.to_le_bytes());
    buf.extend_from_slice(&40u32.to_le_bytes());
    buf.extend_from_slice(&(w as i32).to_le_bytes());
    buf.extend_from_slice(&(h as i32).to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&24u16.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&pixel_data_size.to_le_bytes());
    buf.extend_from_slice(&2835u32.to_le_bytes());
    buf.extend_from_slice(&2835u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());

    let pad = (row_stride - w * 3) as usize;
    for y in (0..h as usize).rev() {
        for x in 0..w as usize {
            let p = img.pixels[y * (w as usize) + x];
            buf.push(p.b());
            buf.push(p.g());
            buf.push(p.r());
        }
        for _ in 0..pad {
            buf.push(0);
        }
    }
    let _ = fs::write(path, buf);
}

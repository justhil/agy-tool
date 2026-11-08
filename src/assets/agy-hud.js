(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (location.protocol !== 'https:' && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return;

  // 1. 清理旧版顶栏插件残留与上一轮自身实例
  try { globalThis.__AGContextMeter?.dispose?.(); } catch {}
  try { document.getElementById('ag-context-meter')?.remove?.(); } catch {}
  try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch {}
  try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch {}
  try { globalThis.__AGY_HUD__?.dispose?.(); } catch {}
  try { window.contextMeterAPI?.syncOverlay?.({}); } catch {}

  const STORAGE_KEY_SHOW_TEXT = 'agy-hud-show-ctx-text';
  const STORAGE_KEY_CTX_CAP = 'agy-hud-ctx-cap';
  const RING_R = 5.0;
  const RING_C = 2 * Math.PI * RING_R;

  function loadShowTextPref() {
    try {
      return localStorage.getItem(STORAGE_KEY_SHOW_TEXT) === '1';
    } catch {
      return false;
    }
  }

  function saveShowTextPref(val) {
    try {
      localStorage.setItem(STORAGE_KEY_SHOW_TEXT, val ? '1' : '0');
    } catch {}
  }

  function loadOverrideCap() {
    try {
      const v = Number(localStorage.getItem(STORAGE_KEY_CTX_CAP) || 0);
      return Number.isFinite(v) && v >= 256000 ? v : 0;
    } catch {
      return 0;
    }
  }

  function saveOverrideCap(val) {
    try {
      const v = Number(val || 0);
      if (v > 0) localStorage.setItem(STORAGE_KEY_CTX_CAP, String(v));
      else localStorage.removeItem(STORAGE_KEY_CTX_CAP);
    } catch {}
  }

  const state = {
    disposed: false,
    cascadeId: null,
    baselineId: null,
    isBaseline: false,
    showCtxText: loadShowTextPref(), // 默认 false：仅显示圆圈，不显示上下文数值文字
    overrideCap: loadOverrideCap(),  // 由 agy-tool 注入/解锁时同步的物理窗口上限 (512000 / 983040)
    popoverOpen: false,
    hoverTarget: null, // 'ctx' | 'tps' | null
    expandedGroups: { 'System Prompt': true, 'Tools': false, 'Chat Messages': false },
    inFlight: false,
    inFlightSince: 0,
    lastPollAt: 0,
    pollBusy: false,
    ctx: {
      used: null,
      max: 256000,
      pct: null,
      groups: [],
      exceeded: false,
      retryError: null,
      retryCount: 0,
      retryWaitSec: null,
    },
    speed: {
      overallTps: null,
      streamTps: null,
      ttftSec: null,
      streamSec: null,
      totalSec: null,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      responseTokens: null,
      cacheTokens: null,
      modelName: '',
      reqModelEnum: '',
      responseModel: '',
      routedMismatch: false,
      fromPreviousTurn: false,
    },
  };

  function fmtNum(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Math.round(Number(n)).toLocaleString('en-US');
  }

  function fmtShort(n) {
    if (n == null || !Number.isFinite(Number(n))) return '--';
    const v = Number(n);
    if (v >= 1000000) return (v / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  function parseProtoDurationSec(raw) {
    if (!raw) return null;
    if (typeof raw === 'number') return raw > 0 ? raw : null;
    if (typeof raw === 'string') {
      const m = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)s$/i);
      if (m) {
        const val = parseFloat(m[1]);
        return Number.isFinite(val) && val > 0 ? val : 0;
      }
    }
    if (typeof raw === 'object') {
      const sec = Number(raw.seconds || 0);
      const nanos = Number(raw.nanos || 0);
      const total = sec + nanos / 1e9;
      return Number.isFinite(total) && total > 0 ? total : 0;
    }
    return null;
  }

  const host = document.createElement('div');
  host.id = 'agy-composer-hud';
  host.setAttribute('data-no-drag', '');
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `<style>
    :host {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      position: relative;
      height: 24px;
      flex-shrink: 0;
      user-select: none;
      -webkit-app-region: no-drag;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 11px;
      line-height: 1.25;
      color: var(--secondary-foreground, #a1a1aa);
      --hud-bg-hover: rgba(148, 163, 184, 0.12);
      --hud-bg-active: rgba(148, 163, 184, 0.18);
      --hud-fg: #a1a1aa;
      --hud-fg-strong: #e4e4e7;
      --hud-surface: #18181c;
      --hud-surface-elev: #222228;
      --hud-border: rgba(255, 255, 255, 0.10);
      --hud-divider: rgba(161, 161, 170, 0.22);
      --hud-accent: #38bdf8;
      --hud-tools: #818cf8;
      --hud-chat: #34d399;
      --hud-warn: #f59e0b;
      --hud-danger: #ef4444;
      --hud-shadow: 0 10px 26px rgba(9, 9, 11, 0.50), 0 2px 6px rgba(9, 9, 11, 0.28);
    }
    :host([hidden]) {
      display: none !important;
    }
    :host([data-theme="light"]) {
      --hud-bg-hover: rgba(15, 23, 42, 0.06);
      --hud-bg-active: rgba(15, 23, 42, 0.10);
      --hud-fg: #64748b;
      --hud-fg-strong: #1e293b;
      --hud-surface: #fcfcfd;
      --hud-surface-elev: #f3f4f6;
      --hud-border: rgba(15, 23, 42, 0.10);
      --hud-divider: rgba(15, 23, 42, 0.15);
      --hud-accent: #0284c7;
      --hud-tools: #4f46e5;
      --hud-chat: #059669;
      --hud-warn: #d97706;
      --hud-danger: #dc2626;
      --hud-shadow: 0 10px 24px rgba(15, 23, 42, 0.11), 0 2px 6px rgba(15, 23, 42, 0.05);
    }
    * {
      box-sizing: border-box;
    }

    /* 两个独立的小巧胶囊按钮 */
    .hud-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      padding: 0 6px;
      gap: 4px;
      border-radius: 9999px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--hud-fg);
      font: inherit;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      outline: none;
      white-space: nowrap;
      transition: opacity 110ms ease, transform 110ms ease;
    }
    .hud-btn.ctx-only-ring {
      padding: 0 4px;
      min-width: 22px;
    }
    .hud-btn:hover {
      background: var(--hud-bg-hover);
      color: var(--hud-fg-strong);
    }
    .hud-btn[aria-expanded="true"] {
      background: var(--hud-bg-active);
      color: var(--hud-fg-strong);
      border-color: var(--hud-border);
    }
    .hud-btn:active {
      transform: scale(0.97);
    }

    .ring-wrap {
      width: 13px;
      height: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .ring-svg {
      width: 13px;
      height: 13px;
      transform: rotate(-90deg);
      overflow: visible;
    }
    .ring-track {
      fill: none;
      stroke: currentColor;
      stroke-opacity: 0.22;
      stroke-width: 1.8;
    }
    .ring-fill {
      fill: none;
      stroke: var(--hud-accent);
      stroke-width: 2.0;
      stroke-linecap: round;
      transition: stroke-dasharray 220ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    :host([data-level="warn"]) .ring-fill {
      stroke: var(--hud-warn);
    }
    :host([data-level="danger"]) .ring-fill {
      stroke: var(--hud-danger);
    }

    .ctx-inline-text {
      font-size: 10.5px;
      font-weight: 500;
      color: var(--hud-fg-strong);
    }
    .ctx-inline-text[hidden] {
      display: none !important;
    }

    .tps-val {
      font-weight: 500;
      color: var(--hud-fg-strong);
    }
    .tps-unit {
      font-size: 10px;
      opacity: 0.72;
    }
    :host([data-streaming="true"]) #btn-tps {
      color: var(--hud-accent);
    }

    /* 极简小字号独立悬停 Tooltip */
    .hud-tip {
      position: fixed;
      z-index: 2147483600;
      pointer-events: none;
      background: var(--hud-surface);
      color: var(--hud-fg-strong);
      border: 1px solid var(--hud-border);
      border-radius: 6px;
      padding: 3px 7px;
      box-shadow: var(--hud-shadow);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      line-height: 1.35;
      white-space: nowrap;
      opacity: 0;
      transform: translateY(3px) scale(0.98);
      transition: opacity 100ms cubic-bezier(0.16, 1, 0.3, 1), transform 100ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .hud-tip[data-open="true"] {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    /* 紧凑型详情浮层 (316px) */
    .hud-popover {
      position: fixed;
      z-index: 2147483640;
      width: 316px;
      max-width: calc(100vw - 20px);
      background: var(--hud-surface);
      color: var(--hud-fg-strong);
      border: 1px solid var(--hud-border);
      border-radius: 10px;
      box-shadow: var(--hud-shadow);
      padding: 10px;
      opacity: 0;
      pointer-events: none;
      transform: translateY(5px) scale(0.985);
      transform-origin: bottom right;
      transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1), transform 130ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .hud-popover[data-open="true"] {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }
    .pop-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--hud-border);
    }
    .pop-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--hud-fg);
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .badge-tag {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: 999px;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      background: rgba(56, 189, 248, 0.14);
      color: var(--hud-accent);
    }
    .badge-tag[data-tone="warn"] {
      background: rgba(245, 158, 11, 0.16);
      color: var(--hud-warn);
    }
    .badge-tag[data-tone="danger"] {
      background: rgba(239, 68, 68, 0.16);
      color: var(--hud-danger);
    }
    .badge-tag[data-tone="good"] {
      background: rgba(52, 211, 153, 0.15);
      color: var(--hud-chat);
    }
    .hdr-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .mini-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      padding: 0 5px;
      border-radius: 4px;
      border: 1px solid var(--hud-border);
      background: transparent;
      color: var(--hud-fg);
      font-size: 10px;
      cursor: pointer;
    }
    .mini-btn:hover {
      background: var(--hud-bg-hover);
      color: var(--hud-fg-strong);
    }
    .mini-btn[data-on="true"] {
      border-color: var(--hud-accent);
      color: var(--hud-accent);
      background: rgba(56, 189, 248, 0.10);
    }

    .ctx-main-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 5px;
      font-variant-numeric: tabular-nums;
    }
    .ctx-big {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--hud-fg-strong);
    }
    .ctx-sub {
      font-size: 10.5px;
      color: var(--hud-fg);
    }
    .stack-bar {
      width: 100%;
      height: 5px;
      border-radius: 999px;
      background: var(--hud-bg-hover);
      overflow: hidden;
      display: flex;
      gap: 1px;
      margin-bottom: 8px;
    }
    .stack-seg {
      height: 100%;
      transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .seg-sys { background: var(--hud-accent); }
    .seg-tools { background: var(--hud-tools); }
    .seg-chat { background: var(--hud-chat); }

    .alert-banner {
      margin-bottom: 6px;
      padding: 4px 6px;
      border-radius: 5px;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.28);
      color: var(--hud-warn);
      font-size: 10px;
      line-height: 1.3;
    }

    .groups-box {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .grp-card {
      border: 1px solid var(--hud-border);
      border-radius: 6px;
      background: var(--hud-surface-elev);
      overflow: hidden;
    }
    .grp-hdr {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 7px;
      background: transparent;
      border: 0;
      color: var(--hud-fg-strong);
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
    }
    .grp-hdr:hover {
      background: var(--hud-bg-hover);
    }
    .grp-left {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 99px;
      display: inline-block;
    }
    .dot-sys { background: var(--hud-accent); }
    .dot-tools { background: var(--hud-tools); }
    .dot-chat { background: var(--hud-chat); }
    .grp-right {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
      color: var(--hud-fg);
      font-size: 10px;
    }
    .grp-children {
      border-top: 1px solid var(--hud-border);
      padding: 4px 7px 5px 15px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 110px;
      overflow-y: auto;
    }
    .grp-children::-webkit-scrollbar { width: 3px; }
    .grp-children::-webkit-scrollbar-thumb { background: var(--hud-divider); border-radius: 2px; }
    .child-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      color: var(--hud-fg);
      font-variant-numeric: tabular-nums;
    }
    .child-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 185px;
    }
    .child-val {
      color: var(--hud-fg-strong);
      font-weight: 500;
    }

    .sec-label {
      font-size: 9.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--hud-fg);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tps-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
      margin-bottom: 6px;
    }
    .tps-cell {
      border: 1px solid var(--hud-border);
      border-radius: 5px;
      padding: 4px 5px;
      background: var(--hud-surface-elev);
      font-variant-numeric: tabular-nums;
    }
    .cell-k {
      font-size: 9.5px;
      color: var(--hud-fg);
    }
    .cell-v {
      font-size: 11px;
      font-weight: 600;
      color: var(--hud-fg-strong);
    }
    .io-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 7px;
      border-radius: 5px;
      border: 1px solid var(--hud-border);
      background: var(--hud-surface-elev);
      font-size: 10px;
      color: var(--hud-fg);
      font-variant-numeric: tabular-nums;
      margin-bottom: 6px;
    }
    .io-item b {
      color: var(--hud-fg-strong);
      font-weight: 600;
    }
    .pop-ftr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      color: var(--hud-fg);
      padding-top: 5px;
      border-top: 1px solid var(--hud-border);
      gap: 6px;
    }
    .ftr-model {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 235px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .ftr-model-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-weight: 600;
      color: var(--hud-fg-strong);
    }
    .ftr-model-id[data-routed="true"] {
      color: var(--hud-warn);
    }
    .routed-tag {
      padding: 0 4px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      background: rgba(245, 158, 11, 0.16);
      color: var(--hud-warn);
    }
  </style>

  <!-- 按钮 1：独立的上下文圆环按钮（默认仅显示圆圈，可开关常驻文字） -->
  <button type="button" class="hud-btn ctx-only-ring" id="btn-ctx" aria-expanded="false" aria-label="Context Window">
    <span class="ring-wrap">
      <svg class="ring-svg" viewBox="0 0 13 13">
        <circle class="ring-track" cx="6.5" cy="6.5" r="${RING_R}"></circle>
        <circle class="ring-fill" id="ring-fill" cx="6.5" cy="6.5" r="${RING_R}" stroke-dasharray="0 ${RING_C.toFixed(2)}"></circle>
      </svg>
    </span>
    <span class="ctx-inline-text" id="ctx-inline-text" hidden>--</span>
  </button>

  <!-- 按钮 2：独立的 TPS 按钮（无闪电图标） -->
  <button type="button" class="hud-btn" id="btn-tps" aria-expanded="false" aria-label="Generation Speed">
    <span class="tps-val" id="pill-tps-val">--</span>
    <span class="tps-unit" id="pill-tps-unit">tok/s</span>
  </button>

  <!-- 独立悬停气泡 1：上下文圆环专用（只显示具体数值和占用比） -->
  <div class="hud-tip" id="tip-ctx" data-open="false"></div>

  <!-- 独立悬停气泡 2：TPS 专用（精简速度与延迟） -->
  <div class="hud-tip" id="tip-tps" data-open="false"></div>

  <!-- 点击展开的紧凑详情浮层 -->
  <div class="hud-popover" id="hud-popover" data-open="false" role="dialog" aria-label="Context & TPS Inspector">
    <div class="pop-hdr">
      <div class="pop-title">
        <span>CONTEXT &amp; TPS</span>
        <span class="badge-tag" id="pop-cap-badge">256K</span>
        <span class="badge-tag" id="pop-state-badge" data-tone="good">就绪</span>
      </div>
      <div class="hdr-actions">
        <button type="button" class="mini-btn" id="btn-toggle-text" title="切换是否在圆圈旁常驻显示上下文数值">常驻文字: 关</button>
        <button type="button" class="mini-btn" id="btn-refresh" title="立即刷新">↻</button>
      </div>
    </div>

    <div class="alert-banner" id="pop-alert" hidden></div>

    <div class="ctx-main-row">
      <div>
        <span class="ctx-big" id="pop-ctx-used">—</span>
        <span class="ctx-sub" id="pop-ctx-max"> / 256,000 (—)</span>
      </div>
      <div class="ctx-sub" id="pop-ctx-remain">余 —</div>
    </div>

    <div class="stack-bar">
      <div class="stack-seg seg-sys" id="bar-sys" style="width: 0%"></div>
      <div class="stack-seg seg-tools" id="bar-tools" style="width: 0%"></div>
      <div class="stack-seg seg-chat" id="bar-chat" style="width: 0%"></div>
    </div>

    <div class="groups-box" id="pop-groups"></div>

    <div class="sec-label">
      <span>SPEED &amp; LATENCY</span>
      <span id="pop-turn-tag">最新实测</span>
    </div>
    <div class="tps-grid">
      <div class="tps-cell">
        <div class="cell-k">综合 TPS</div>
        <div class="cell-v" id="cell-overall-tps">—</div>
      </div>
      <div class="tps-cell">
        <div class="cell-k">流式 TPS</div>
        <div class="cell-v" id="cell-stream-tps">—</div>
      </div>
      <div class="tps-cell">
        <div class="cell-k">TTFT</div>
        <div class="cell-v" id="cell-ttft">—</div>
      </div>
      <div class="tps-cell">
        <div class="cell-k">流耗时</div>
        <div class="cell-v" id="cell-stream-sec">—</div>
      </div>
    </div>

    <div class="io-strip">
      <span class="io-item">输入 <b id="io-in">—</b></span>
      <span class="io-item">思考 <b id="io-think">—</b></span>
      <span class="io-item">回复 <b id="io-out">—</b></span>
      <span class="io-item">总计 <b id="io-total">—</b></span>
    </div>

    <div class="pop-ftr">
      <span class="ftr-model" id="ftr-model">model id: <span class="ftr-model-id" id="ftr-model-id">—</span></span>
      <span id="ftr-time">—</span>
    </div>
  </div>`;

  const $ = (id) => shadow.getElementById(id);

  // 2. 主题自适应同步
  function syncTheme() {
    try {
      const root = document.documentElement;
      if (root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark') {
        host.setAttribute('data-theme', 'dark');
        return;
      }
      if (root.classList.contains('light') || root.getAttribute('data-theme') === 'light') {
        host.setAttribute('data-theme', 'light');
        return;
      }
      const probes = [
        document.querySelector('.surface-composer-card'),
        document.body,
        root,
      ].filter(Boolean);
      for (const el of probes) {
        const st = getComputedStyle(el);
        const bg = st.backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
        if (m) {
          const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
          if (alpha > 0.2) {
            const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
            host.setAttribute('data-theme', lum > 0.55 ? 'light' : 'dark');
            return;
          }
        }
      }
      const fg = getComputedStyle(document.body || root).color || '';
      const fm = fg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (fm) {
        const fgLum = (0.299 * Number(fm[1]) + 0.587 * Number(fm[2]) + 0.114 * Number(fm[3])) / 255;
        host.setAttribute('data-theme', fgLum < 0.45 ? 'light' : 'dark');
        return;
      }
      host.setAttribute('data-theme', 'light');
    } catch {
      host.setAttribute('data-theme', 'dark');
    }
  }

  // 3. 挂载到底部 .agy-composer-footer 的 Request Review 按钮左侧
  function findTargetAnchor() {
    try {
      const footers = Array.from(document.querySelectorAll('.agy-composer-footer'));
      if (!footers.length) return null;
      const footer = footers.find((f) => f.offsetParent !== null) || footers[0];
      const permBtn = footer.querySelector('[data-testid="permissions-selector-trigger"]');
      if (permBtn && permBtn.parentElement) {
        return { container: permBtn.parentElement, before: permBtn, footer };
      }
      const rightCluster = footer.querySelector(':scope > div.shrink-0') || footer.lastElementChild;
      if (rightCluster && rightCluster !== footer.firstElementChild) {
        return { container: rightCluster, before: rightCluster.firstChild, footer };
      }
      return { container: footer, before: null, footer };
    } catch {
      return null;
    }
  }

  let observedFooter = null;
  let footerResizeObs = null;

  function ensureDocked() {
    if (state.disposed) return false;
    const anchor = findTargetAnchor();
    if (!anchor) return false;

    const { container, before, footer } = anchor;
    if (before) {
      if (host.parentElement !== container || host.nextElementSibling !== before) {
        container.insertBefore(host, before);
      }
    } else if (host.parentElement !== container) {
      container.appendChild(host);
    }

    if (observedFooter !== footer) {
      observedFooter = footer;
      try {
        footerResizeObs?.disconnect?.();
        if (typeof ResizeObserver !== 'undefined') {
          footerResizeObs = new ResizeObserver(() => repositionActiveOverlays());
          footerResizeObs.observe(footer);
        }
      } catch {}
    }
    return true;
  }

  function positionTipAboveButton(tipEl, btnEl) {
    if (!tipEl || !btnEl?.getBoundingClientRect) return;
    const r = btnEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    const vw = window.innerWidth || 1280;
    const tRect = tipEl.getBoundingClientRect();
    const w = tRect.width || 130;
    const h = tRect.height || 22;

    const top = Math.max(6, Math.round(r.top - h - 6));
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(8, Math.min(vw - w - 8, left));

    tipEl.style.top = `${top}px`;
    tipEl.style.left = `${left}px`;
  }

  function positionPopover() {
    const pop = $('hud-popover');
    if (!pop || !host.getBoundingClientRect) return;
    const r = host.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const pRect = pop.getBoundingClientRect();
    const w = pRect.width || 316;
    const h = pRect.height || 260;

    let top = Math.round(r.top - h - 7);
    if (top < 8) {
      top = Math.min(vh - h - 8, Math.round(r.bottom + 7));
    }
    let left = Math.round(r.right - w);
    left = Math.max(8, Math.min(vw - w - 8, left));

    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function repositionActiveOverlays() {
    if (state.popoverOpen) positionPopover();
    if (state.hoverTarget === 'ctx') positionTipAboveButton($('tip-ctx'), $('btn-ctx'));
    if (state.hoverTarget === 'tps') positionTipAboveButton($('tip-tps'), $('btn-tps'));
  }

  // 4. 解析 GetCascadeTrajectoryGeneratorMetadata
  function parseGeneratorMetadataRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return false;

    let latestCtxRow = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.chatModel?.chatStartMetadata?.contextWindowMetadata) {
        latestCtxRow = rows[i];
        break;
      }
    }
    const tailRow = rows[rows.length - 1];

    if (latestCtxRow) {
      const cwm = latestCtxRow.chatModel.chatStartMetadata.contextWindowMetadata;
      const used = Number(cwm.estimatedTokensUsed ?? cwm.tokenBreakdown?.totalTokens ?? 0);
      const rawMax = Number(cwm.maxContextTokens || 256000);
      const max = state.overrideCap > 0 ? state.overrideCap : (rawMax > 0 ? rawMax : 256000);
      const rawGroups = Array.isArray(cwm.tokenBreakdown?.groups) ? cwm.tokenBreakdown.groups : [];

      state.ctx.used = used > 0 ? used : null;
      state.ctx.max = max;
      state.ctx.pct = state.ctx.used != null && state.ctx.max > 0
        ? Math.min(100, Math.max(0, (state.ctx.used / state.ctx.max) * 100))
        : null;
      state.ctx.groups = rawGroups.map((g) => ({
        name: g.name || 'Other',
        numTokens: Number(g.numTokens || 0),
        children: Array.isArray(g.children)
          ? g.children
              .map((c) => ({ name: c.name || '', numTokens: Number(c.numTokens || 0) }))
              .filter((c) => c.numTokens > 0)
              .sort((a, b) => b.numTokens - a.numTokens)
          : [],
      }));
    }

    const retries = tailRow?.chatModel?.retryInfos;
    if (Array.isArray(retries) && retries.length > 0) {
      const lastRetry = retries[retries.length - 1];
      if (lastRetry?.error) {
        state.ctx.retryError = String(lastRetry.error);
        state.ctx.retryCount = retries.length;
        state.ctx.retryWaitSec = parseProtoDurationSec(lastRetry.waitTime);
        state.ctx.exceeded = /exceeds the maximum|context length|too many tokens/i.test(state.ctx.retryError);
      } else {
        state.ctx.retryError = null;
        state.ctx.retryCount = 0;
        state.ctx.retryWaitSec = null;
        state.ctx.exceeded = false;
      }
    } else {
      state.ctx.retryError = null;
      state.ctx.retryCount = 0;
      state.ctx.retryWaitSec = null;
      state.ctx.exceeded = false;
    }

    let speedRow = null;
    let speedIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const cm = rows[i]?.chatModel;
      const u = cm?.usage;
      const outTok = Number(u?.outputTokens || 0);
      if (outTok > 0) {
        speedRow = cm;
        speedIdx = i;
        break;
      }
    }

    // 检查预期模型 vs 实际响应模型是否发生路由偏移
    function detectModelRoutingMismatch(displayName, respModel, reqEnum, respEnum) {
      if (!respModel) return false;
      if (reqEnum && respEnum && reqEnum !== respEnum) return true;
      const disp = String(displayName || '').toLowerCase();
      const actual = String(respModel || '').toLowerCase();
      if (!disp) return false;
      if (disp.includes('argon') && !actual.includes('argon')) return true;
      if (disp.includes('flash') && !actual.includes('flash')) return true;
      if (disp.includes('opus') && !actual.includes('opus')) return true;
      if (disp.includes('sonnet') && !actual.includes('sonnet')) return true;
      return false;
    }

    // 尝试从 retryInfos 错误文本提取网关请求的目标模型 ID（当尚未成功返回 responseModel 时作为兜底）
    function extractRetryTargetModel(row) {
      const retries = row?.chatModel?.retryInfos;
      if (!Array.isArray(retries)) return '';
      for (let i = retries.length - 1; i >= 0; i--) {
        const m = String(retries[i]?.error || '').match(/for model\s+([a-z0-9._-]+)\s+on the server/i);
        if (m) return m[1];
      }
      return '';
    }

    if (speedRow) {
      const u = speedRow.usage || {};
      const inTok = Number(u.inputTokens || 0);
      const outTok = Number(u.outputTokens || 0);
      const thinkTok = Number(u.thinkingOutputTokens || 0);
      const respTok = Number(u.responseOutputTokens || Math.max(0, outTok - thinkTok));
      const cacheTok = Number(u.cacheReadTokens || u.cachedContentTokenCount || 0);

      const ttftSec = parseProtoDurationSec(speedRow.timeToFirstToken);
      const streamSec = parseProtoDurationSec(speedRow.streamingDuration);
      const totalSec = (ttftSec || 0) + (streamSec || 0);

      const overallTps = outTok > 0 && totalSec >= 0.04 ? Number((outTok / totalSec).toFixed(1)) : null;
      const streamBaseTok = respTok > 0 ? respTok : outTok;
      const streamTps = streamBaseTok > 0 && streamSec != null && streamSec >= 0.03
        ? Number((streamBaseTok / streamSec).toFixed(1))
        : overallTps;

      const dispName = tailRow?.chatModel?.modelDisplayName || speedRow.modelDisplayName || '';
      const reqEnum = tailRow?.chatModel?.model || speedRow.model || '';
      const respEnum = speedRow.usage?.model || speedRow.model || '';
      const actualModelId = speedRow.responseModel || tailRow?.chatModel?.responseModel || extractRetryTargetModel(tailRow) || respEnum;
      const routedMismatch = detectModelRoutingMismatch(dispName, speedRow.responseModel, reqEnum, respEnum);

      state.speed = {
        overallTps,
        streamTps,
        ttftSec,
        streamSec,
        totalSec: totalSec > 0 ? totalSec : null,
        inputTokens: inTok > 0 ? inTok : null,
        outputTokens: outTok > 0 ? outTok : null,
        thinkingTokens: thinkTok,
        responseTokens: respTok,
        cacheTokens: cacheTok,
        modelName: dispName,
        reqModelEnum: reqEnum,
        responseModel: actualModelId,
        routedMismatch,
        fromPreviousTurn: speedIdx < rows.length - 1,
      };
    } else if (tailRow?.chatModel) {
      const tc = tailRow.chatModel;
      state.speed.modelName = tc.modelDisplayName || state.speed.modelName;
      state.speed.reqModelEnum = tc.model || state.speed.reqModelEnum;
      state.speed.responseModel = tc.responseModel || extractRetryTargetModel(tailRow) || tc.usage?.model || tc.model || state.speed.responseModel;
      state.speed.routedMismatch = false;
    }
    return true;
  }

  // 5. 渲染更新
  function renderGroupsDom() {
    const box = $('pop-groups');
    if (!box) return;
    const groups = state.ctx.groups || [];
    const total = state.ctx.used || 1;

    if (!groups.length) {
      box.innerHTML = `<div style="font-size:10px;color:var(--hud-fg);padding:4px;">等待会话同步…</div>`;
      return;
    }

    box.innerHTML = groups.map((g) => {
      const isSys = /System/i.test(g.name);
      const isTools = /Tool/i.test(g.name);
      const dotCls = isSys ? 'dot-sys' : isTools ? 'dot-tools' : 'dot-chat';
      const labelCn = isSys ? 'System Prompt' : isTools ? 'Native Tools' : 'Chat Messages';
      const pct = Math.min(100, Math.max(0, (g.numTokens / total) * 100)).toFixed(1);
      const expanded = !!state.expandedGroups[g.name];
      const arrow = expanded ? '▾' : '▸';

      const childrenHtml = expanded && g.children.length
        ? `<div class="grp-children">${g.children
            .slice(0, 16)
            .map(
              (c) => `<div class="child-row">
                <span class="child-name">${c.name.replace(/[<>&]/g, '')}</span>
                <span class="child-val">${fmtNum(c.numTokens)}</span>
              </div>`
            )
            .join('')}</div>`
        : '';

      return `<div class="grp-card">
        <button type="button" class="grp-hdr" data-grp="${g.name}">
          <span class="grp-left">
            <span class="dot ${dotCls}"></span>
            <span>${labelCn}</span>
          </span>
          <span class="grp-right">
            <span>${fmtNum(g.numTokens)} (${pct}%)</span>
            <span>${arrow}</span>
          </span>
        </button>
        ${childrenHtml}
      </div>`;
    }).join('');

    for (const btn of box.querySelectorAll('.grp-hdr')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.getAttribute('data-grp');
        if (name) {
          state.expandedGroups[name] = !state.expandedGroups[name];
          renderGroupsDom();
        }
      });
    }
  }

  function render() {
    if (state.disposed) return;
    ensureDocked();

    if (state.overrideCap > 0 && state.ctx.max !== state.overrideCap) {
      state.ctx.max = state.overrideCap;
      if (state.ctx.used != null) {
        state.ctx.pct = Math.min(100, Math.max(0, (state.ctx.used / state.ctx.max) * 100));
      }
    }
    const { used, max, pct, groups, exceeded, retryError, retryCount, retryWaitSec } = state.ctx;
    const sp = state.speed;

    let level = 'normal';
    if (exceeded || (pct != null && pct >= 90)) level = 'danger';
    else if ((pct != null && pct >= 75) || retryError) level = 'warn';
    host.setAttribute('data-level', level);
    host.setAttribute('data-streaming', state.inFlight ? 'true' : 'false');

    // 1. 圆环进度与可选内联文字
    const ringFill = $('ring-fill');
    if (ringFill) {
      if (pct != null && pct > 0) {
        const arc = Math.max(1.8, (Math.min(100, pct) / 100) * RING_C);
        ringFill.setAttribute('stroke-dasharray', `${arc.toFixed(2)} ${RING_C.toFixed(2)}`);
      } else {
        ringFill.setAttribute('stroke-dasharray', `2.0 ${RING_C.toFixed(2)}`);
      }
    }

    const btnCtx = $('btn-ctx');
    const inlineText = $('ctx-inline-text');
    const toggleBtn = $('btn-toggle-text');
    if (state.showCtxText) {
      btnCtx.classList.remove('ctx-only-ring');
      inlineText.hidden = false;
      inlineText.textContent = used != null
        ? `${fmtShort(used)} (${pct != null ? (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%' : '--'})`
        : '--';
      toggleBtn.textContent = '常驻文字: 开';
      toggleBtn.setAttribute('data-on', 'true');
    } else {
      btnCtx.classList.add('ctx-only-ring');
      inlineText.hidden = true;
      toggleBtn.textContent = '常驻文字: 关';
      toggleBtn.setAttribute('data-on', 'false');
    }

    // 2. TPS 独立按钮（无闪电图标）
    const pillTpsVal = $('pill-tps-val');
    const pillTpsUnit = $('pill-tps-unit');
    if (state.inFlight) {
      const elapsed = Math.max(0.1, (performance.now() - state.inFlightSince) / 1000);
      pillTpsVal.textContent = `${elapsed.toFixed(1)}s`;
      pillTpsUnit.textContent = '';
    } else if (retryError && !sp.overallTps) {
      pillTpsVal.textContent = '503';
      pillTpsUnit.textContent = '重试';
    } else if (sp.overallTps != null) {
      pillTpsVal.textContent = String(sp.overallTps);
      pillTpsUnit.textContent = 'tok/s';
    } else {
      pillTpsVal.textContent = '--';
      pillTpsUnit.textContent = 'tok/s';
    }

    // 3. 两个分离的极简小字号悬停气泡
    // 3.1 上下文圆圈悬停：只显示具体的数值和占用比
    const tipCtx = $('tip-ctx');
    if (used != null && pct != null) {
      tipCtx.textContent = `${fmtNum(used)} / ${fmtNum(max)} (${pct.toFixed(1)}%)`;
    } else {
      tipCtx.textContent = `0 / ${fmtNum(max)} (0.0%)`;
    }

    // 3.2 TPS 按钮悬停：简化内容，小字显示核心流式速度与首字延迟
    const tipTps = $('tip-tps');
    if (state.inFlight) {
      const elapsed = Math.max(0.1, (performance.now() - state.inFlightSince) / 1000);
      tipTps.textContent = `生成中 ${elapsed.toFixed(1)}s`;
    } else if (sp.overallTps != null) {
      const parts = [`综合 ${sp.overallTps} tok/s`];
      if (sp.streamTps && sp.streamTps !== sp.overallTps) {
        parts.push(`流式 ${sp.streamTps}`);
      }
      if (sp.ttftSec != null) {
        parts.push(`TTFT ${sp.ttftSec.toFixed(2)}s`);
      }
      if (sp.outputTokens != null) {
        parts.push(`${fmtNum(sp.outputTokens)} tok`);
      }
      tipTps.textContent = parts.join(' · ');
    } else {
      tipTps.textContent = '暂无生成速度记录';
    }

    // 4. 详情浮层 (Popover)
    const capBadge = $('pop-cap-badge');
    capBadge.textContent = max >= 900000 ? '1M 解锁' : max >= 500000 ? '512K' : '256K';
    capBadge.setAttribute('data-tone', max >= 500000 ? 'good' : 'normal');

    const stateBadge = $('pop-state-badge');
    if (exceeded) {
      stateBadge.textContent = '超限';
      stateBadge.setAttribute('data-tone', 'danger');
    } else if (retryError) {
      stateBadge.textContent = `重试(${retryCount})`;
      stateBadge.setAttribute('data-tone', 'warn');
    } else if (state.inFlight) {
      stateBadge.textContent = '生成中';
      stateBadge.setAttribute('data-tone', 'normal');
    } else if (state.isBaseline) {
      stateBadge.textContent = '基准';
      stateBadge.setAttribute('data-tone', 'good');
    } else {
      stateBadge.textContent = pct != null && pct >= 80 ? '偏高' : '正常';
      stateBadge.setAttribute('data-tone', pct != null && pct >= 80 ? 'warn' : 'good');
    }

    const alertEl = $('pop-alert');
    if (retryError) {
      alertEl.hidden = false;
      const waitStr = retryWaitSec != null ? ` · ${retryWaitSec.toFixed(0)}s` : '';
      alertEl.textContent = `重试 #${retryCount}${waitStr}: ${retryError.slice(0, 90)}`;
    } else {
      alertEl.hidden = true;
    }

    $('pop-ctx-used').textContent = used != null ? `${fmtNum(used)}` : '—';
    $('pop-ctx-max').textContent = ` / ${fmtNum(max)} (${pct != null ? pct.toFixed(1) + '%' : '—'})`;
    $('pop-ctx-remain').textContent = used != null ? `余 ${fmtShort(Math.max(0, max - used))}` : '余 —';

    const sysG = groups.find((g) => /System/i.test(g.name))?.numTokens || 0;
    const toolG = groups.find((g) => /Tool/i.test(g.name))?.numTokens || 0;
    const chatG = groups.find((g) => /Chat/i.test(g.name))?.numTokens || 0;
    const denom = Math.max(used || 0, sysG + toolG + chatG, 1);
    $('bar-sys').style.width = `${Math.min(100, (sysG / denom) * 100).toFixed(1)}%`;
    $('bar-tools').style.width = `${Math.min(100, (toolG / denom) * 100).toFixed(1)}%`;
    $('bar-chat').style.width = `${Math.min(100, (chatG / denom) * 100).toFixed(1)}%`;

    renderGroupsDom();

    $('pop-turn-tag').textContent = state.inFlight
      ? '生成中…'
      : sp.fromPreviousTurn
      ? '上轮记录'
      : state.isBaseline
      ? '最近会话'
      : '本轮实测';

    $('cell-overall-tps').textContent = sp.overallTps != null ? `${sp.overallTps}` : '—';
    $('cell-stream-tps').textContent = sp.streamTps != null ? `${sp.streamTps}` : '—';
    $('cell-ttft').textContent = sp.ttftSec != null ? `${sp.ttftSec.toFixed(2)}s` : '—';
    $('cell-stream-sec').textContent = sp.streamSec != null ? `${sp.streamSec.toFixed(2)}s` : '—';

    $('io-in').textContent = fmtShort(sp.inputTokens ?? used);
    $('io-think').textContent = fmtShort(sp.thinkingTokens);
    $('io-out').textContent = fmtShort(sp.responseTokens);
    $('io-total').textContent = fmtShort(sp.outputTokens);

    const ftrModel = $('ftr-model');
    const actualId = sp.responseModel || '未获取';
    const routeHtml = sp.routedMismatch ? `<span class="routed-tag">已路由</span>` : '';
    ftrModel.innerHTML = `<span>model id:</span><span class="ftr-model-id" data-routed="${sp.routedMismatch ? 'true' : 'false'}">${actualId.replace(/[<>&]/g, '')}</span>${routeHtml}`;
    ftrModel.title = `请求模型: ${sp.modelName || '—'} (${sp.reqModelEnum || '—'})\n真实返回 model id: ${actualId}`;
    $('ftr-time').textContent = state.lastPollAt ? new Date(state.lastPollAt).toLocaleTimeString() : '—';
  }

  // 6. RPC 数据拉取
  function detectRouteCascadeId() {
    const m = location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  async function rpcPost(method, body) {
    const csrf = window.__APP_CONFIG__?.csrfToken;
    if (!csrf) return null;
    const res = await fetch(`/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function pollMetadata() {
    if (state.disposed || state.pollBusy) return;
    const routeId = detectRouteCascadeId();
    if (routeId) {
      state.cascadeId = routeId;
      state.isBaseline = false;
    }

    let targetId = state.cascadeId || state.baselineId;
    state.pollBusy = true;

    try {
      if (!targetId) {
        const all = await rpcPost('GetAllCascadeTrajectories', {});
        const summaries = all?.trajectorySummaries || {};
        const entries = Object.entries(summaries);
        if (entries.length > 0) {
          entries.sort((a, b) => String(b[1]?.lastModifiedTime || '').localeCompare(String(a[1]?.lastModifiedTime || '')));
          state.baselineId = entries[0][0];
          targetId = state.baselineId;
          state.isBaseline = !state.cascadeId;
        } else if (window.__AGY_LATEST_CASCADE_ID__) {
          state.baselineId = String(window.__AGY_LATEST_CASCADE_ID__);
          targetId = state.baselineId;
          state.isBaseline = !state.cascadeId;
        }
      }

      if (!targetId) return;

      const data = await rpcPost('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: targetId,
        generatorMetadataOffset: 0,
        includeMessages: false,
      });
      if (state.disposed || !data) return;

      const rows = data.generatorMetadata || [];
      if (rows.length > 0) {
        parseGeneratorMetadataRows(rows);
        state.lastPollAt = Date.now();
      } else {
        // 若当前还没有历史记录，仍更新时间戳避免每 200ms 高频空刷，但 2 秒后会再次尝试
        state.lastPollAt = Date.now() - 1000;
      }
    } catch {} finally {
      state.pollBusy = false;
      render();
    }
  }

  // 7. 拦截 window.fetch 感知流式生成
  const origFetch = window.fetch;
  if (typeof origFetch === 'function' && !origFetch.__agyHudHooked) {
    const hookedFetch = async function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const isStreamCall = /LanguageServerService\/(SendUserCascadeMessage|ResumeCascade|StreamCascadeReactiveUpdates|StartCascade)/i.test(reqUrl);
      const isMetaCall = /LanguageServerService\/GetCascadeTrajectoryGeneratorMetadata/i.test(reqUrl);

      if (isStreamCall && args[1]?.body && typeof args[1].body === 'string') {
        try {
          const parsed = JSON.parse(args[1].body);
          if (parsed?.cascadeId && typeof parsed.cascadeId === 'string') {
            state.cascadeId = parsed.cascadeId;
            state.isBaseline = false;
          }
        } catch {}
      }

      const isSendTurn = /LanguageServerService\/(SendUserCascadeMessage|ResumeCascade)/i.test(reqUrl);
      if (isSendTurn) {
        state.inFlight = true;
        state.inFlightSince = performance.now();
        render();
      }

      try {
        const response = await origFetch.apply(this, args);
        if (isSendTurn) {
          setTimeout(() => {
            state.inFlight = false;
            void pollMetadata();
          }, 150);
          setTimeout(() => void pollMetadata(), 1000);
        } else if (!isMetaCall && /LanguageServerService\/GetCascadeTrajectory/i.test(reqUrl)) {
          setTimeout(() => void pollMetadata(), 200);
        }
        return response;
      } catch (err) {
        if (isSendTurn) {
          state.inFlight = false;
          render();
        }
        throw err;
      }
    };
    hookedFetch.__agyHudHooked = true;
    hookedFetch.__origFetch = origFetch;
    window.fetch = hookedFetch;
  }

  // 8. 独立悬停与点击事件绑定
  const btnCtx = $('btn-ctx');
  const btnTps = $('btn-tps');
  const tipCtx = $('tip-ctx');
  const tipTps = $('tip-tps');
  const popoverEl = $('hud-popover');

  function setHoverTarget(target) {
    if (state.popoverOpen) target = null;
    state.hoverTarget = target;
    tipCtx.setAttribute('data-open', target === 'ctx' ? 'true' : 'false');
    tipTps.setAttribute('data-open', target === 'tps' ? 'true' : 'false');
    if (target === 'ctx') positionTipAboveButton(tipCtx, btnCtx);
    if (target === 'tps') positionTipAboveButton(tipTps, btnTps);
  }

  function setPopoverOpen(open) {
    state.popoverOpen = open;
    if (open) setHoverTarget(null);
    btnCtx.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnTps.setAttribute('aria-expanded', open ? 'true' : 'false');
    popoverEl.setAttribute('data-open', open ? 'true' : 'false');
    if (open) {
      void pollMetadata();
      render();
      requestAnimationFrame(() => positionPopover());
    }
  }

  btnCtx.addEventListener('mouseenter', () => setHoverTarget('ctx'));
  btnCtx.addEventListener('mouseleave', () => {
    if (state.hoverTarget === 'ctx') setHoverTarget(null);
  });
  btnTps.addEventListener('mouseenter', () => setHoverTarget('tps'));
  btnTps.addEventListener('mouseleave', () => {
    if (state.hoverTarget === 'tps') setHoverTarget(null);
  });

  btnCtx.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverOpen(!state.popoverOpen);
  });
  btnTps.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverOpen(!state.popoverOpen);
  });

  $('btn-toggle-text').addEventListener('click', (e) => {
    e.stopPropagation();
    state.showCtxText = !state.showCtxText;
    saveShowTextPref(state.showCtxText);
    render();
    requestAnimationFrame(() => positionPopover());
  });

  $('btn-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    void pollMetadata();
  });

  popoverEl.addEventListener('click', (e) => e.stopPropagation());

  const onDocClick = (e) => {
    if (!state.popoverOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(host)) setPopoverOpen(false);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && state.popoverOpen) setPopoverOpen(false);
  };
  const onWinResize = () => repositionActiveOverlays();

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onWinResize);

  // 9. DOM 自愈与轮询
  let rafId = 0;
  const domObs = new MutationObserver(() => {
    if (!host.isConnected || !findTargetAnchor()?.container?.contains(host)) {
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          ensureDocked();
        });
      }
    }
  });
  if (document.body) {
    domObs.observe(document.body, { childList: true, subtree: true });
  }

  const themeObs = new MutationObserver(() => syncTheme());
  if (document.documentElement) {
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }

  let lastRouteCheck = '';
  const tickTimer = setInterval(() => {
    if (state.disposed) return;
    ensureDocked();

    const curRoute = detectRouteCascadeId() || '';
    if (curRoute !== lastRouteCheck) {
      lastRouteCheck = curRoute;
      if (curRoute) {
        state.cascadeId = curRoute;
        state.isBaseline = false;
      } else {
        state.cascadeId = null;
        state.isBaseline = true;
      }
      void pollMetadata();
    }

    if (state.inFlight) {
      render();
      if (Date.now() - state.lastPollAt > 1200) void pollMetadata();
    } else if (Date.now() - state.lastPollAt > (document.hidden ? 12000 : 3000)) {
      void pollMetadata();
    }
  }, 200);

  syncTheme();
  ensureDocked();
  render();
  void pollMetadata();

  globalThis.__AGY_HUD__ = {
    version: '1.2.0',
    refresh: () => pollMetadata(),
    setShowContextText: (show) => {
      state.showCtxText = !!show;
      saveShowTextPref(state.showCtxText);
      render();
    },
    setContextCap: (cap) => {
      const v = Number(cap || 0);
      state.overrideCap = v >= 256000 ? v : 0;
      saveOverrideCap(state.overrideCap);
      state.ctx.max = state.overrideCap > 0 ? state.overrideCap : 256000;
      if (state.ctx.used != null) {
        state.ctx.pct = Math.min(100, Math.max(0, (state.ctx.used / state.ctx.max) * 100));
      }
      render();
    },
    snapshot: () => ({
      docked: host.isConnected,
      showCtxText: state.showCtxText,
      parentClass: host.parentElement?.className || null,
      nextSiblingTestId: host.nextElementSibling?.getAttribute?.('data-testid') || null,
      ctx: state.ctx,
      speed: state.speed,
    }),
    dispose() {
      state.disposed = true;
      clearInterval(tickTimer);
      if (rafId) cancelAnimationFrame(rafId);
      try { domObs.disconnect(); } catch {}
      try { themeObs.disconnect(); } catch {}
      try { footerResizeObs?.disconnect?.(); } catch {}
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWinResize);
      if (window.fetch?.__origFetch) {
        window.fetch = window.fetch.__origFetch;
      }
      host.remove();
    },
  };
})();

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

try {
  const { app } = require('electron');
  if (app && typeof app.isReady === 'function' && !app.isReady()) {
    app.commandLine.appendSwitch('remote-debugging-port', '0');
  }
} catch {}

function getHudSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'agy-hud.js'), 'utf8');
  } catch {
    return '';
  }
}

function readConfiguredContextCap() {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return 0;
    const obj = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const cw = String(obj.contextWindow || '').toUpperCase();
    if (cw === '900K' || cw === '1M') return 983040;
    if (cw === '512K') return 512000;
    return 0;
  } catch {
    return 0;
  }
}

function findLatestCascadeIdOnDisk() {
  try {
    const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const p = path.join(dir, f);
        return { id: f.slice(0, -3), mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.id || '';
  } catch {
    return '';
  }
}

exports.installAgyHud = function (win) {
  if (!win || !win.webContents) return;
  if (process.platform === 'win32') {
    try {
      if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
      win.autoHideMenuBar = true;
    } catch {}
  }
  const inject = () => {
    try {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL() || '';
      if (!/^https:\/\/127\.0\.0\.1:\d+\//.test(url)) return;
      const src = getHudSource();
      if (src) {
        const cap = readConfiguredContextCap();
        const latestId = findLatestCascadeIdOnDisk();
        const boot = `try{if(${cap}>0)localStorage.setItem('agy-hud-ctx-cap','${cap}');else localStorage.removeItem('agy-hud-ctx-cap');window.__AGY_LATEST_CASCADE_ID__=${JSON.stringify(latestId)};}catch{};\n`;
        void win.webContents.executeJavaScript(boot + src).catch(() => {});
      }
    } catch {}
  };
  win.webContents.on('did-finish-load', inject);
  win.webContents.on('did-navigate-in-page', inject);
};

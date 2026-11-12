'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const isDev = process.argv.includes('--dev');
const OVERLAY = {
  dark: { color: '#12151d', symbolColor: '#9aa4ba' },
  light: { color: '#f4f1ea', symbolColor: '#4a5265' }
};

let win = null;
let cache = null;
let flushTimer = null;
let customDir = null;

const userDir = () => app.getPath('userData');
const workspaceFile = () => path.join(userDir(), 'workspace.json');
// 默认工作目录放在「文档」，避免剧本混在 Chromium 缓存里，也方便备份 / 网盘同步
const defaultDir = () => path.join(app.getPath('documents'), '剧本工坊');
const dataDir = () => customDir || defaultDir();
const scriptsDir = (dir = dataDir()) => path.join(dir, 'scripts');
const indexPath = (dir = dataDir()) => path.join(dir, 'library.json');
const libraryPath = () => indexPath();
const exportDir = () => dataDir();

function loadWorkspace() {
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'));
    const dir = raw && typeof raw.dataDir === 'string' ? raw.dataDir.trim() : '';
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) customDir = dir;
  } catch { customDir = null; }
}

function saveWorkspace(dir) {
  customDir = dir || null;
  fs.mkdirSync(userDir(), { recursive: true });
  const file = workspaceFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dataDir: customDir || '' }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function workspaceStatus() {
  const dir = scriptsDir();
  let scriptFiles = [];
  if (fs.existsSync(dir)) {
    scriptFiles = fs.readdirSync(dir)
      .filter(f => f.endsWith('.screenplay'))
      .map(f => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, updatedAt: st.mtimeMs };
        } catch { return null; }
      }).filter(Boolean);
  }
  return {
    dataDir: dataDir(),
    scriptsDir: dir,
    libraryPath: libraryPath(),
    defaultDir: defaultDir(),
    isCustom: Boolean(customDir),
    scriptCount: Array.isArray(cache && cache.scripts) ? cache.scripts.length : scriptFiles.length,
    scriptFiles,
    exists: fs.existsSync(libraryPath())
  };
}

// 切换目录时把当前剧本文档合并进目标目录已有的库，不覆盖任何已有剧本
function mergeLibraries(base, incoming) {
  const scripts = Array.isArray(base && base.scripts) ? base.scripts.slice() : [];
  const ids = new Set(scripts.map(s => s && s.id));
  const titles = new Set(scripts.map(s => s && s.title));
  for (const s of (incoming && Array.isArray(incoming.scripts) ? incoming.scripts : [])) {
    if (!s || ids.has(s.id) || titles.has(s.title)) continue;
    scripts.push(s);
    ids.add(s.id);
    titles.add(s.title);
  }
  return {
    scripts,
    activeId: scripts.some(s => s.id === (incoming && incoming.activeId)) ? incoming.activeId : (scripts[0] && scripts[0].id),
    settings: { ...((base && base.settings) || {}), ...((incoming && incoming.settings) || {}) }
  };
}

function setWorkspace(dir, useDefault) {
  if (!useDefault) {
    if (!dir || typeof dir !== 'string') return { ok: false, error: '无效的目录' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.scriptwriter-probe');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
    } catch (err) { return { ok: false, error: '目录不可写：' + String(err) }; }
  }
  try {
    const targetDir = useDefault ? defaultDir() : dir;
    const merged = mergeLibraries(readLibraryFrom(targetDir), cache);
    if (!merged.scripts.length) return { ok: false, error: '当前没有可迁移的剧本' };
    persistLibrary(merged, targetDir);
    saveWorkspace(useDefault ? null : dir);
    cache = merged;
    return { ok: true, ...workspaceStatus(), library: merged };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ---------- 每份剧本一个 .screenplay 工程文件 ---------- */
const lastWritten = new Map();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function safeName(title) {
  return String(title || '未命名剧本')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '').trim().slice(0, 80) || '未命名剧本';
}

function persistLibrary(data, dir = dataDir()) {
  const dirScripts = scriptsDir(dir);
  fs.mkdirSync(dirScripts, { recursive: true });
  const used = new Set();
  const index = {
    format: 'scriptwriter.index', version: 2,
    updatedAt: Date.now(),
    activeId: data.activeId || null,
    settings: data.settings || {},
    scripts: []
  };

  for (const s of (data.scripts || [])) {
    const base = safeName(s.title);
    let file = `${base}.screenplay`;
    let n = 2;
    while (used.has(file.toLowerCase())) file = `${base} (${n++}).screenplay`;
    used.add(file.toLowerCase());
    const target = path.join(dirScripts, file);
    const text = JSON.stringify({ format: 'scriptwriter.screenplay', version: 2, ...s }, null, 2);
    if (lastWritten.get(target) !== text) {
      writeAtomic(target, text);
      lastWritten.set(target, text);
    }
    index.scripts.push({ id: s.id, title: s.title, file, updatedAt: s.updatedAt || Date.now() });
  }

  // 只清理本应用生成的、已不在剧本列表里的工程文件；用户手动放入的文件保留
  const wanted = new Set(index.scripts.map(x => x.file));
  for (const f of fs.readdirSync(dirScripts)) {
    if (!f.endsWith('.screenplay') || wanted.has(f)) continue;
    const p = path.join(dirScripts, f);
    const raw = readJson(p);
    if (raw && raw.format === 'scriptwriter.screenplay') {
      try { fs.unlinkSync(p); lastWritten.delete(p); } catch {}
    }
  }

  const idxFile = indexPath(dir);
  const idxText = JSON.stringify(index, null, 2);
  if (lastWritten.get(idxFile) !== idxText) {
    writeAtomic(idxFile, idxText);
    lastWritten.set(idxFile, idxText);
  }
}

function readLibraryFrom(dir) {
  const dirScripts = scriptsDir(dir);
  if (fs.existsSync(dirScripts)) {
    const scripts = [];
    for (const f of fs.readdirSync(dirScripts).filter(x => x.endsWith('.screenplay')).sort()) {
      const raw = readJson(path.join(dirScripts, f));
      if (!raw || !Array.isArray(raw.blocks)) continue;
      delete raw.format;
      delete raw.version;
      scripts.push(raw);
    }
    if (scripts.length) {
      const index = readJson(indexPath(dir)) || {};
      return {
        scripts,
        activeId: scripts.some(s => s.id === index.activeId) ? index.activeId : scripts[0].id,
        settings: index.settings || {}
      };
    }
  }
  // 兼容旧版：整库都存在 library.json 里
  const legacy = readJson(indexPath(dir));
  if (legacy && Array.isArray(legacy.scripts) && legacy.scripts.length && legacy.scripts[0].blocks) return legacy;
  return null;
}

const readLibrary = () => readLibraryFrom(dataDir());

// 升级到新的默认工作目录时，把旧 AppData 整库迁移过去
function migrateLegacyWorkspace() {
  const target = defaultDir();
  if (readLibraryFrom(target)) return;
  const legacy = readJson(path.join(userDir(), 'library.json'));
  if (legacy && Array.isArray(legacy.scripts) && legacy.scripts.length && legacy.scripts[0].blocks) {
    persistLibrary(legacy, target);
  }
}

function flushSync() {
  if (!cache) return;
  try { persistLibrary(cache); }
  catch (err) { console.error('[library] write failed:', err); }
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSync, 300);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    backgroundColor: '#0e1117',
    title: '剧本工坊',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...OVERLAY.dark, height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // 使用自绘菜单与标题栏，避免原生菜单栏破坏布局
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 阻止把文件拖入窗口时导致整个应用导航到该文件
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', () => {
    clearTimeout(flushTimer);
    flushSync();
  });
  win.on('closed', () => { win = null; });
}

// 远程桌面 / 虚拟机 / 部分显卡驱动下，GPU 合成会让窗口左上角出现未绘制的黑块。
// 这是纯文本编辑器，软件渲染完全够用，同时让窗口与 PDF 导出更稳定。
app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.scriptwriter.studio');
    loadWorkspace();
    migrateLegacyWorkspace();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  flushSync();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', flushSync);

/* ------------------------------ IPC ------------------------------ */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  documents: app.getPath('documents')
}));

ipcMain.handle('library:load', () => {
  const data = readLibrary();
  if (data) {
    cache = data;
    try { flushSync(); } catch {}   // 旧版整库会在这里拆成独立工程文件
  }
  return data;
});

ipcMain.handle('library:save', (_event, data) => {
  if (aiLibraryLocked) return true;
  cache = data;
  scheduleFlush();
  return true;
});

ipcMain.handle('library:flush', () => {
  clearTimeout(flushTimer);
  flushSync();
  return true;
});

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '打开剧本',
    properties: ['openFile'],
    filters: [
      { name: '剧本文件', extensions: ['screenplay', 'fountain', 'spmd', 'txt', 'md', 'json'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  try {
    return { name: path.basename(file), path: file, content: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { name: path.basename(file), path: file, content: '', error: String(err) };
  }
});

ipcMain.handle('file:save', async (_event, options) => {
  const { content, defaultName = '剧本.fountain', filters } = options || {};
  const result = await dialog.showSaveDialog(win, {
    title: '导出剧本',
    defaultPath: path.join(exportDir(), defaultName),
    filters: filters || [
      { name: 'Fountain 剧本', extensions: ['fountain'] },
      { name: '纯文本', extensions: ['txt'] },
      { name: '剧本工程 (.screenplay)', extensions: ['screenplay'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.writeFileSync(result.filePath, String(content ?? ''), 'utf8');
    return { path: result.filePath };
  } catch (err) {
    return { error: String(err) };
  }
});

function exportDateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pdfDefaultName() {
  const s = cache?.scripts?.find(x => x.id === cache.activeId) || cache?.scripts?.[0];
  return `${safeName(s?.title || '剧本')}_${exportDateStamp()}.pdf`;
}

ipcMain.handle('pdf:export', async (_event, options = {}) => {
  if (!win) return { canceled: true };
  // 渲染端统一生成「剧本名_日期.pdf」；旧调用或异常入名时回退到主进程按当前剧本生成
  const raw = typeof options?.defaultName === 'string' ? path.basename(options.defaultName) : '';
  const defaultName = raw && raw.length <= 120 && /\.pdf$/i.test(raw) && !/[\\/:*?"<>|]/.test(raw)
    ? raw : pdfDefaultName();
  const result = await dialog.showSaveDialog(win, {
    title: '导出为 PDF',
    defaultPath: path.join(exportDir(), defaultName),
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: false,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      scale: 1
    });
    fs.writeFileSync(result.filePath, pdf);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle('app:print', () => {
  if (win) win.webContents.print({ printBackground: false, silent: false });
  return true;
});

ipcMain.handle('win:title', (_event, title) => {
  if (win) win.setTitle(`${title || '未命名剧本'} — 剧本工坊`);
  return true;
});

ipcMain.handle('win:dirty', (_event, dirty) => {
  if (win) win.setDocumentEdited(Boolean(dirty));
  return true;
});

ipcMain.handle('theme:set', (_event, theme) => {
  if (win && OVERLAY[theme]) {
    win.setTitleBarOverlay({ ...OVERLAY[theme], height: 48 });
  }
  return true;
});

ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('window:close', () => { if (win) win.close(); });

/* ------------------------------ 工作目录 ------------------------------ */

ipcMain.handle('workspace:get', () => workspaceStatus());

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择剧本工作目录',
    defaultPath: dataDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return setWorkspace(result.filePaths[0], false);
});

ipcMain.handle('workspace:set', (_event, dir) => setWorkspace(dir, false));

ipcMain.handle('workspace:reset', () => setWorkspace(null, true));

ipcMain.handle('workspace:reveal', () => {
  const dir = scriptsDir();
  if (fs.existsSync(dir)) shell.openPath(dir);
  else shell.openPath(dataDir());
  return true;
});

/* ------------------------------ AI 大模型 ------------------------------ */
// 密钥经系统加密（Windows DPAPI / macOS Keychain）存于 userData，不下发到渲染进程
const aiConfigFile = () => path.join(userDir(), 'ai-config.json');
let aiController = null;
let aiStopped = false;
// AI 编辑期间主进程持有权威库：禁止渲染端整库回写，否则工具按 index 定位会与用户看到的内容分叉
let aiLibraryLocked = false;

async function readAiConfig() {
  const raw = readJson(aiConfigFile()) || {};
  let key = '';
  if (raw.apiKeyEncrypted) {
    try {
      const decoded = await safeStorage.decryptStringAsync(Buffer.from(raw.apiKeyEncrypted, 'base64'));
      key = decoded.result || '';
      if (decoded.shouldReEncrypt && key) {
        const fresh = (await safeStorage.encryptStringAsync(key)).toString('base64');
        writeAtomic(aiConfigFile(), JSON.stringify({ ...raw, apiKeyEncrypted: fresh }, null, 2));
      }
    } catch {}
  } else if (typeof raw.apiKey === 'string') {
    key = raw.apiKey;
  }
  return {
    provider: raw.provider || 'custom',
    baseUrl: raw.baseUrl || '',
    model: raw.model || '',
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.8,
    maxTokens: Number(raw.maxTokens) || 2048,
    apiKey: key
  };
}

async function publicAiConfig() {
  const c = await readAiConfig();
  return {
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    hasKey: Boolean(c.apiKey),
    maskedKey: c.apiKey ? `${c.apiKey.slice(0, 3)}••••${c.apiKey.slice(-4)}` : '',
    encrypted: await safeStorage.isAsyncEncryptionAvailable()
  };
}

async function writeAiConfig(input) {
  const current = await readAiConfig();
  const cfg = {
    provider: String(input.provider || 'custom'),
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(input.model || '').trim(),
    temperature: Math.max(0, Math.min(2, Number(input.temperature) || 0.8)),
    maxTokens: Math.max(256, Math.min(16384, Number(input.maxTokens) || 2048))
  };
  const key = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  if (key && await safeStorage.isAsyncEncryptionAvailable()) {
    cfg.apiKeyEncrypted = (await safeStorage.encryptStringAsync(key)).toString('base64');
  } else if (key) {
    cfg.apiKey = key;
  }
  writeAtomic(aiConfigFile(), JSON.stringify(cfg, null, 2));
  return await publicAiConfig();
}

async function aiRequest(messages, { stream = false, temperature, maxTokens, onChunk } = {}) {
  const cfg = await readAiConfig();
  if (!cfg.apiKey) throw new Error('尚未配置 API Key，请先在「AI → 模型配置」中填写');
  if (!cfg.baseUrl) throw new Error('尚未配置接口地址 Base URL');
  if (!cfg.model) throw new Error('尚未配置模型名称');
  if (aiController) { try { aiController.abort(); } catch {} }
  aiController = new AbortController();
  const signals = [aiController.signal];
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(180000));
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : aiController.signal;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : cfg.temperature,
      max_tokens: maxTokens || cfg.maxTokens,
      stream: Boolean(stream)
    }),
    signal
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 220) : ''}`);
  }
  if (!stream) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) { full += delta; if (onChunk) onChunk(delta); }
        } catch { /* 忽略心跳与非 JSON 行 */ }
      }
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || aiStopped)) return full;
    throw err;
  }
  return full;
}

ipcMain.handle('ai:getConfig', () => publicAiConfig());

ipcMain.handle('ai:saveConfig', async (_event, cfg) => {
  try { return { ok: true, config: await writeAiConfig(cfg || {}) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('ai:test', async () => {
  try {
    const reply = await aiRequest(
      [{ role: 'user', content: '只回复两个字：可用' }],
      { stream: false, temperature: 0, maxTokens: 32 }
    );
    return { ok: true, reply: String(reply).slice(0, 80) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('ai:run', async (event, payload) => {
  try {
    aiStopped = false;
    const text = await aiRequest(payload.messages || [], {
      stream: true,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      onChunk: (delta) => { if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', delta); }
    });
    return { ok: true, text, stopped: aiStopped };
  } catch (err) {
    return { ok: false, error: String(err.message || err), stopped: aiStopped };
  }
});

ipcMain.handle('ai:stop', () => {
  aiStopped = true;
  if (aiController) { try { aiController.abort(); } catch {} }
  return true;
});

/* -------- 行内 AI：针对单个内容块的就地改写，独立控制器避免中断智能体 -------- */
let inlineAiController = null;
const inlineShort = (v, n) => String(v ?? '').slice(0, n);
const inlineRole = (r) => (r === 'assistant' ? 'assistant' : (r === 'system' ? 'system' : 'user'));

async function inlineAiRequest(messages, { temperature, maxTokens } = {}) {
  const cfg = await readAiConfig();
  if (!cfg.apiKey) throw new Error('尚未配置 API Key，请先在「AI → 模型配置」中填写');
  if (!cfg.baseUrl) throw new Error('尚未配置接口地址 Base URL');
  if (!cfg.model) throw new Error('尚未配置模型名称');
  if (inlineAiController) { try { inlineAiController.abort(); } catch {} }
  inlineAiController = new AbortController();
  const signals = [inlineAiController.signal];
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(120000));
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : inlineAiController.signal;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, messages, stream: false,
      temperature: typeof temperature === 'number' ? temperature : cfg.temperature,
      max_tokens: Math.min(4096, Math.max(256, Number(maxTokens) || 1024))
    }),
    signal
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

ipcMain.handle('ai:inline', async (_event, payload = {}) => {
  try {
    const messages = (Array.isArray(payload.messages) ? payload.messages : [])
      .slice(-16).map(m => (m && typeof m === 'object'
        ? { role: inlineRole(m.role), content: inlineShort(m.content, 8000) }
        : null)).filter(m => m && m.content);
    if (!messages.length) return { ok: false, error: '请输入改写指令' };
    const text = await inlineAiRequest(messages, {
      temperature: payload.temperature, maxTokens: payload.maxTokens
    });
    return { ok: true, text: inlineShort(text, 12000) };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: true, text: '', stopped: true };
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('ai:inline:stop', () => {
  if (inlineAiController) { try { inlineAiController.abort(); } catch {} }
  return true;
});

/* ------------------------------ AI Agent：工具调用直接编辑剧本 ------------------------------ */
const AGENT_TYPES = ['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'section', 'note'];
const uidMain = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const AGENT_SYSTEM = `你是一个可以直接操作剧本编辑器的专业编剧智能体，必须把用户的整体目标完整达成后才能结束。
每次工具调用都会立刻反映在编辑器中，用户实时可见。系统会维护一份任务清单并据此判断能否结束，你不能自行宣布完成。

工作规则：
1. 第一步必须调用 plan，把整体目标拆成 3-8 个可验收的有序步骤；清单会显示给用户。
2. 调用 read_script 了解现状，然后按清单逐步编辑；一轮可同时调用多个互不依赖的工具。
3. 每完成一步立即调用 update_plan 标记进度。未标记完成的步骤，系统会一直判定目标未达成。
4. 定位内容块一律优先使用 read_script 返回的 id（唯一且稳定）：replace_block / delete_block 传 block_id，insert_block / add_scene / add_dialogue 传 after_id。只有确实拿不到 id 时才退用 index / after_index；插入或删除后所有 index 都会整体漂移，绝不能复用旧编号。工具结果会返回新建块的 id。
5. 除工具调用外不要输出说明文字。系统会在每次工具结果里回灌「剩余待办」，看到还有未完成项就必须继续调用工具，绝不能停下。
6. 上下文过长时系统会自动续跑并附上清单状态与剧本快照，快照同样带 id；收到「这是任务的继续」时从剩余项接着做，不重做已完成编辑。
7. 只有清单全部完成且系统验收通过，finish 才会被接受；提前调用会被拒绝并告知剩余项。

保持原剧本风格与人物语气；场景标题形如「INT. 地点 - 日」，角色名独占一行。`;

const AGENT_EDIT_TOOLS = ['insert_block', 'replace_block', 'delete_block', 'add_scene', 'add_dialogue', 'set_meta'];
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'plan', description: '第一步必须调用：把整体目标拆成 3-8 个可验收的有序步骤，系统会据此判断任务是否完成', parameters: { type: 'object', properties: {
    steps: { type: 'array', items: { type: 'string' }, description: '有序步骤标题，例如「补写第二场冲突」' } }, required: ['steps'] } } },
  { type: 'function', function: { name: 'update_plan', description: '每完成一个步骤就调用，把前 N 步标记为已完成；未全部完成前系统不会允许结束', parameters: { type: 'object', properties: {
    completed: { type: 'integer', description: '已完成的前 N 步数量，例如完成第 1、2 步时传 2' } }, required: ['completed'] } } },
  { type: 'function', function: { name: 'read_script', description: '读取当前剧本的标题、元数据与全部内容块（id/index/type/text）；id 唯一且稳定，编辑时优先用 id 定位', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'insert_block', description: '在指定块之后插入一个新内容块；优先传 after_id，不填则追加到末尾', parameters: { type: 'object', properties: {
    after_id: { type: 'string', description: '插入在此 id 的块之后（推荐，稳定不变）' },
    after_index: { type: 'integer', description: '兼容字段：仅在没有 id 时使用，插入/删除后会漂移' },
    type: { type: 'string', enum: AGENT_TYPES, description: '剧本元素类型' },
    text: { type: 'string', description: '正文' } }, required: ['type', 'text'] } } },
  { type: 'function', function: { name: 'replace_block', description: '替换指定内容块的正文（优先用 block_id，可同时改类型）', parameters: { type: 'object', properties: {
    block_id: { type: 'string', description: '目标块 id（推荐，稳定不变）' },
    index: { type: 'integer', description: '兼容字段：仅在没有 id 时使用' },
    text: { type: 'string' }, type: { type: 'string', enum: AGENT_TYPES } }, required: ['text'] } } },
  { type: 'function', function: { name: 'delete_block', description: '删除指定内容块（优先用 block_id）', parameters: { type: 'object', properties: {
    block_id: { type: 'string', description: '目标块 id（推荐，稳定不变）' },
    index: { type: 'integer', description: '兼容字段：仅在没有 id 时使用' } }, required: [] } } },
  { type: 'function', function: { name: 'add_scene', description: '新增一场戏：插入场景标题和一个动作块', parameters: { type: 'object', properties: {
    heading: { type: 'string', description: '例如 INT. 咖啡馆 - 夜' },
    action: { type: 'string', description: '开场动作描述' },
    after_id: { type: 'string', description: '插入在此 id 的块之后（推荐）' },
    after_index: { type: 'integer' } }, required: ['heading'] } } },
  { type: 'function', function: { name: 'add_dialogue', description: '新增一段角色台词（自动插入角色名、可选括号提示与对白）', parameters: { type: 'object', properties: {
    character: { type: 'string' }, text: { type: 'string' },
    parenthetical: { type: 'string', description: '可选，形如 （低声）' },
    after_id: { type: 'string', description: '插入在此 id 的块之后（推荐）' },
    after_index: { type: 'integer' } }, required: ['character', 'text'] } } },
  { type: 'function', function: { name: 'set_meta', description: '修改剧本元数据', parameters: { type: 'object', properties: {
    field: { type: 'string', enum: ['title', 'author', 'genre', 'logline', 'draft'] },
    value: { type: 'string' } }, required: ['field', 'value'] } } },
  { type: 'function', function: { name: 'finish', description: '仅当任务清单全部完成且系统验收通过后才可调用；提前调用会被拒绝并返回剩余待办', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }
];

function agentScript(lib) {
  return lib.scripts.find(s => s.id === lib.activeId) || lib.scripts[0];
}

function agentSnapshot(s) {
  return {
    title: s.title, genre: s.genre || '', logline: s.logline || '',
    total: s.blocks.length,
    blocks: s.blocks.map((b, i) => ({ index: i, id: b.id, type: b.type, text: String(b.text || '').slice(0, 200) }))
  };
}

function normalizeAgentPlan(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(x => typeof x === 'string'
    ? { title: String(x).slice(0, 80), done: false }
    : { title: String(x?.title || '').slice(0, 80), done: Boolean(x?.done) })
    .filter(x => x.title);
}

function agentPlanStatus(state) {
  const items = normalizeAgentPlan(state?.plan);
  const done = items.filter(x => x.done).length;
  return { total: items.length, done, pending: items.filter(x => !x.done).map(x => x.title) };
}

function agentProgress(state) {
  const st = agentPlanStatus(state);
  const edits = Number(state?.editCount) || 0;
  return {
    done: st.done, total: st.total, pending: st.pending, edits,
    verified: st.total > 0 && st.pending.length === 0 && edits >= 1,
    remainingGoal: !st.total
      ? '尚未制定任务计划：必须立即调用 plan 拆分整体目标。'
      : st.pending.length
        ? `目标尚未达成，还有 ${st.pending.length} 项待办：${st.pending.join('、')}。必须继续调用工具逐项落实，全部标记完成后调用 finish 由系统验收。`
        : '清单已全部标记完成，请调用 finish 提交系统验收。'
  };
}

function executeAgentTool(name, args, lib, state) {
  const r = agentToolCore(name, args, lib, state);
  if (state && r.ok !== false && AGENT_EDIT_TOOLS.includes(name)) {
    state.editCount = (Number(state.editCount) || 0) + 1;
  }
  return r;
}

function agentToolCore(name, args, lib, state) {
  const s = agentScript(lib);
  const arr = s.blocks;
  const at = (v, fallback) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(arr.length - 1, Math.trunc(v)));
    if (typeof v === 'string') { const i = arr.findIndex(b => b.id === v); if (i >= 0) return i; }
    return fallback;
  };
  // id 优先且严格：明确传了 id 却找不到时返回 -1，绝不静默退回 index 去改错别的块
  const locate = (idVal, idxVal, fallback) => {
    if (typeof idVal === 'string' && idVal) {
      const i = arr.findIndex(b => b.id === idVal);
      return i >= 0 ? i : -1;
    }
    return at(idxVal, fallback);
  };
  const mk = (type, text) => ({ id: uidMain(), type: AGENT_TYPES.includes(type) ? type : 'action', text: String(text ?? '') });
  switch (name) {
    case 'plan': {
      const steps = Array.isArray(args.steps)
        ? args.steps.map(x => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12) : [];
      if (agentPlanStatus(state).done > 0) {
        return { ok: false, error: '任务计划已存在且已有完成项，请用 update_plan 更新进度，不要重新制定计划。', plan: normalizeAgentPlan(state?.plan), progress: agentProgress(state) };
      }
      if (!steps.length) return { ok: false, error: '计划不能为空：请给出 3-8 个可验收的有序步骤。', progress: agentProgress(state) };
      if (state) state.plan = normalizeAgentPlan(steps);
      return { ok: true, steps, plan: state?.plan || [], total: steps.length, progress: agentProgress(state) };
    }
    case 'update_plan': {
      if (state) state.plan = normalizeAgentPlan(state.plan);
      const total = state?.plan?.length || 0;
      if (!total) return { ok: false, error: '尚未制定计划：请先调用 plan 拆分整体目标。', progress: agentProgress(state) };
      const n = Math.max(0, Math.min(total, Math.trunc(Number(args.completed) || 0)));
      state.plan.forEach((p, i) => { p.done = i < n; });
      const p = agentProgress(state);
      return { ok: true, plan: state.plan, completed: p.done, total: p.total, progress: p };
    }
    case 'read_script':
      return { ok: true, ...agentSnapshot(s) };
    case 'insert_block': {
      const pos = locate(args.after_id, args.after_index, arr.length - 1);
      if (pos < 0) return { ok: false, error: 'after_id 无效：请重新 read_script 获取最新 id' };
      const b = mk(args.type, args.text);
      arr.splice(pos + 1, 0, b);
      return { ok: true, index: pos + 1, id: b.id, total: arr.length };
    }
    case 'replace_block': {
      const i = locate(args.block_id, args.index, -1);
      if (i < 0 || !arr[i]) return { ok: false, error: args.block_id ? 'block_id 无效：请重新 read_script 获取最新 id' : '内容块编号无效' };
      arr[i].text = String(args.text ?? '');
      if (AGENT_TYPES.includes(args.type)) arr[i].type = args.type;
      return { ok: true, index: i, id: arr[i].id, total: arr.length };
    }
    case 'delete_block': {
      const i = locate(args.block_id, args.index, -1);
      if (i < 0 || !arr[i]) return { ok: false, error: args.block_id ? 'block_id 无效：请重新 read_script 获取最新 id' : '内容块编号无效' };
      if (arr.length <= 1) return { ok: false, error: '剧本至少保留一个内容块' };
      const deletedId = arr[i].id;
      arr.splice(i, 1);
      return { ok: true, deleted_id: deletedId, total: arr.length };
    }
    case 'add_scene': {
      const pos = locate(args.after_id, args.after_index, arr.length - 1);
      if (pos < 0) return { ok: false, error: 'after_id 无效：请重新 read_script 获取最新 id' };
      const added = [mk('scene', args.heading), mk('action', args.action || '')];
      arr.splice(pos + 1, 0, ...added);
      return { ok: true, index: pos + 1, id: added[0].id, total: arr.length };
    }
    case 'add_dialogue': {
      const pos = locate(args.after_id, args.after_index, arr.length - 1);
      if (pos < 0) return { ok: false, error: 'after_id 无效：请重新 read_script 获取最新 id' };
      const added = [mk('character', args.character)];
      if (args.parenthetical) added.push(mk('parenthetical', args.parenthetical));
      added.push(mk('dialogue', args.text));
      arr.splice(pos + 1, 0, ...added);
      return { ok: true, index: pos + 1, id: added[0].id, total: arr.length };
    }
    case 'set_meta': {
      if (!['title', 'author', 'genre', 'logline', 'draft'].includes(args.field)) return { ok: false, error: '字段名无效' };
      s[args.field] = String(args.value ?? '');
      return { ok: true, field: args.field, value: s[args.field] };
    }
    case 'finish': {
      const p = agentProgress(state);
      if (!p.total) return { ok: false, error: '尚未制定任务计划：请先调用 plan 列出完成目标所需的步骤，再逐项完成。', progress: p };
      if (p.pending.length) return { ok: false, error: `目标尚未达成，还有 ${p.pending.length} 项待办：${p.pending.join('、')}。请继续用工具完成，全部标记完成后再调用 finish。`, progress: p };
      const need = Math.max(1, Math.ceil(p.total / 2));
      if (p.edits < need) return { ok: false, error: `验收未通过：清单共 ${p.total} 项，但只做了 ${p.edits} 次剧本编辑，至少需要 ${need} 次。请把每一步真正落实到剧本里。`, progress: p };
      return { ok: true, done: true, verified: true, summary: String(args.summary || '剧本已更新'), progress: p };
    }
    default:
      return { ok: false, error: `未知工具 ${name}` };
  }
}

function agentStepSummary(name, args, r) {
  const brief = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 40);
  if (name === 'finish') return r.ok === false ? `验收未通过：${brief(r.error)}` : `目标已验收 · ${brief(r.summary)}`;
  if (r.ok === false) return brief(r.error) || `工具失败：${name}`;
  if (name === 'plan') return `制定计划 · ${r.total ?? 0} 个步骤`;
  if (name === 'update_plan') return `任务进度 ${r.completed ?? r.progress?.done ?? 0}/${r.total ?? 0}`;
  if (name === 'read_script') return `读取剧本 · ${r.total ?? 0} 个内容块`;
  if (name === 'insert_block') return `插入${args.type || '内容'}：${brief(args.text)}`;
  if (name === 'replace_block') return `改写${args.block_id ? `块 ${args.block_id}` : `第 ${args.index} 块`}：${brief(args.text)}`;
  if (name === 'delete_block') return `删除${args.block_id ? `块 ${args.block_id}` : `第 ${args.index} 块`}`;
  if (name === 'add_scene') return `新增场景：${brief(args.heading)}`;
  if (name === 'add_dialogue') return `新增台词：${brief(args.character)}`;
  if (name === 'set_meta') return `更新${args.field}`;
  return brief(name);
}

async function agentOnce(cfg, messages, signal, options = {}) {
  const signals = [signal];
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(120000));
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signal;
  const budget = Math.min(16384, Math.max(4096, Number(cfg.maxTokens) || 2048));
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, messages, tools: AGENT_TOOLS,
      tool_choice: options.toolChoice || 'auto',
      temperature: cfg.temperature, max_tokens: budget
    }),
    signal: combined
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0] || {};
  const msg = choice.message;
  if (!msg) throw new Error('模型未返回消息');
  if (choice.finish_reason === 'length') msg.outputTruncated = true;
  return msg;
}

const AGENT_SEGMENT_LIMIT = 8;
const AGENT_ROUNDS_PER_SEGMENT = 24;
const AGENT_TOOL_LIMIT = 180;
let agentLastSession = null;

function agentCompactScript(lib) {
  const s = agentScript(lib);
  const all = s.blocks;
  const from = Math.max(0, all.length - 120);
  return {
    title: s.title, total: all.length, omitted: from,
    blocks: all.slice(from).map((b, i) => ({ index: from + i, id: b.id, type: b.type, text: String(b.text || '').slice(0, 90) }))
  };
}

function agentPlanText(state) {
  const items = normalizeAgentPlan(state?.plan);
  if (!items.length) return '（尚未制定，必须立即调用 plan）';
  return items.map((p, i) => `${i + 1}. [${p.done ? '已完成' : '待办'}] ${p.title}`).join('\n');
}

function agentMessages(lib, instruction, state, continuing) {
  const s = agentScript(lib);
  const p = agentProgress(state);
  const head = `【剧本】${s.title} · 类型：${s.genre || '未设定'} · 当前 ${s.blocks.length} 个内容块\n【一句话故事】${s.logline || '未设定'}\n【用户指令】${instruction}`;
  const status = `\n【系统任务清单】\n${agentPlanText(state)}\n【验收状态】${p.done}/${p.total} 项完成 · 已完成 ${p.edits} 次剧本编辑\n【剩余目标】${p.remainingGoal}`;
  if (!continuing) {
    return [
      { role: 'system', content: AGENT_SYSTEM },
      { role: 'user', content: `${head}${status}\n\n第一步必须调用 plan 拆分整体目标，再 read_script 了解现状，然后持续用工具把清单逐项落实，每完成一步调用 update_plan，最后调用 finish 由系统验收。不要中途停下。` }
    ];
  }
  return [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: `${head}${status}\n【已执行步骤（最近 40 条）】\n${state.steps.slice(-40).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）'}\n【当前剧本快照】${JSON.stringify(agentCompactScript(lib))}\n\n这是任务的继续。不要重做已完成的编辑，从剩余目标接着做；快照中的 id 稳定不变，定位一律优先用 id，不要复用旧 index；仍有未完成项就必须继续调用工具，全部完成并验收通过后才能结束。` }
  ];
}

async function runBuiltinAgent({ cfg, instruction, lib, event, signal, prior }) {
  const state = {
    plan: normalizeAgentPlan(prior?.plan),
    steps: Array.isArray(prior?.steps) ? [...prior.steps].slice(-60) : [],
    toolCalls: Number(prior?.toolCalls) || 0,
    editCount: Number(prior?.editCount) || 0,
    text: '', truncated: false, verified: false
  };
  const sendStep = (step) => { if (!event.sender.isDestroyed()) event.sender.send('ai:step', step); };
  const sendPlan = () => { if (!event.sender.isDestroyed()) event.sender.send('ai:plan', state.plan); };
  if (state.plan.length) sendPlan();
  let continuing = state.steps.length > 0;
  let idleTotal = 0;
  let roundToolCalls = 0;
  let done = false;

  for (let segment = 1; segment <= AGENT_SEGMENT_LIMIT && !aiStopped && !done && !state.truncated; segment++) {
    const messages = agentMessages(lib, instruction, state, continuing);
    if (continuing) {
      const pg = agentProgress(state);
      sendStep({ name: 'continue', ok: true, summary: `自动续跑第 ${segment} 段 · 清单 ${pg.done}/${pg.total}，剩余 ${pg.pending.length} 项` });
    }
    continuing = true;
    let idleRounds = 0;
    let forcePlan = state.plan.length === 0;
    let round = 0;
    while (round < AGENT_ROUNDS_PER_SEGMENT && !aiStopped && !done && !state.truncated) {
      round++;
      let msg;
      try {
        msg = await agentOnce(cfg, messages, signal, forcePlan ? { toolChoice: { type: 'function', function: { name: 'plan' } } } : {});
      } catch (err) {
        if (!forcePlan) throw err;
        forcePlan = false;
        msg = await agentOnce(cfg, messages, signal);
      }
      forcePlan = false;
      if (msg.content) state.text += msg.content;
      if (!msg.tool_calls || !msg.tool_calls.length) {
        idleRounds++;
        idleTotal++;
        const pg = agentProgress(state);
        messages.push({ role: 'user', content: `${msg.outputTruncated ? '上一条输出被长度限制截断，请改用更小的工具调用继续推进。\n' : ''}${pg.remainingGoal}\n不要输出说明文字，只调用工具。` });
        if (idleTotal >= 6) { state.truncated = true; break; }
        if (idleRounds >= 3) break;
        continue;
      }
      idleRounds = 0;
      idleTotal = 0;
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        if (aiStopped || done || state.truncated) break;
        const name = tc.function?.name || '';
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        let result;
        try { result = executeAgentTool(name, args, lib, state); }
        catch (err) { result = { ok: false, error: String(err.message || err) }; }
        state.toolCalls++;
        roundToolCalls++;
        const summary = agentStepSummary(name, args, result);
        state.steps.push(summary);
        const focusId = typeof result.index === 'number' ? (agentScript(lib).blocks[result.index]?.id || null) : null;
        if (name !== 'finish' || result.ok === false) sendStep({ name, args, ok: result.ok !== false, focus: result.index, focusId, summary });
        if ((name === 'plan' && result.ok) || name === 'update_plan') sendPlan();
        if (!event.sender.isDestroyed()) event.sender.send('ai:library', lib);
        if (result.done === true) {
          done = true;
          state.verified = true;
          state.text = result.summary || state.text;
          if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', state.text);
          break;
        }
        const pg = agentProgress(state);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({
          ...result,
          progress: { done: pg.done, total: pg.total, pending: pg.pending, edits: pg.edits, verified: pg.verified },
          remainingGoal: pg.remainingGoal
        }) });
        if (roundToolCalls >= AGENT_TOOL_LIMIT) { state.truncated = true; break; }
      }
    }
  }
  if (!done) state.truncated = true;
  return { text: state.text, lib, ...state, progress: agentProgress(state) };
}

ipcMain.handle('ai:agent', async (event, payload = {}) => {
  let lib = null;
  aiLibraryLocked = true;
  try {
    aiStopped = false;
    const cfg = await readAiConfig();
    if (!cfg.apiKey) return { ok: false, error: '尚未配置 API Key，请先在「AI → 模型配置」中填写' };
    if (!cfg.baseUrl) return { ok: false, error: '尚未配置接口地址 Base URL' };
    if (!cfg.model) return { ok: false, error: '尚未配置模型名称' };
    if (!cache || !Array.isArray(cache.scripts) || !cache.scripts.length) return { ok: false, error: '没有可编辑的剧本' };
    if (aiController) { try { aiController.abort(); } catch {} }
    aiController = new AbortController();
    lib = cache;
    // 续跑优先使用渲染端会话里持久化的 prior：进程重启后内存中的 agentLastSession 已丢失
    const prior = payload.resume ? (normalizeAgentPrior(payload.prior) || agentLastSession) : null;
    const instruction = String(payload.instruction || prior?.instruction || '');
    if (!instruction) return { ok: false, error: '请输入任务指令' };
    const snapshot = JSON.stringify(lib.scripts);
    const context = { cfg, instruction, lib, event, signal: aiController.signal };
    let result;
    if (payload.engine === 'deepagents' && !payload.resume) {
      const deepState = { plan: [], steps: [], toolCalls: 0, editCount: 0 };
      try {
        result = await runDeepAgent({ ...context, state: deepState });
        const pg = agentProgress(result);
        if (!result.verified || !pg.verified) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('ai:step', { name: 'continue', ok: true, summary: `Deep Agent 提前返回，系统验收未通过 · 清单 ${pg.done}/${pg.total}，自动接续剩余目标` });
          }
          result = await runBuiltinAgent({ ...context, prior: {
            plan: result.plan, steps: result.steps,
            toolCalls: result.toolCalls, editCount: result.editCount
          } });
        }
      } catch (err) {
        if (aiStopped) return { ok: true, text: '', library: lib, stopped: true };
        const progressed = deepState.steps.length > 0;
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:step', { name: 'deepagents', ok: false, summary: `Deep Agent 中断：${String(err.message || err).slice(0, 100)}${progressed ? ' · 保留进度继续' : ' · 回退内置引擎'}` });
        }
        if (!progressed) {
          try {
            lib.scripts = JSON.parse(snapshot);
            if (!event.sender.isDestroyed()) event.sender.send('ai:library', lib);
          } catch {}
        }
        aiController = new AbortController();
        context.signal = aiController.signal;
        result = await runBuiltinAgent({ ...context, prior: progressed ? deepState : null });
      }
    } else {
      result = await runBuiltinAgent({ ...context, prior });
    }
    result.plan = normalizeAgentPlan(result.plan);
    result.steps = result.steps || [];
    const progress = agentProgress(result);
    agentLastSession = {
      instruction, plan: result.plan, steps: result.steps.slice(-60),
      toolCalls: result.toolCalls, editCount: result.editCount,
      verified: Boolean(result.verified), engine: payload.engine || 'builtin'
    };
    cache = lib;
    persistLibrary(lib);
    if (!event.sender.isDestroyed()) event.sender.send('ai:library', lib);
    return {
      ok: true, text: result.text, library: lib, stopped: aiStopped,
      truncated: Boolean(result.truncated) && !result.verified,
      verified: Boolean(result.verified), steps: result.steps.length,
      plan: result.plan, progress, prior: normalizeAgentPrior(agentLastSession)
    };
  } catch (err) {
    if (lib) { cache = lib; try { persistLibrary(lib); } catch {} }
    if (err && (err.name === 'AbortError' || aiStopped)) return { ok: true, text: '', library: lib || cache, stopped: true, truncated: true };
    return { ok: false, error: String(err.message || err) };
  } finally {
    aiLibraryLocked = false;
  }
});

// LangChain Deep Agents 为可选引擎；包缺失或端点不兼容时自动回退内置引擎
async function runDeepAgent({ cfg, instruction, lib, event, signal, state }) {
  const { createDeepAgent } = await import('deepagents');
  const { ChatOpenAI } = await import('@langchain/openai');
  const { tool } = await import('@langchain/core/tools');
  const { z } = await import('zod');
  if (typeof createDeepAgent !== 'function') throw new Error('deepagents 未导出 createDeepAgent');

  const model = new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseUrl },
    temperature: cfg.temperature,
    maxTokens: Math.min(16384, Math.max(4096, Number(cfg.maxTokens) || 2048))
  });
  const s = agentScript(lib);
  const shape = {
    plan: z.object({ steps: z.array(z.string()) }),
    update_plan: z.object({ completed: z.number().int() }),
    read_script: z.object({}),
    insert_block: z.object({ after_id: z.string().optional(), after_index: z.number().int().optional(), type: z.enum(AGENT_TYPES), text: z.string() }),
    replace_block: z.object({ block_id: z.string().optional(), index: z.number().int().optional(), text: z.string(), type: z.enum(AGENT_TYPES).optional() }),
    delete_block: z.object({ block_id: z.string().optional(), index: z.number().int().optional() }),
    add_scene: z.object({ heading: z.string(), action: z.string().optional(), after_id: z.string().optional(), after_index: z.number().int().optional() }),
    add_dialogue: z.object({ character: z.string(), text: z.string(), parenthetical: z.string().optional(), after_id: z.string().optional(), after_index: z.number().int().optional() }),
    set_meta: z.object({ field: z.enum(['title', 'author', 'genre', 'logline', 'draft']), value: z.string() }),
    finish: z.object({ summary: z.string() })
  };
  const tracker = state || { plan: [], steps: [], toolCalls: 0, editCount: 0 };
  tracker.editCount = Number(tracker.editCount) || 0;
  let finishSummary = '';
  const tools = AGENT_TOOLS.map(def => {
    const name = def.function.name;
    return tool(
      async (args) => {
        let result;
        try { result = executeAgentTool(name, args, lib, tracker); }
        catch (err) { result = { ok: false, error: String(err.message || err) }; }
        tracker.toolCalls++;
        const summary = agentStepSummary(name, args, result);
        tracker.steps.push(summary);
        if (name === 'finish' && result.done === true) { finishSummary = result.summary || ''; tracker.verified = true; }
        const pg = agentProgress(tracker);
        const focusId = typeof result.index === 'number' ? (agentScript(lib).blocks[result.index]?.id || null) : null;
        if (!event.sender.isDestroyed()) {
          if (name !== 'finish' || result.ok === false) event.sender.send('ai:step', { name, args, ok: result.ok !== false, focus: result.index, focusId, summary });
          if ((name === 'plan' && result.ok) || name === 'update_plan') event.sender.send('ai:plan', normalizeAgentPlan(tracker.plan));
          event.sender.send('ai:library', lib);
        }
        return JSON.stringify({
          ...result,
          progress: { done: pg.done, total: pg.total, pending: pg.pending, edits: pg.edits, verified: pg.verified },
          remainingGoal: pg.remainingGoal
        });
      },
      { name, description: def.function.description, schema: shape[name] }
    );
  });
  const agent = createDeepAgent({
    model, tools, name: 'scriptwriter-agent',
    systemPrompt: AGENT_SYSTEM + '\n不要调用文件读写、终端或子代理工具；所有剧本改动必须通过上述剧本编辑工具完成。'
  });
  const response = await agent.invoke(
    { messages: [{ role: 'user', content: `【剧本】${s.title}，共 ${s.blocks.length} 个内容块。请先 plan 拆分任务，再 read_script，然后持续用工具把清单逐项落实，每完成一步调用 update_plan，最后调用 finish 由系统验收。不要中途停下。\n【用户指令】${instruction}` }] },
    { signal, recursionLimit: 80 }
  );
  const msgs = Array.isArray(response.messages) ? response.messages : [];
  let text = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const type = typeof m._getType === 'function' ? m._getType() : (m.role || m.type || '');
    if (type !== 'ai' && type !== 'assistant') continue;
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
    if (text.trim()) break;
  }
  const summary = text.trim() || finishSummary;
  const pg = agentProgress(tracker);
  const verified = Boolean(tracker.verified) && pg.verified;
  if (summary && verified && !event.sender.isDestroyed()) event.sender.send('ai:chunk', summary);
  return {
    text: verified ? summary : '', lib, plan: tracker.plan, steps: tracker.steps,
    toolCalls: tracker.toolCalls, editCount: tracker.editCount,
    done: verified, verified, truncated: !verified, progress: pg
  };
}

/* ------------------- AI 会话持久化：消息 / 计划 / 续跑状态 ------------------- */
const AI_SESSIONS_VERSION = 1;
const AI_LIMITS = { sessions: 60, messages: 160, steps: 120, plan: 40, text: 20000, title: 80 };
const aiSessionsFile = () => path.join(userDir(), 'ai-sessions.json');
const aiShort = (v, max) => String(v ?? '').slice(0, max);

function normalizeAgentPrior(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    instruction: aiShort(raw.instruction, 4000),
    plan: normalizeAgentPlan(raw.plan).slice(-AI_LIMITS.plan)
      .map(p => ({ title: aiShort(p.title, 300), done: Boolean(p.done) })),
    steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(-AI_LIMITS.steps)
      .map(s => aiShort(typeof s === 'string' ? s : s?.summary, 400)).filter(Boolean),
    toolCalls: Number(raw.toolCalls) || 0,
    editCount: Number(raw.editCount) || 0,
    verified: Boolean(raw.verified),
    engine: raw.engine === 'deepagents' ? 'deepagents' : 'builtin'
  };
}

function normalizeAiPlanItems(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-AI_LIMITS.plan).map(p => (typeof p === 'string'
    ? { title: aiShort(p, 300), done: false }
    : { title: aiShort(p?.title, 300), done: Boolean(p?.done) })).filter(p => p.title);
}

function normalizeAiStepItems(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-AI_LIMITS.steps).map(s => (typeof s === 'string'
    ? { no: 0, ok: true, summary: aiShort(s, 400) }
    : { no: Number(s?.no) || 0, ok: s?.ok !== false, summary: aiShort(s?.summary, 400) }))
    .filter(s => s.summary);
}

function normalizeAiSessionMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'user' ? 'user' : (raw.role === 'assistant' ? 'assistant' : null);
  if (!role) return null;
  const type = raw.type === 'run' ? 'run' : 'text';
  const msg = {
    id: aiShort(raw.id, 40) || uidMain(),
    role, type,
    text: aiShort(raw.text, type === 'text' ? AI_LIMITS.text : 4000),
    at: Number(raw.at) || Date.now(),
    mode: aiShort(raw.mode, 24),
    engine: aiShort(raw.engine, 24),
    error: Boolean(raw.error)
  };
  if (type === 'run') {
    msg.steps = normalizeAiStepItems(raw.steps);
    msg.plan = normalizeAiPlanItems(raw.plan);
    msg.verified = Boolean(raw.verified);
  }
  return msg;
}

function normalizeAiSessionStore(raw) {
  const store = { version: AI_SESSIONS_VERSION, activeId: '', sessions: [] };
  if (!raw || typeof raw !== 'object') return store;
  store.sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .slice(-AI_LIMITS.sessions).map(s => {
      if (!s || typeof s !== 'object') return null;
      return {
        id: aiShort(s.id, 40) || uidMain(),
        title: aiShort(s.title, AI_LIMITS.title) || '新会话',
        createdAt: Number(s.createdAt) || Date.now(),
        updatedAt: Number(s.updatedAt) || Date.now(),
        scriptId: aiShort(s.scriptId, 40),
        scriptTitle: aiShort(s.scriptTitle, 80),
        engine: aiShort(s.engine, 24) || 'builtin',
        messages: (Array.isArray(s.messages) ? s.messages : [])
          .slice(-AI_LIMITS.messages).map(normalizeAiSessionMessage).filter(Boolean),
        prior: normalizeAgentPrior(s.prior)
      };
    }).filter(Boolean);
  const last = store.sessions[store.sessions.length - 1];
  store.activeId = store.sessions.some(s => s.id === raw.activeId) ? raw.activeId : (last ? last.id : '');
  return store;
}

ipcMain.handle('ai:sessions:load', () => normalizeAiSessionStore(readJson(aiSessionsFile())));

ipcMain.handle('ai:sessions:save', (_event, payload) => {
  try {
    const store = normalizeAiSessionStore(payload);
    writeAtomic(aiSessionsFile(), JSON.stringify(store));
    return { ok: true, savedAt: Date.now() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

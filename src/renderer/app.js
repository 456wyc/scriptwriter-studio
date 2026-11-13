'use strict';

/* ==========================================================================
   剧本工坊 — 应用逻辑
   在 Electron 中使用原生文件系统；浏览器中自动降级为 localStorage / 下载。
   ========================================================================== */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const desktop = window.desktop;
  const AI_SESSION_KEY = 'scriptwriter.aiSessions';

  /* ------------------------------ 平台适配 ------------------------------ */
  const api = desktop ? {
    info: () => desktop.info(),
    loadLibrary: () => desktop.loadLibrary(),
    saveLibrary: (data) => desktop.saveLibrary(data),
    flushLibrary: () => desktop.flushLibrary(),
    openFile: () => desktop.openFile(),
    saveFile: (o) => desktop.saveFile(o),
    exportPDF: (o) => desktop.exportPDF(o),
    print: () => desktop.print(),
    setTitle: (t) => desktop.setTitle(t),
    setDirty: (d) => desktop.setDirty(d),
    setTheme: (t) => desktop.setTheme(t),
    isDesktop: true
  } : {
    info: () => Promise.resolve(null),
    loadLibrary: () => { try { return Promise.resolve(JSON.parse(localStorage.getItem('scriptwriter.library') || 'null')); } catch { return Promise.resolve(null); } },
    saveLibrary: (data) => { try { localStorage.setItem('scriptwriter.library', JSON.stringify(data)); } catch {} return Promise.resolve(true); },
    flushLibrary: () => Promise.resolve(true),
    openFile: () => Promise.resolve(null),
    saveFile: (o) => { downloadBlob(o.defaultName, o.content); return Promise.resolve({ path: o.defaultName }); },
    exportPDF: () => { window.print(); return Promise.resolve({ canceled: true }); },
    print: () => { window.print(); return Promise.resolve(true); },
    setTitle: () => Promise.resolve(true),
    setDirty: () => Promise.resolve(true),
    setTheme: () => Promise.resolve(true),
    isDesktop: false
  };

  api.workspace = desktop ? {
    get: () => desktop.workspace.get(),
    choose: () => desktop.workspace.choose(),
    set: (dir) => desktop.workspace.set(dir),
    reset: () => desktop.workspace.reset(),
    reveal: () => desktop.workspace.reveal()
  } : {
    get: () => Promise.resolve({ dataDir: '浏览器预览', libraryPath: 'localStorage: scriptwriter.library', defaultDir: '', isCustom: false, scriptCount: 0, exists: true }),
    choose: () => Promise.resolve(null),
    set: () => Promise.resolve({ ok: false, error: '工作目录设置仅在桌面版可用' }),
    reset: () => Promise.resolve({ ok: false, error: '工作目录设置仅在桌面版可用' }),
    reveal: () => Promise.resolve(false)
  };

  api.ai = desktop ? {
    getConfig: () => desktop.ai.getConfig(),
    saveConfig: (cfg) => desktop.ai.saveConfig(cfg),
    test: () => desktop.ai.test(),
    run: (payload) => desktop.ai.run(payload),
    stop: () => desktop.ai.stop(),
    agent: (payload) => desktop.ai.agent(payload),
    inline: (payload) => desktop.ai.inline(payload),
    inlineStop: () => desktop.ai.inlineStop(),
    onChunk: (cb) => desktop.ai.onChunk(cb),
    onStep: (cb) => desktop.ai.onStep(cb),
    onLibrary: (cb) => desktop.ai.onLibrary(cb),
    onPlan: (cb) => desktop.ai.onPlan(cb),
    sessions: {
      load: () => desktop.ai.sessions.load(),
      save: (store) => desktop.ai.sessions.save(store)
    },
    pickFiles: () => desktop.ai.pickFiles()
  } : {
    getConfig: () => Promise.resolve(null),
    saveConfig: () => Promise.resolve({ ok: false, error: 'AI 能力仅在桌面版可用' }),
    test: () => Promise.resolve({ ok: false, error: 'AI 能力仅在桌面版可用' }),
    run: () => Promise.resolve({ ok: false, error: 'AI 能力仅在桌面版可用' }),
    stop: () => Promise.resolve(true),
    agent: () => Promise.resolve({ ok: false, error: 'AI 智能体仅在桌面版可用' }),
    inline: () => Promise.resolve({ ok: false, error: '行内 AI 仅在桌面版可用' }),
    inlineStop: () => Promise.resolve(true),
    onChunk: () => () => {},
    onStep: () => {},
    onLibrary: () => {},
    onPlan: () => {},
    sessions: {
      load: () => { try { return Promise.resolve(JSON.parse(localStorage.getItem(AI_SESSION_KEY) || 'null')); } catch { return Promise.resolve(null); } },
      save: (store) => { try { localStorage.setItem(AI_SESSION_KEY, JSON.stringify(store)); } catch {} return Promise.resolve({ ok: true }); }
    }
  };

  /* ------------------------------ 常量 ------------------------------ */
  const TYPES = {
    scene:         { label: '场景标题', ph: 'INT. 咖啡馆 - 夜' },
    action:        { label: '动作描述', ph: '描述画面中发生的动作与细节…' },
    character:     { label: '角色', ph: '角色名（输入即自动补全）' },
    dialogue:      { label: '对白', ph: '台词…' },
    parenthetical: { label: '括号提示', ph: '（低声）' },
    transition:    { label: '转场', ph: 'CUT TO:' },
    section:       { label: '幕 / 分节', ph: '第一幕' },
    note:          { label: '备注', ph: '写给自己的备注（不会导出到剧本）' }
  };
  const ORDER = ['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'section', 'note'];
  const NEXT = {
    scene: 'action', action: 'action', character: 'dialogue', parenthetical: 'dialogue',
    dialogue: 'character', transition: 'scene', section: 'scene', note: 'action'
  };
  const TRANSITIONS = ['CUT TO:', 'FADE IN:', 'FADE OUT.', 'FADE TO BLACK.', 'DISSOLVE TO:', 'MATCH CUT TO:', 'SMASH CUT TO:', 'JUMP CUT TO:', 'CUT TO BLACK.'];
  const SCENE_PREFIX = ['INT. ', 'EXT. ', 'INT./EXT. ', 'EST. ', '内景 ', '外景 '];
  const TIMES = ['日', '夜', '清晨', '黄昏', '傍晚', '深夜', '连续', '稍后', '同一时间'];
  const PARENS = ['（低声）', '（停顿）', '（笑）', '（叹气）', '（转身）', '（画外音）', '（自言自语）', '（沉默片刻）', '（打断）', '（压低声音）'];
  const SECTIONS = ['序章', '第一幕', '第二幕', '第三幕', '尾声'];
  const CHAR_SUFFIX = ['', ' (V.O.)', ' (O.S.)', " (CONT'D)"];

  /* ------------------------------ 状态 ------------------------------ */
  let lib = null;
  let activeId = null;           // 当前聚焦的内容块 id
  let history = [], future = [], lastSnapshot = '';
  let suggest = { open: false, items: [], index: 0, blockId: null };
  let saveTimer = null, sideTimer = null, histTimer = null, toastTimer = null;
  let menuOpen = null, cmdIndex = 0, cmdItems = [];

  const script = () => lib.scripts.find(s => s.id === lib.activeId) || lib.scripts[0];
  const blocks = () => script().blocks;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newBlock = (type = 'action', text = '') => ({ id: uid(), type, text });
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* ------------------------------ 示例剧本 ------------------------------ */
  function sampleBlocks() {
    return [
      ['section', '短片剧本'],
      ['scene', 'INT. 便利店 - 深夜'],
      ['action', '雨敲着玻璃门，货架的灯管忽明忽暗。林越把最后一箱牛奶推上货架，抬头看墙上的钟：02:17。'],
      ['action', '门铃响了。一个浑身湿透的女孩走进来，伞没有撑开，攥在手里。'],
      ['character', '林越'],
      ['dialogue', '我们十分钟后打烊。'],
      ['parenthetical', '（指了指她手里的伞）'],
      ['dialogue', '那个……可以放在门口吗？'],
      ['character', '女孩'],
      ['parenthetical', '（没看他，径直走向冷柜）'],
      ['dialogue', '有热的吗？'],
      ['action', '林越愣了一下，从柜台下面拿出一个纸杯，按下热水机的开关。'],
      ['character', '林越'],
      ['dialogue', '只有水。'],
      ['note', '这里留一个长一点的静默，让热水机的声音成为唯一的声响。'],
      ['transition', 'CUT TO:'],
      ['scene', 'INT. 便利店 后仓 - 稍后'],
      ['action', '纸箱堆到天花板。女孩捧着纸杯坐在折叠椅上，看着窗外的雨。'],
      ['character', '女孩'],
      ['dialogue', '我明天要离开这座城市。'],
      ['dialogue', '只是想找个还亮着的地方坐一会儿。'],
      ['character', '林越'],
      ['parenthetical', '（把一张纸巾放到她手边）'],
      ['dialogue', '灯我留着。'],
      ['transition', 'FADE OUT.'],
      ['scene', 'EXT. 便利店门口 - 清晨'],
      ['action', '雨停了。卷帘门半开，门口放着一把撑开晾干的伞。'],
      ['note', '收尾镜头：伞、湿漉漉的地面、第一班公交车驶过。']
    ].map(([type, text]) => newBlock(type, text));
  }

  function makeScript(title, bs) {
    return {
      id: uid(), title: title || '未命名剧本', author: '', genre: '', logline: '',
      draft: '第 1 稿', targetPages: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      blocks: bs && bs.length ? bs : [newBlock('scene', 'INT. 场景地点 - 日'), newBlock('action', '')]
    };
  }

  function normalizeScript(raw) {
    const s = makeScript(raw.title || '未命名剧本');
    s.id = raw.id || s.id;
    s.author = raw.author || '';
    s.genre = raw.genre || '';
    s.logline = raw.logline || '';
    s.draft = raw.draft || '第 1 稿';
    s.targetPages = Number(raw.targetPages) || 0;
    s.createdAt = raw.createdAt || Date.now();
    s.updatedAt = raw.updatedAt || Date.now();
    s.blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map(b => ({
      id: b.id || uid(),
      type: TYPES[b.type] ? b.type : 'action',
      text: String(b.text ?? '')
    }));
    if (!s.blocks.length) s.blocks = [newBlock('action', '')];
    return s;
  }

  const defaultLib = () => {
    const s = makeScript('雨夜便利店', sampleBlocks());
    s.author = '示例'; s.genre = '剧情 / 短片';
    s.logline = '一个深夜便利店里，两个陌生人用一杯热水交换了各自不肯说出口的告别。';
    return { scripts: [s], activeId: s.id, settings: normalizeSettings() };
  };

  /* ------------------------------ 持久化 ------------------------------ */
  function markSaving() {
    $('#saveIndicator').classList.add('saving');
    $('#saveText').textContent = '保存中…';
    api.setDirty(true);
  }
  function markSaved() {
    $('#saveIndicator').classList.remove('saving');
    $('#saveText').textContent = api.isDesktop ? '已保存到本机' : '已保存';
    $('#dirtyDot').classList.remove('on');
    api.setDirty(false);
  }
  function scheduleSave() {
    // AI 编辑期间主进程持有权威库；整库回写会让工具按 index 定位的内容与用户看到的分叉
    if (aiState.busy) return;
    markSaving();
    $('#dirtyDot').classList.add('on');
    script().updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveLibrary(lib).then(markSaved).catch(() => { $('#saveText').textContent = '保存失败'; });
    }, 420);
  }
  async function saveNow(silent) {
    clearTimeout(saveTimer);
    if (aiState.busy) { if (!silent) toast('AI 正在编辑剧本，完成后会自动保存'); return; }
    script().updatedAt = Date.now();
    try { await api.saveLibrary(lib); await api.flushLibrary(); markSaved(); if (!silent) toast('已保存'); }
    catch { toast('保存失败', true); }
  }

  /* ------------------------------ 历史 ------------------------------ */
  function commitHistory() {
    const cur = JSON.stringify(blocks());
    if (cur === lastSnapshot) return;
    history.push(lastSnapshot);
    if (history.length > 100) history.shift();
    future = [];
    lastSnapshot = cur;
  }
  function settleHistory() { lastSnapshot = JSON.stringify(blocks()); }
  function scheduleHistory() { clearTimeout(histTimer); histTimer = setTimeout(commitHistory, 600); }
  function restoreSnapshot(json) {
    script().blocks = JSON.parse(json).map(b => ({ id: b.id || uid(), type: TYPES[b.type] ? b.type : 'action', text: b.text || '' }));
    if (!script().blocks.length) script().blocks = [newBlock('action', '')];
    lastSnapshot = JSON.stringify(blocks());
    renderAll();
  }
  function undo() {
    commitHistory();
    if (!history.length) { toast('没有可撤销的操作'); return; }
    future.push(JSON.stringify(blocks()));
    restoreSnapshot(history.pop());
    toast('已撤销');
  }
  function redo() {
    if (!future.length) { toast('没有可重做的操作'); return; }
    const cur = JSON.stringify(blocks());
    history.push(cur);
    restoreSnapshot(future.pop());
    toast('已重做');
  }

  /* ------------------------------ 行内 AI ------------------------------ */
  const INLINE_AI_SYSTEM = `你是资深编剧助理，正在帮助用户就地修改剧本中的单个内容块。始终使用简体中文。
规则：
1. 只输出修改后的正文，不要输出解释、标题、引号、Markdown 或代码块。
2. 保持该内容块的类型与剧本格式：动作描述用现在时、可视化；对白贴合人物语气；场景标题形如「INT. 地点 - 时间」。
3. 除非用户明确要求，不要改变剧情事实，不要新增人物或场景。
4. 多轮修改时，以最近一次输出的正文为基础继续调整。只输出最终正文。`;

  const INLINE_CHIPS = [
    ['润色', '润色这段文字：删掉冗余，让句子更克制有力，保持原意。'],
    ['扩写', '扩写成更有画面感的动作描述，补充可见的细节与声音，保持现在时态。'],
    ['更有张力', '在不改变剧情的前提下，加强这句话的紧张感与潜台词。'],
    ['改成对白', '把这段内容改写成一两句符合人物语气、克制的对白台词。'],
    ['精简', '精简这段话，只保留最关键的信息与动作。']
  ];

  const emptyInlineAi = () => ({
    blockId: null, messages: [], draft: '', busy: false,
    selection: null, lastReply: '', error: ''
  });
  let inlineAi = emptyInlineAi();

  const inlineAiBlock = () => blocks().find(b => b.id === inlineAi.blockId) || null;

  function inlineAiContext(b) {
    const arr = blocks();
    const idx = arr.findIndex(x => x.id === b.id);
    const label = (x) => `[${TYPES[x.type] ? TYPES[x.type].label : x.type}] ${x.text}`;
    const lines = [`【剧本标题】${script().title}`, `【当前块类型】${TYPES[b.type].label}`];
    const before = arr.slice(Math.max(0, idx - 5), idx).filter(x => x.text.trim()).map(label);
    const after = arr.slice(idx + 1, idx + 4).filter(x => x.text.trim()).map(label);
    if (before.length) lines.push('【前文】\n' + before.join('\n'));
    if (after.length) lines.push('【后文】\n' + after.join('\n'));
    return lines.join('\n').slice(-2800);
  }

  function inlineAiMessages(b, prompt) {
    const sel = inlineAi.selection;
    const scope = sel && sel.text
      ? `\n【本次作用范围】只改写选中的片段，只输出用于替换该片段的文字：${sel.text}`
      : '\n【本次作用范围】改写整个内容块。';
    const system = `${INLINE_AI_SYSTEM}\n\n${inlineAiContext(b)}\n【当前块原文】${b.text || '（空）'}${scope}`;
    const history = inlineAi.messages.slice(0, -1).slice(-8)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
    return [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }];
  }

  function buildInlineAiPanel(b) {
    const panel = document.createElement('div');
    panel.className = 'inline-ai';
    panel.dataset.inlineBlock = b.id;
    panel.innerHTML = `<div class="inline-ai-head">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-spark"/></svg>
        <span class="inline-ai-title">行内 AI</span>
        <span class="inline-ai-scope"></span>
        <button class="inline-ai-icon" data-inline-action="close" title="关闭 (Esc)"><svg class="ic" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
      </div>
      <div class="inline-ai-log"></div>
      <div class="inline-ai-chips"></div>
      <div class="inline-ai-composer">
        <textarea class="inline-ai-input" rows="1" spellcheck="false" placeholder="告诉 AI 怎么改这个块… Ctrl+Enter 发送"></textarea>
        <button class="inline-ai-send" data-inline-action="send" title="发送 (Ctrl+Enter)"><svg class="ic" viewBox="0 0 24 24"><use href="#i-send"/></svg></button>
      </div>
      <div class="inline-ai-actions">
        <button data-inline-action="replace">替换当前块</button>
        <button data-inline-action="insert">插入到下方</button>
        <button data-inline-action="copy">复制</button>
        <button data-inline-action="regenerate">重新生成</button>
        <button data-inline-action="stop" class="danger">停止</button>
        <span class="inline-ai-status"></span>
      </div>`;
    panel.querySelector('.inline-ai-scope').textContent = inlineAi.selection?.text
      ? `选中片段 · ${inlineAi.selection.text.length} 字` : `整个内容块 · ${TYPES[b.type].label}`;

    const log = panel.querySelector('.inline-ai-log');
    if (!inlineAi.messages.length && !inlineAi.busy && !inlineAi.error) {
      const empty = document.createElement('div');
      empty.className = 'inline-ai-empty';
      empty.textContent = '针对这个块直接对话，AI 只返回可替换的正文；如果先选中一段文字，则只改写选区。';
      log.appendChild(empty);
    }
    for (const m of inlineAi.messages.slice(-12)) {
      const row = document.createElement('div');
      row.className = 'inline-ai-msg ' + m.role;
      const tag = document.createElement('span');
      tag.className = 'inline-ai-msg-tag';
      tag.textContent = m.role === 'user' ? '你' : 'AI';
      const body = document.createElement('div');
      body.className = 'inline-ai-msg-text';
      body.textContent = m.text;
      row.append(tag, body);
      log.appendChild(row);
    }
    if (inlineAi.busy) {
      const thinking = document.createElement('div');
      thinking.className = 'inline-ai-thinking';
      thinking.textContent = '正在改写…';
      log.appendChild(thinking);
    }
    if (inlineAi.error) {
      const err = document.createElement('div');
      err.className = 'inline-ai-error';
      err.textContent = inlineAi.error;
      log.appendChild(err);
    }

    const chips = panel.querySelector('.inline-ai-chips');
    for (const [label, prompt] of INLINE_CHIPS) {
      const btn = document.createElement('button');
      btn.className = 'inline-ai-chip';
      btn.dataset.inlinePrompt = prompt;
      btn.textContent = label;
      chips.appendChild(btn);
    }

    const input = panel.querySelector('.inline-ai-input');
    input.value = inlineAi.draft;
    input.disabled = inlineAi.busy;
    const send = panel.querySelector('.inline-ai-send');
    send.disabled = inlineAi.busy || !inlineAi.draft.trim();
    const has = Boolean(inlineAi.lastReply) && !inlineAi.busy;
    panel.querySelectorAll('.inline-ai-actions button').forEach(btn => {
      const act = btn.dataset.inlineAction;
      if (act === 'stop') btn.disabled = !inlineAi.busy;
      else if (act === 'regenerate') btn.disabled = inlineAi.busy || !inlineAi.messages.some(m => m.role === 'user');
      else btn.disabled = !has;
    });
    panel.querySelector('.inline-ai-status').textContent = inlineAi.busy
      ? '生成中…' : (inlineAi.lastReply ? '可替换 / 插入 / 继续追问' : '');
    return panel;
  }

  function refreshInlineAi(restoreFocus = false) {
    const old = $('#blocks .inline-ai');
    const b = inlineAiBlock();
    if (!old || !b) return;
    const input = old.querySelector('.inline-ai-input');
    const sel = restoreFocus && input ? [input.selectionStart, input.selectionEnd] : null;
    const panel = buildInlineAiPanel(b);
    old.replaceWith(panel);
    if (sel) {
      const next = panel.querySelector('.inline-ai-input');
      next.focus({ preventScroll: true });
      try { next.setSelectionRange(Math.min(sel[0], next.value.length), Math.min(sel[1], next.value.length)); } catch {}
    }
  }

  function focusInlineAiInput() {
    const input = $('#blocks .inline-ai-input');
    if (!input) return;
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  }

  function openInlineAi(blockId) {
    if (aiState.busy) { toast('智能体正在编辑剧本，完成后再用行内 AI', true); return; }
    const b = blocks().find(x => x.id === blockId);
    if (!b) return;
    if (inlineAi.blockId === blockId) { focusInlineAiInput(); return; }
    if (inlineAi.busy) { try { api.ai.inlineStop(); } catch {} }
    const ta = $(`.block-input[data-id="${CSS.escape(blockId)}"]`);
    let selection = null;
    if (ta && typeof ta.selectionStart === 'number' && ta.selectionEnd > ta.selectionStart) {
      selection = { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
    }
    $('#blocks .inline-ai')?.remove();
    $$('.block.ai-open').forEach(el => el.classList.remove('ai-open'));
    inlineAi = { ...emptyInlineAi(), blockId, selection };
    if (!aiConfig || !aiConfig.hasKey) inlineAi.error = '尚未配置模型，请先在「AI → 模型配置」中填写，再发送指令。';
    const host = $('#blocks');
    const wrap = $(`.block[data-id="${CSS.escape(blockId)}"]`);
    if (wrap) { wrap.classList.add('ai-open'); const panel = buildInlineAiPanel(b); host.appendChild(panel); positionInlineAiPanel(panel, wrap); }
    setActive(blockId);
    focusInlineAiInput();
  }

  function closeInlineAi() {
    if (inlineAi.busy) { try { api.ai.inlineStop(); } catch {} }
    const id = inlineAi.blockId;
    $('#blocks .inline-ai')?.remove();
    if (id) $(`.block[data-id="${CSS.escape(id)}"]`)?.classList.remove('ai-open');
    inlineAi = emptyInlineAi();
  }

  function positionInlineAiPanel(panel, anchor) {
    const host = $('#blocks');
    const pw = Math.min(380, Math.max(260, host.clientWidth - 24));
    panel.style.width = pw + 'px';
    let top = anchor.offsetTop + anchor.offsetHeight + 6;
    panel.style.top = top + 'px';
    let left = anchor.offsetLeft;
    if (left + pw > host.clientWidth) left = Math.max(8, host.clientWidth - pw - 8);
    panel.style.left = left + 'px';
    const ph = panel.offsetHeight;
    const predictedBottom = anchor.getBoundingClientRect().bottom + ph + 12;
    if (predictedBottom > window.innerHeight && anchor.offsetTop - ph - 6 > 0) {
      panel.style.top = (anchor.offsetTop - ph - 6) + 'px';
    }
  }

  async function inlineAiSend(promptOverride) {
    if (inlineAi.busy) return;
    if (aiState.busy) { toast('智能体正在编辑剧本，完成后再用行内 AI', true); return; }
    const b = inlineAiBlock();
    if (!b) { closeInlineAi(); return; }
    const prompt = String(promptOverride ?? inlineAi.draft).trim();
    if (!prompt) { focusInlineAiInput(); return; }
    if (!aiConfig || !aiConfig.hasKey) { openAiConfig(); toast('请先配置模型与 API Key', true); return; }
    inlineAi.draft = '';
    inlineAi.error = '';
    inlineAi.messages.push({ role: 'user', text: prompt });
    inlineAi.busy = true;
    refreshInlineAi(true);
    const res = await api.ai.inline({
      messages: inlineAiMessages(b, prompt), temperature: 0.75, maxTokens: 1024
    }).catch(e => ({ ok: false, error: String(e) }));
    if (inlineAi.blockId !== b.id) return; // 期间已切换或关闭
    inlineAi.busy = false;
    if (res && res.stopped) inlineAi.error = '已停止生成';
    else if (!res || !res.ok) inlineAi.error = '生成失败：' + ((res && res.error) || '未知错误');
    else {
      const reply = String(res.text || '').trim();
      if (!reply) inlineAi.error = '模型未返回内容';
      else { inlineAi.messages.push({ role: 'assistant', text: reply }); inlineAi.lastReply = reply; inlineAi.error = ''; }
    }
    refreshInlineAi(true);
    const log = $('#blocks .inline-ai-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function inlineAiRegenerate() {
    if (inlineAi.busy) return;
    const msgs = inlineAi.messages;
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return;
    msgs.pop();
    inlineAiSend(last.text);
  }

  function inlineAiApply(kind) {
    if (aiState.busy) { toast('智能体正在编辑剧本，请稍后再应用', true); return; }
    const reply = inlineAi.lastReply;
    const b = inlineAiBlock();
    if (!reply || !b) return;
    if (kind === 'copy') { aiApplyResult('copy', reply); return; }
    if (kind === 'insert') {
      insertBlock(b.id, b.type, reply);
      toast('已插入到下方');
      focusInlineAiInput();
      return;
    }
    if (kind === 'replace') {
      beginChange();
      const sel = inlineAi.selection;
      if (sel && sel.text && b.text.slice(sel.start, sel.end) === sel.text) {
        b.text = b.text.slice(0, sel.start) + reply + b.text.slice(sel.end);
        inlineAi.selection = { start: sel.start, end: sel.start + reply.length, text: reply };
      } else b.text = reply;
      changed(true);
      setActive(b.id);
      toast('已替换当前块');
      focusInlineAiInput();
    }
  }

  function inlineAiStop() { try { api.ai.inlineStop(); } catch {} }

  /* ------------------------------ 内容块渲染 ------------------------------ */
  function autoHeight(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
  }

  function renderBlocks() {
    const host = $('#blocks');
    const prev = document.activeElement;
    const inlineFocused = Boolean(prev && prev.classList && prev.classList.contains('inline-ai-input'));
    const inlineSel = inlineFocused ? [prev.selectionStart, prev.selectionEnd] : null;
    let anchorWrap = null, anchorBlock = null, sceneNo = 0;
    host.replaceChildren();
    for (const b of blocks()) {
      const wrap = document.createElement('div');
      wrap.className = 'block' + (b.id === activeId ? ' active' : '');
      wrap.dataset.id = b.id;
      wrap.dataset.type = b.type;
      if (b.type === 'scene') { sceneNo++; wrap.dataset.sceneNo = sceneNo; }

      const badge = document.createElement('button');
      badge.className = 'type-badge';
      badge.dataset.badge = b.id;
      badge.type = 'button';
      badge.textContent = (lib.settings.scriptFormat === 'cn' && b.type === 'scene' ? '第' + sceneNo + '场' : TYPES[b.type].label) + ' ▾';

      const ta = document.createElement('textarea');
      ta.className = 'block-input';
      ta.dataset.id = b.id;
      ta.rows = 1;
      ta.spellcheck = false;
      ta.readOnly = Boolean(aiState.busy);
      ta.placeholder = TYPES[b.type].ph;
      ta.value = b.text;

      const aiBtn = document.createElement('button');
      aiBtn.className = 'block-ai-btn';
      aiBtn.dataset.aiBlock = b.id;
      aiBtn.type = 'button';
      aiBtn.title = '行内 AI · 改写这个块 (Alt+Enter)';
      aiBtn.disabled = Boolean(aiState.busy);
      aiBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-spark"/></svg>';

      const addBtn = document.createElement('button');
      addBtn.className = 'block-add';
      addBtn.dataset.addBefore = b.id;
      addBtn.type = 'button';
      addBtn.title = '在此块前插入新块';
      addBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-plus"/></svg>';

      wrap.append(addBtn, badge, ta, aiBtn);
      host.appendChild(wrap);
      if (inlineAi.blockId === b.id) { wrap.classList.add('ai-open'); anchorWrap = wrap; anchorBlock = b; }
      autoHeight(ta);
    }
    if (anchorWrap) {
      const panel = buildInlineAiPanel(anchorBlock);
      host.appendChild(panel);
      positionInlineAiPanel(panel, anchorWrap);
    }
    if (inlineFocused) {
      const input = host.querySelector('.inline-ai-input');
      if (input) {
        input.focus({ preventScroll: true });
        try { input.setSelectionRange(Math.min(inlineSel[0], input.value.length), Math.min(inlineSel[1], input.value.length)); } catch {}
      }
    }
  }

  function focusBlock(id, caret = 'end') {
    const ta = $(`.block-input[data-id="${id}"]`);
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const pos = caret === 'end' ? ta.value.length : clamp(Number(caret) || 0, 0, ta.value.length);
    ta.setSelectionRange(pos, pos);
    autoHeight(ta);
    setActive(id);
  }

  function scrollToBlock(id) {
    const ta = $(`.block-input[data-id="${id}"]`);
    if (ta) ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setActive(id) {
    activeId = id;
    $$('.block').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    const b = blocks().find(x => x.id === id);
    const label = b ? TYPES[b.type].label : '动作描述';
    $('#typeChip').textContent = label;
    $('#statusType').textContent = label;
    $('#statusHint').textContent = aiState.busy
      ? 'AI 正在编辑 · 剧本暂时只读，可自由浏览'
      : (b ? `${label} · Tab 切换类型` : '就绪');
    renderOutlineSelection();
  }

  /* ------------------------------ 结构操作 ------------------------------ */
  function beginChange() { commitHistory(); }
  function changed(structural = true) {
    if (structural) { settleHistory(); renderBlocks(); }
    renderSidebars();
    renderPrintView();
    updateStatus();
    scheduleSave();
  }

  function insertBlock(afterId, type = 'action', text = '') {
    beginChange();
    const arr = blocks();
    const idx = afterId ? arr.findIndex(b => b.id === afterId) : arr.length - 1;
    const nb = newBlock(type, text);
    arr.splice(idx + 1, 0, nb);
    changed(true);
    focusBlock(nb.id);
    scrollToBlock(nb.id);
    return nb;
  }

  function deleteBlock(id) {
    if (blocks().length <= 1) { toast('至少保留一个内容块'); return; }
    beginChange();
    const arr = blocks();
    const idx = arr.findIndex(b => b.id === id);
    if (idx < 0) return;
    arr.splice(idx, 1);
    const next = arr[Math.min(idx, arr.length - 1)];
    changed(true);
    focusBlock(next.id);
  }

  function changeType(id, type) {
    const b = blocks().find(x => x.id === id);
    if (!b || !TYPES[type] || b.type === type) return;
    beginChange();
    b.type = type;
    changed(true);
    focusBlock(id);
  }

  function cycleType(id, dir = 1) {
    const b = blocks().find(x => x.id === id);
    if (!b) return;
    const i = ORDER.indexOf(b.type);
    changeType(id, ORDER[(i + dir + ORDER.length) % ORDER.length]);
  }

  function moveBlock(id, dir) {
    const arr = blocks();
    const i = arr.findIndex(b => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    beginChange();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    changed(true);
    focusBlock(id);
    scrollToBlock(id);
  }

  function duplicateBlock(id) {
    const b = blocks().find(x => x.id === id);
    if (b) insertBlock(id, b.type, b.text);
  }

  function appendTypedBlock(type) {
    insertBlock(null, type);
  }

  function insertBeforeBlock(beforeId, type = 'action', text = '') {
    beginChange();
    const arr = blocks();
    let idx = arr.findIndex(b => b.id === beforeId);
    if (idx < 0) idx = arr.length;
    const nb = newBlock(type, text);
    arr.splice(idx, 0, nb);
    changed(true);
    focusBlock(nb.id);
    scrollToBlock(nb.id);
    return nb;
  }

  /* ------------------------------ 统计 / 侧栏 ------------------------------ */
  function bodyChars() {
    return blocks().reduce((n, b) => n + (b.type === 'note' || b.type === 'section' ? 0 : b.text.replace(/\s/g, '').length), 0);
  }
  function pageCount() {
    const chars = bodyChars();
    const lineCount = blocks().reduce((n, b) => n + Math.max(1, Math.ceil(b.text.length / 52)) + (b.type === 'note' ? 0 : 1), 0);
    return Math.max(1, Math.max(Math.ceil(chars / 620), Math.ceil(lineCount / 46)));
  }
  function parseSlug(text) {
    const t = (text || '').trim();
    let kind = '', place = t, time = '';
    const m = t.match(/^(INT\.\/EXT\.|INT\.|EXT\.|EST\.|I\/E\.|内景|外景|内外景)\s*[·.]?\s*(.*)$/i);
    if (m) { kind = m[1].toUpperCase().replace('.', ''); place = m[2]; }
    const parts = place.split(/\s*[-–—]\s*/);
    if (parts.length > 1) { time = parts.pop().trim(); place = parts.join(' - ').trim(); }
    return { kind, place: place || '未命名场景', time: time || '—' };
  }
  function charStats() {
    const map = new Map();
    let current = null;
    for (const b of blocks()) {
      if (b.type === 'scene' || b.type === 'section') { current = null; continue; }
      if (b.type === 'character') {
        const name = b.text.replace(/\s*\((?:V\.O\.|O\.S\.|CONT'D|旁白|画外音|电话)\)\s*$/i, '').trim();
        if (!name) continue;
        if (!map.has(name)) map.set(name, { name, lines: 0, chars: 0 });
        current = map.get(name);
        continue;
      }
      if (b.type === 'dialogue' && current) {
        current.lines++;
        current.chars += b.text.replace(/\s/g, '').length;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.chars - a.chars);
  }
  function sceneList() {
    const out = [];
    let cur = null;
    for (const b of blocks()) {
      if (b.type === 'section') { out.push({ section: b.text, id: b.id }); continue; }
      if (b.type === 'scene') {
        const s = parseSlug(b.text);
        cur = { id: b.id, raw: b.text, ...s, chars: 0, index: out.filter(x => !x.section).length + 1 };
        out.push(cur);
        continue;
      }
      if (cur && b.type !== 'note') cur.chars += b.text.replace(/\s/g, '').length;
    }
    return out;
  }

  function renderOutlineSelection() {
    const b = blocks().find(x => x.id === activeId);
    let sceneId = null;
    if (b) {
      for (let i = blocks().indexOf(b); i >= 0; i--) {
        if (blocks()[i].type === 'scene') { sceneId = blocks()[i].id; break; }
      }
    }
    $$('.outline-item').forEach(el => el.classList.toggle('active', el.dataset.id === sceneId));
  }

  function renderOutline() {
    const host = $('#outline');
    const q = ($('#outlineSearch').value || '').trim().toLowerCase();
    const list = sceneList().filter(x => x.section || !q || (x.raw || '').toLowerCase().includes(q));
    $('#outlineCount').textContent = String(list.filter(x => !x.section).length);
    if (!list.length) {
      host.innerHTML = `<div class="ol-empty">${q ? '没有匹配的场景' : '还没有场景标题<br>按 Ctrl + Enter 新建第一场'}</div>`;
      return;
    }
    host.innerHTML = list.map(x => {
      if ('section' in x) return `<div class="outline-group-title">${esc(x.section || TYPES.section.ph)}</div>`;
      const kind = x.kind || '';
      const tag = kind.startsWith('INT') || kind.includes('内') ? 'int' : 'ext';
      return `<div class="outline-item" data-id="${x.id}">
        <div class="ol-num">${String(x.index).padStart(2, '0')}</div>
        <div class="ol-body">
          <div class="ol-slug">${esc(x.place)}</div>
          <div class="ol-meta"><span class="ol-tag ${tag}">${esc(x.kind || '场景')}</span><span>${esc(x.time)}</span><span>·</span><span>${x.chars} 字</span></div>
        </div></div>`;
    }).join('');
    renderOutlineSelection();
  }

  function renderChars() {
    const host = $('#charList');
    const list = charStats();
    if (!list.length) {
      host.innerHTML = '<div class="char-empty">还没有角色<br>把内容块切换为「角色」并输入名字</div>';
      return;
    }
    const max = Math.max(1, ...list.map(c => c.chars));
    host.innerHTML = list.map(c => `<div class="char-item" data-name="${esc(c.name)}" title="点击插入到正文末尾">
      <div class="char-avatar">${esc(c.name.slice(0, 1))}</div>
      <div class="char-info">
        <div class="char-name">${esc(c.name)}</div>
        <div class="char-sub">${c.lines} 段对白 · ${c.chars} 字</div>
        <div class="char-bar"><i style="width:${Math.round(c.chars / max * 100)}%"></i></div>
      </div></div>`).join('');
  }

  function renderStats() {
    const chars = bodyChars();
    const scenes = sceneList().filter(x => !x.section).length;
    const people = charStats().length;
    const dlg = blocks().filter(b => b.type === 'dialogue').reduce((n, b) => n + b.text.replace(/\s/g, '').length, 0);
    const ratio = chars ? Math.round(dlg / chars * 100) : 0;
    const pages = pageCount();
    $('#statGrid').innerHTML = [
      ['字数', chars.toLocaleString(), '字'], ['场景', scenes, '场'],
      ['角色', people, '位'], ['页数', pages, '页'],
      ['对白占比', ratio, '%'], ['预计时长', pages, '分钟']
    ].map(([label, value, unit]) => `<div class="stat-card"><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-label">${label}</div></div>`).join('');

    const counts = ORDER.map(t => ({ t, n: blocks().filter(b => b.type === t).length })).filter(x => x.n > 0);
    const max = Math.max(1, ...counts.map(c => c.n));
    $('#typeDist').innerHTML = counts.map(c => `<div class="dist-row"><span>${TYPES[c.t].label}</span><div class="dist-track"><div class="dist-fill" style="width:${c.n / max * 100}%"></div></div><span class="dist-num">${c.n}</span></div>`).join('');

    let advice = '继续写下去，格式的事交给编辑器。';
    if (!scenes) advice = '先写一场戏：按 Ctrl + Enter 插入场景标题，格式形如「INT. 地点 - 日」。';
    else if (ratio > 68) advice = '对白占比偏高，试着加入更多可视化的动作描写，让画面替角色说话。';
    else if (ratio < 18 && chars > 300) advice = '动作描写很充分，可以让人物开口，让冲突在对白里爆发。';
    else if (scenes > 0 && chars / scenes > 900) advice = '单个场景偏长，考虑拆分场景或用转场切换节奏。';
    else if (chars > 300) advice = '场景与对白比例均衡。保持「每场戏都有变化」的节奏。';
    $('#statAdvice').textContent = advice;
  }

  function renderGoal() {
    const target = Number(script().targetPages) || 0;
    const pages = pageCount();
    const pct = target ? clamp(Math.round(pages / target * 100), 0, 100) : Math.min(100, pages * 2);
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = target
      ? `已完成 ${pages} / ${target} 页 · ${pct}%${pages >= target ? ' · 目标达成' : ''}`
      : `当前约 ${pages} 页 · 设定目标可追踪进度`;
    if ($('#targetPages') !== document.activeElement) $('#targetPages').value = target || '';
  }

  function renderSidebars() { renderOutline(); renderChars(); renderStats(); renderGoal(); }

  function renderPrintView() {
    const host = $('#printView');
    if (!host) return;
    host.replaceChildren();
    const s = script();
    const cover = document.createElement('div');
    cover.className = 'print-cover';
    const h1 = document.createElement('h1'); h1.textContent = s.title || '未命名剧本';
    const rule = document.createElement('div'); rule.className = 'pc-rule';
    const author = document.createElement('div'); author.className = 'pc-author'; author.textContent = s.author ? `编剧  ${s.author}` : '';
    const genre = document.createElement('div'); genre.className = 'pc-genre'; genre.textContent = s.genre || '';
    const log = document.createElement('div'); log.className = 'pc-logline'; log.textContent = s.logline || '';
    const foot = document.createElement('div'); foot.className = 'pc-foot'; foot.textContent = `${s.draft || '草稿'} · ${new Date(s.updatedAt).toLocaleDateString('zh-CN')}`;
    cover.append(h1, rule, author, genre, log, foot);
    host.appendChild(cover);
    for (const b of blocks()) {
      if (!b.text.trim()) continue;
      const d = document.createElement('div');
      d.className = 'pb pb-' + b.type;
      d.textContent = b.text;
      host.appendChild(d);
    }
  }

  function renderDocHeader() {
    const s = script();
    $('#docName').textContent = s.title;
    document.title = `${s.title} — 剧本工坊`;
    api.setTitle(s.title);
    $('#metaTitle').value = s.title;
    $('#metaAuthor').value = s.author;
    $('#metaGenre').value = s.genre;
    $('#metaLogline').value = s.logline;
    $('#coverFoot').textContent = `${s.draft || '草稿'} · ${new Date(s.updatedAt).toLocaleDateString('zh-CN')}`;
  }

  function renderDocMenu() {
    $('#docList').innerHTML = lib.scripts.map(s => `<div class="doc-item ${s.id === lib.activeId ? 'active' : ''}" data-doc-id="${s.id}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-file"/></svg>
      <span class="doc-item-name">${esc(s.title)}</span>
      <span class="doc-item-meta">${s.blocks.length} 块</span></div>`).join('');
  }

  function updateStatus() {
    const scenes = sceneList().filter(x => !x.section).length;
    $('#statusStats').textContent = `${scenes} 场 · ${bodyChars().toLocaleString()} 字 · ${charStats().length} 位角色 · 约 ${pageCount()} 页 / ${pageCount()} 分钟`;
    $('#statusZoom').textContent = Math.round(lib.settings.editorSize / 15 * 100) + '%';
    document.documentElement.style.setProperty('--editor-size', lib.settings.editorSize + 'px');
    $$('.block-input').forEach(autoHeight);
  }

  function renderAll() {
    renderDocHeader();
    renderDocMenu();
    renderBlocks();
    renderSidebars();
    renderPrintView();
    updateStatus();
    setActive(activeId || blocks()[0].id);
  }

  function refreshLight() {
    renderPrintView();
    updateStatus();
    clearTimeout(sideTimer);
    sideTimer = setTimeout(() => { renderOutline(); renderChars(); renderStats(); renderGoal(); }, 260);
    scheduleSave();
  }

  /* ------------------------------ 自动补全 ------------------------------ */
  function closeSuggest() {
    suggest = { open: false, items: [], index: 0, blockId: null };
    $('#suggest').classList.add('hidden');
  }

  function collectSuggestions(block) {
    const q = block.text.trim().toLowerCase();
    if (block.type === 'character') {
      const names = charStats().map(c => c.name);
      const base = names.filter(n => n.toLowerCase().includes(q));
      const suffixHits = q.length >= 2 ? CHAR_SUFFIX.filter(Boolean).map(s => q + s).filter(s => !names.includes(s)) : [];
      return [...base.map(v => ({ v, k: '已有角色' })), ...suffixHits.map(v => ({ v, k: '角色后缀' }))].slice(0, 8);
    }
    if (block.type === 'scene') {
      const past = blocks().filter(b => b.type === 'scene' && b.text.trim()).map(b => b.text.trim());
      const starts = SCENE_PREFIX.filter(p => p.toLowerCase().startsWith(q) && p.toLowerCase() !== q).map(v => ({ v, k: '场景前缀' }));
      const hist = past.filter(p => q.length >= 2 && p.toLowerCase().includes(q) && p.toLowerCase() !== q.toLowerCase()).map(v => ({ v, k: '历史场景' }));
      const m = q.match(/^(int\.\/ext\.|int\.|ext\.|est\.|内景|外景)\s+(.+?)(?:\s*-\s*.*)?$/i);
      const timeHits = m && m[2].trim() ? TIMES.slice(0, 5).map(t => `${m[1].toUpperCase()} ${m[2].trim()} - ${t}`).map(v => ({ v, k: '补全时间' })) : [];
      return [...starts, ...hist, ...timeHits].slice(0, 8);
    }
    if (block.type === 'transition') return TRANSITIONS.filter(t => t.toLowerCase().includes(q)).map(v => ({ v, k: '转场' })).slice(0, 8);
    if (block.type === 'parenthetical') return PARENS.filter(t => t.includes(q) || !q).map(v => ({ v, k: '表演提示' })).slice(0, 8);
    if (block.type === 'section') return SECTIONS.filter(t => t.includes(q) || !q).map(v => ({ v, k: '幕 / 分节' })).slice(0, 8);
    return [];
  }

  function updateSuggest(ta) {
    const b = blocks().find(x => x.id === ta.dataset.id);
    if (!b) return;
    const items = collectSuggestions(b);
    const filtered = items.filter(i => i.v.trim().toLowerCase() !== b.text.trim().toLowerCase());
    if (!filtered.length) { closeSuggest(); return; }
    suggest = { open: true, items: filtered, index: 0, blockId: b.id };
    const box = $('#suggest');
    const r = ta.getBoundingClientRect();
    box.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
    box.style.top = Math.min(r.bottom + 5, window.innerHeight - 230) + 'px';
    box.innerHTML = filtered.map((it, i) => `<div class="suggest-item ${i === 0 ? 'active' : ''}" data-sg="${i}"><span class="sg-main">${esc(it.v)}</span><span class="sg-kind">${esc(it.k)}</span></div>`).join('');
    box.classList.remove('hidden');
  }

  function moveSuggest(dir) {
    if (!suggest.open) return;
    suggest.index = (suggest.index + dir + suggest.items.length) % suggest.items.length;
    $$('#suggest .suggest-item').forEach((el, i) => el.classList.toggle('active', i === suggest.index));
    const active = $(`#suggest .suggest-item[data-sg="${suggest.index}"]`);
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function acceptSuggest(index) {
    if (!suggest.open) return false;
    const item = suggest.items[index ?? suggest.index];
    const ta = $(`.block-input[data-id="${suggest.blockId}"]`);
    if (!item || !ta) { closeSuggest(); return false; }
    const b = blocks().find(x => x.id === suggest.blockId);
    b.text = item.v;
    ta.value = item.v;
    autoHeight(ta);
    closeSuggest();
    focusBlock(b.id);
    refreshLight();
    scheduleHistory();
    return true;
  }

  /* ------------------------------ 块内键盘 ------------------------------ */
  function onBlockKeydown(e) {
    const ta = e.target.closest('.block-input');
    if (!ta || e.isComposing) return;
    const id = ta.dataset.id;
    const b = blocks().find(x => x.id === id);
    if (!b) return;

    if (suggest.open && suggest.blockId === id) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); acceptSuggest(); return; }
      if (e.key === 'Tab') { e.preventDefault(); acceptSuggest(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
    }

    if (e.altKey && e.key === 'Enter') { e.preventDefault(); openInlineAi(id); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); insertBlock(id, 'scene'); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateBlock(id); return; }
    if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveBlock(id, e.key === 'ArrowUp' ? -1 : 1); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      closeSuggest();
      cycleType(id, e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeSuggest();
      if (lib.settings.scriptFormat === 'cn' && b.type === 'action') {
        const txt = ta.value.trim();
        let sm;
        if (/^第\s*[0-9一二三四五六七八九十百千]+\s*场/.test(txt) || /^场景[：:]/.test(txt) || /^(内景|外景|内外景)[·\s]/.test(txt)) {
          const t2 = txt.replace(/^第\s*[0-9一二三四五六七八九十百千]+\s*场\s*/, '').replace(/^场景[：:]\s*/, '');
          b.text = sceneFromCN(t2);
          changeType(id, 'scene');
          return;
        }
        if ((sm = txt.match(/^([一-龥A-Za-z]{1,8})[：:]\s*(.+)$/))) {
          beginChange();
          b.type = 'character'; b.text = sm[1].trim();
          const d = newBlock('dialogue', sm[2].trim());
          const arr = blocks(); arr.splice(arr.indexOf(b) + 1, 0, d);
          changed(true); focusBlock(d.id);
          return;
        }
      }
      const start = ta.selectionStart, end = ta.selectionEnd;
      const text = ta.value;
      if (!text.trim()) {
        // 空块：连按回车退出对白流，进入动作 / 新场景
        changeType(id, b.type === 'action' ? 'scene' : 'action');
        return;
      }
      const before = text.slice(0, start);
      const after = text.slice(end);
      beginChange();
      b.text = before;
      const nb = newBlock(NEXT[b.type] || 'action', after);
      const arr = blocks();
      arr.splice(arr.indexOf(b) + 1, 0, nb);
      changed(true);
      focusBlock(nb.id, 0);
      scrollToBlock(nb.id);
      return;
    }

    if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const arr = blocks();
      const idx = arr.findIndex(x => x.id === id);
      if (idx > 0) {
        e.preventDefault();
        const prev = arr[idx - 1];
        if (!ta.value) {
          beginChange();
          arr.splice(idx, 1);
          changed(true);
          focusBlock(prev.id);
        } else {
          beginChange();
          const caret = prev.text.length;
          prev.text += ta.value;
          arr.splice(idx, 1);
          changed(true);
          focusBlock(prev.id, caret);
        }
        return;
      }
      if (idx === 0 && !ta.value) { e.preventDefault(); deleteBlock(id); return; }
    }

    if (e.key === 'ArrowUp' && ta.selectionStart === 0) {
      const idx = blocks().findIndex(x => x.id === id);
      if (idx > 0) { e.preventDefault(); focusBlock(blocks()[idx - 1].id); scrollToBlock(blocks()[idx - 1].id); }
      return;
    }
    if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length) {
      const idx = blocks().findIndex(x => x.id === id);
      if (idx < blocks().length - 1) { e.preventDefault(); focusBlock(blocks()[idx + 1].id); scrollToBlock(blocks()[idx + 1].id); }
    }
  }

  /* ------------------------------ 导入 / 导出 ------------------------------ */
  function parseFountain(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const meta = { title: '', author: '', genre: '', logline: '' };
    const body = [];
    const metaRe = /^(Title|Author|Credit|Genre|Logline|Draft date):\s*(.*)$/i;
    let inMeta = true;
    let blanks = 0, prevType = null;
    let noteBuffer = null;

    const isCharacter = (t) => {
      const name = t.replace(/\s*\((?:V\.O\.|O\.S\.|CONT'D|画外音|旁白)\)\s*$/i, '').trim();
      if (!name || name.length > 26 || /[。！？，、；：,.!?]$/.test(name)) return false;
      if (/^[A-Z0-9 .'\-]+$/.test(name)) return true;
      return /^[\u4e00-\u9fa5·A-Za-z0-9\s]{1,10}$/.test(name) && blanks > 0;
    };

    for (const line of lines) {
      const t = line.trim();
      if (!t) { blanks++; noteBuffer = null; continue; }
      if (inMeta && metaRe.test(t)) {
        const m = t.match(metaRe);
        const k = m[1].toLowerCase();
        if (k === 'title') meta.title = m[2];
        else if (k === 'author') meta.author = m[2];
        else if (k === 'genre') meta.genre = m[2];
        else if (k === 'logline') meta.logline = m[2];
        continue;
      }
      inMeta = false;

      if (noteBuffer !== null) {
        if (t === ']]' || t === '*/') { noteBuffer = null; continue; }
        const last = body[body.length - 1];
        if (last && last.type === 'note') last.text += '\n' + t.replace(/\*\//g, '').replace(/\]\]$/, '');
        continue;
      }
      if (/^\/\*/.test(t) || /^\[\[/.test(t)) {
        const content = t.replace(/^\/\*\s*/, '').replace(/^\[\[\s*/, '').replace(/\s*\*\/$/, '').replace(/\s*\]\]$/, '');
        body.push(newBlock('note', content));
        if (!/\*\/$/.test(t) && !/\]\]$/.test(t)) noteBuffer = true;
        prevType = 'note'; blanks = 0; continue;
      }
      if (/^#{1,3}\s?/.test(t)) {
        body.push(newBlock('section', t.replace(/^#+\s*/, '')));
        prevType = 'section'; blanks = 0; continue;
      }
      if (/^(INT\.?\/EXT\.?|INT\.|EXT\.|EST\.|I\/E\.|内景|外景|内外景)[\s.]/i.test(t)) {
        body.push(newBlock('scene', t)); prevType = 'scene'; blanks = 0; continue;
      }
      if (/^(FADE IN:|FADE OUT\.?|FADE TO BLACK\.|CUT TO:|CUT TO BLACK\.|DISSOLVE TO:|MATCH CUT TO:|SMASH CUT TO:|JUMP CUT TO:|叠化|淡入|淡出)/i.test(t) || (/^[A-Z ]+TO:$/.test(t) && t === t.toUpperCase())) {
        body.push(newBlock('transition', t)); prevType = 'transition'; blanks = 0; continue;
      }
      if (/^\(.*\)$/.test(t) || /^（.*）$/.test(t)) {
        body.push(newBlock('parenthetical', t)); prevType = 'parenthetical'; blanks = 0; continue;
      }
      if (blanks > 0 && isCharacter(t)) {
        body.push(newBlock('character', t)); prevType = 'character'; blanks = 0; continue;
      }
      if (blanks === 0 && (prevType === 'character' || prevType === 'parenthetical' || prevType === 'dialogue')) {
        body.push(newBlock('dialogue', t)); prevType = 'dialogue'; continue;
      }
      body.push(newBlock('action', t)); prevType = 'action'; blanks = 0;
    }
    return { meta, blocks: body.length ? body : [newBlock('action', '')] };
  }

  function toFountain(s) {
    const out = [`Title: ${s.title}`];
    if (s.author) out.push(`Author: ${s.author}`);
    if (s.genre) out.push(`Genre: ${s.genre}`);
    if (s.logline) out.push(`Logline: ${s.logline}`);
    for (const b of s.blocks) {
      const t = b.text.trim();
      if (!t) continue;
      switch (b.type) {
        case 'scene': out.push('', t.toUpperCase()); break;
        case 'action': out.push('', t); break;
        case 'character': out.push('', t.toUpperCase()); break;
        case 'dialogue': out.push(t); break;
        case 'parenthetical': out.push(/^[（(]/.test(t) ? t : `(${t})`); break;
        case 'transition': out.push('', t.toUpperCase()); break;
        case 'section': out.push('', '# ' + t); break;
        case 'note': out.push('', `[[${t}]]`); break;
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function toPlainText(s) {
    const out = [`${s.title}`, s.author ? `编剧：${s.author}` : '', s.genre ? `类型：${s.genre}` : '', ''];
    for (const b of s.blocks) {
      if (b.type === 'note' || !b.text.trim()) continue;
      const lines = b.text.split('\n');
      for (const line of lines) {
        if (b.type === 'character') out.push(' '.repeat(22) + line.toUpperCase());
        else if (b.type === 'dialogue') out.push(' '.repeat(10) + line);
        else if (b.type === 'parenthetical') out.push(' '.repeat(16) + line);
        else if (b.type === 'transition') out.push(' '.repeat(Math.max(0, 56 - line.length)) + line.toUpperCase());
        else if (b.type === 'section') out.push('        ' + line);
        else out.push(line);
      }
      if (['scene', 'action', 'transition', 'section'].includes(b.type)) out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function sceneCN(text) {
    let t = String(text || '').trim().replace(/\s*[-–—]\s*/g, '·');
    if (/^int\.?\s*/i.test(t)) t = '内景·' + t.replace(/^int\.?\s*/i, '');
    else if (/^ext\.?\s*/i.test(t)) t = '外景·' + t.replace(/^ext\.?\s*/i, '');
    return t;
  }

  function sceneFromCN(text) {
    let t = String(text || '').trim();
    if (/^内景/.test(t)) t = 'INT. ' + t.replace(/^内景[·\s]*/, '').replace(/·/g, ' - ');
    else if (/^外景/.test(t)) t = 'EXT. ' + t.replace(/^外景[·\s]*/, '').replace(/·/g, ' - ');
    return t;
  }

  function toScriptCN(s) {
    const lines = [];
    if (s.title) lines.push(`《${s.title}》`);
    if (s.author) lines.push(`编剧：${s.author}`);
    if (s.genre) lines.push(`类型：${s.genre}`);
    let sceneNo = 0;
    for (const b of s.blocks) {
      const t = b.text.trim();
      if (!t) continue;
      if (b.type === 'note') continue;
      if (['scene', 'action', 'transition', 'section'].includes(b.type)) lines.push('');
      switch (b.type) {
        case 'scene': sceneNo++; lines.push(`第${sceneNo}场　${sceneCN(t)}`); break;
        case 'action': lines.push(t); break;
        case 'character': lines.push(t); break;
        case 'dialogue': lines.push('　　' + t); break;
        case 'parenthetical': lines.push('　　（' + t.replace(/^[（(]|[）)]$/g, '') + '）'); break;
        case 'transition': lines.push(t); break;
        case 'section': lines.push(`【${t}】`); break;
      }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trim() + '\n';
  }

  function looksLikeCN(text) {
    return /第\s*[0-9一二三四五六七八九十百千]+\s*场/.test(text) ||
      /编剧[：:]/i.test(text) ||
      /^\s*《.+》\s*$/m.test(text);
  }

  function detectFormat(text, fmt) {
    if (fmt && fmt !== 'auto') return fmt;
    return looksLikeCN(text) ? 'cn' : 'fountain';
  }

  function parseScriptCN(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const meta = { title: '', author: '', genre: '', logline: '' };
    const blocks = [];
    const push = (type, txt) => { if (txt != null) blocks.push({ type, text: txt }); };
    const n = lines.length;
    let i = 0;
    while (i < n) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { i++; continue; }
      let m;
      if ((m = line.match(/^\s*《(.+?)》\s*$/))) { if (!meta.title) meta.title = m[1]; i++; continue; }
      if ((m = line.match(/^编剧[：:]\s*(.+)$/))) { meta.author = m[1].trim(); i++; continue; }
      if ((m = line.match(/^类型[：:]\s*(.+)$/))) { meta.genre = m[1].trim(); i++; continue; }
      if ((m = line.match(/^\s*[#＊*]\s*(.+)$/))) { push('section', m[1].trim()); i++; continue; }
      if (/^[【〔].+[】〕]$/.test(line) && !/^[【〔]\s*[场景场]/.test(line)) { push('section', line.replace(/^[【〔]|[】〕]$/g, '')); i++; continue; }
      if (/^第\s*[0-9一二三四五六七八九十百千]+\s*场/.test(line) || /^\s*场景[：:]/i.test(line)) {
        const t = line.replace(/^第\s*[0-9一二三四五六七八九十百千]+\s*场\s*/, '').replace(/^\s*场景[：:]\s*/i, '').trim();
        push('scene', sceneFromCN(t)); i++; continue;
      }
      if (/^[（(].+[）)]$/.test(line) && !/[：:]/.test(line)) { push('parenthetical', line.replace(/^[（(]|[）)]$/g, '')); i++; continue; }
      if ((m = line.match(/^(.+?)[：:](.+)$/))) { push('character', m[1].trim()); push('dialogue', m[2].trim()); i++; continue; }
      if (i + 1 < n && lines[i + 1].match(/^\s{2,}/) && !raw.match(/^\s{2,}/)) {
        push('character', line); push('dialogue', lines[i + 1].replace(/^\s+/, '')); i += 2; continue;
      }
      push('action', line); i++;
    }
    return { meta, blocks };
  }

  function toProject(s) {
    return JSON.stringify({ format: 'scriptwriter.screenplay', version: 1, exportedAt: new Date().toISOString(), ...s }, null, 2);
  }

  function safeFileName(name) { return String(name || '剧本').replace(/[\\/:*?"<>|]/g, '_'); }

  function exportBaseName(s) {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${safeFileName(s.title)}_${date}`;
  }

  async function doExport(kind) {
    const s = script();
    const base = exportBaseName(s);
    if (kind === 'pdf') {
      toast('正在生成 PDF…');
      const r = await api.exportPDF({ defaultName: base + '.pdf' });
      if (r && r.ok) toast('PDF 已导出');
      else if (r && r.error) toast('导出失败：' + r.error, true);
      return;
    }
    if (kind === 'print') { await api.print(); return; }
    let content, name, filters;
    if (kind === 'fountain') {
      content = toFountain(s); name = base + '.fountain';
      filters = [{ name: 'Fountain 剧本', extensions: ['fountain'] }, { name: '所有文件', extensions: ['*'] }];
    } else if (kind === 'cn') {
      content = toScriptCN(s); name = base + '.txt';
      filters = [{ name: '国内剧本格式', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
    } else if (kind === 'txt') {
      content = toPlainText(s); name = base + '.txt';
      filters = [{ name: '纯文本', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
    } else {
      content = toProject(s); name = base + '.screenplay';
      filters = [{ name: '剧本工程', extensions: ['screenplay'] }, { name: '所有文件', extensions: ['*'] }];
    }
    const r = await api.saveFile({ content, defaultName: name, filters });
    if (r && r.error) toast('导出失败：' + r.error, true);
    else if (r && r.path) toast('已导出：' + r.path.split(/[\\/]/).pop());
  }

  function downloadBlob(name, content) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function addImportedScript(title, bs, meta) {
    beginChange();
    const s = makeScript(title, bs);
    if (meta) { s.author = meta.author || ''; s.genre = meta.genre || ''; s.logline = meta.logline || ''; }
    lib.scripts.push(s);
    lib.activeId = s.id;
    activeId = s.blocks[0].id;
    history = []; future = [];
    settleHistory();
    renderAll();
    closeModal();
    toast(`已导入 ${s.blocks.length} 个内容块`);
  }

  async function importFromFile() {
    if (!api.isDesktop) { toast('请粘贴文本导入（桌面版支持直接打开文件）', true); return; }
    const f = await api.openFile();
    if (!f) return;
    if (f.error) { toast('读取失败：' + f.error, true); return; }
    const name = f.name.replace(/\.[^.]+$/, '');
    if (/\.(json|screenplay)$/i.test(f.name)) {
      try {
        const raw = JSON.parse(f.content);
        if (raw && Array.isArray(raw.blocks)) { addImportedScript(raw.title || name, raw.blocks.map(b => ({ ...b, id: uid() })), raw); return; }
        if (raw && Array.isArray(raw.scripts)) {
          const imported = raw.scripts.map(normalizeScript);
          lib.scripts.push(...imported);
          lib.activeId = imported[0].id;
          renderAll(); closeModal(); toast(`已导入 ${imported.length} 个剧本`);
          return;
        }
      } catch { /* 按纯文本处理 */ }
    }
    const parsed = (/\.txt$/i.test(f.name) && looksLikeCN(f.content)) ? parseScriptCN(f.content) : parseFountain(f.content);
    addImportedScript(parsed.meta.title || name, parsed.blocks, parsed.meta);
  }

  function importFromPaste(text, fmt) {
    if (!text.trim()) { toast('请先粘贴内容', true); return; }
    const f = detectFormat(text, fmt);
    const parsed = f === 'cn' ? parseScriptCN(text) : parseFountain(text);
    addImportedScript(parsed.meta.title || '导入的剧本', parsed.blocks, parsed.meta);
  }

  /* ------------------------------ 剧本文档 ------------------------------ */
  function switchScript(id) {
    if (id === lib.activeId) { $('#docMenu').classList.add('hidden'); return; }
    commitHistory();
    lib.activeId = id;
    activeId = blocks()[0].id;
    history = []; future = []; settleHistory();
    renderAll();
    $('#docMenu').classList.add('hidden');
    toast('已切换到「' + script().title + '」');
  }

  function newScript() {
    showModal({
      title: '新建剧本',
      body: `<label class="modal-field"><span>剧本标题</span><input id="newTitle" type="text" placeholder="例如：雨夜便利店" value="未命名剧本"></label>
             <div class="modal-hint">新剧本会带一个空白场景标题，可直接开始写。原有剧本不会丢失。</div>`,
      actions: [
        { label: '取消' },
        { label: '创建', primary: true, onClick: () => {
          const title = ($('#newTitle').value || '').trim() || '未命名剧本';
          const s = makeScript(title);
          lib.scripts.push(s); lib.activeId = s.id; activeId = s.blocks[0].id;
          history = []; future = []; settleHistory();
          renderAll(); closeModal(); toast('已创建「' + title + '」');
        } }
      ],
      onMount: () => { const i = $('#newTitle'); i.focus(); i.select(); }
    });
  }

  function renameScript() {
    showModal({
      title: '重命名剧本',
      body: `<label class="modal-field"><span>剧本标题</span><input id="renameTitle" type="text" value=""></label>`,
      actions: [{ label: '取消' }, { label: '保存', primary: true, onClick: () => {
        script().title = ($('#renameTitle').value || '').trim() || '未命名剧本';
        scheduleSave(); renderDocHeader(); renderDocMenu(); closeModal();
      } }],
      onMount: () => { const i = $('#renameTitle'); i.value = script().title; i.focus(); i.select(); }
    });
  }

  function duplicateScript() {
    const src = script();
    const copy = normalizeScript(JSON.parse(JSON.stringify(src)));
    copy.id = uid(); copy.title = src.title + ' 副本';
    copy.blocks.forEach(b => b.id = uid());
    copy.createdAt = copy.updatedAt = Date.now();
    lib.scripts.push(copy); lib.activeId = copy.id; activeId = copy.blocks[0].id;
    renderAll(); $('#docMenu').classList.add('hidden');
    toast('已创建副本');
  }

  function deleteScript() {
    if (lib.scripts.length <= 1) { toast('至少保留一个剧本', true); return; }
    showModal({
      title: '删除剧本',
      body: `<p>确定要删除「<strong>${esc(script().title)}</strong>」吗？此操作无法撤销。</p>`,
      actions: [{ label: '取消' }, { label: '删除', danger: true, onClick: () => {
        lib.scripts = lib.scripts.filter(s => s.id !== lib.activeId);
        lib.activeId = lib.scripts[0].id; activeId = blocks()[0].id;
        history = []; future = []; settleHistory();
        renderAll(); $('#docMenu').classList.add('hidden'); closeModal(); toast('已删除');
      } }]
    });
  }

  /* ------------------------------ 主题 / 视图 ------------------------------ */
  const DEFAULT_VIEW = {
    theme: 'dark', zen: false, editorSize: 15,
    leftWidth: 264, rightWidth: 286, aiWidth: 400, aiLastTab: 'chars',
    paper: '', ink: '', font: 'courier', fontCustom: '', scriptFormat: 'fountain',
    leading: 1.5, paperWidth: 790
  };
  const FONT_PRESETS = {
    courier: { label: '等宽 · Courier New（默认）', css: '"Courier New", "Courier", "Songti SC", "SimSun", monospace' },
    simsun:  { label: '宋体 · SimSun', css: '"SimSun", "宋体", "Songti SC", serif' },
    serif:   { label: '思源宋体 / Noto Serif', css: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif' },
    yahei:   { label: '黑体 · 微软雅黑', css: '"Microsoft YaHei", "PingFang SC", "Heiti SC", sans-serif' },
    kaiti:   { label: '楷体 · KaiTi', css: '"KaiTi", "楷体", "STKaiti", serif' },
    georgia: { label: 'Georgia · 英文衬线', css: 'Georgia, "Times New Roman", serif' },
    custom:  { label: '自定义字体…', css: '' }
  };
  const PAPER_PRESETS = [
    { label: '米白', paper: '#fbf9f4', ink: '#1e2026' },
    { label: '纯白', paper: '#ffffff', ink: '#1c1e24' },
    { label: '淡黄', paper: '#fdf6e3', ink: '#3a3529' },
    { label: '护眼绿', paper: '#eaf3e7', ink: '#26342a' },
    { label: '浅灰', paper: '#f2f3f5', ink: '#262a33' },
    { label: '夜间纸', paper: '#22262e', ink: '#e8ebf3' }
  ];

  function normalizeSettings(raw) {
    const s = { ...DEFAULT_VIEW, ...(raw || {}) };
    s.editorSize = clamp(Number(s.editorSize) || 15, 10, 32);
    s.leftWidth = clamp(Number(s.leftWidth) || DEFAULT_VIEW.leftWidth, 190, 460);
    s.rightWidth = clamp(Number(s.rightWidth) || DEFAULT_VIEW.rightWidth, 230, 560);
    s.aiWidth = clamp(Number(s.aiWidth) || DEFAULT_VIEW.aiWidth, 320, 620);
    s.aiLastTab = ['chars', 'stats', 'ai'].includes(s.aiLastTab) ? s.aiLastTab : 'chars';
    s.leading = clamp(Number(s.leading) || DEFAULT_VIEW.leading, 1.2, 2.4);
    s.paperWidth = clamp(Number(s.paperWidth) || DEFAULT_VIEW.paperWidth, 600, 1180);
    s.paper = /^#[0-9a-f]{6}$/i.test(s.paper || '') ? s.paper : '';
    s.ink = /^#[0-9a-f]{6}$/i.test(s.ink || '') ? s.ink : '';
    if (!FONT_PRESETS[s.font]) s.font = 'courier';
    s.scriptFormat = s.scriptFormat === 'cn' ? 'cn' : 'fountain';
    s.fontCustom = String(s.fontCustom || '').slice(0, 160);
    return s;
  }

  function applyAppearance(settings) {
    if (!lib) return;
    const v = normalizeSettings(settings || lib.settings);
    const root = document.documentElement;
    const set = (k, val) => root.style.setProperty(k, val);
    set('--editor-size', v.editorSize + 'px');
    set('--editor-leading', String(v.leading));
    set('--paper-width', v.paperWidth + 'px');
    set('--left-w', v.leftWidth + 'px');
    set('--right-w', v.rightWidth + 'px');
    if (v.paper) set('--paper', v.paper); else root.style.removeProperty('--paper');
    if (v.ink) set('--paper-ink', v.ink); else root.style.removeProperty('--paper-ink');
    const preset = FONT_PRESETS[v.font] || FONT_PRESETS.courier;
    set('--paper-font', (v.font === 'custom' && v.fontCustom.trim()) ? v.fontCustom.trim() : (preset.css || FONT_PRESETS.courier.css));
    $('#app').classList.toggle('custom-paper', Boolean(v.paper || v.ink));
    $('#blocks').classList.toggle('fmt-cn', v.scriptFormat === 'cn');
    $$('.block-input').forEach(autoHeight);
  }

  function setScriptFormat(fmt) {
    lib.settings.scriptFormat = fmt === 'cn' ? 'cn' : 'fountain';
    applyAppearance(lib.settings);
    renderBlocks();
    scheduleSave();
    toast(lib.settings.scriptFormat === 'cn' ? '已切换为国内剧本格式（视图）' : '已切换为 Fountain 标准格式（视图）');
  }

  function setPanelWidth(side, w) {
    if (side === 'right' && $('#app').classList.contains('ai-mode')) lib.settings.aiWidth = w;
    else lib.settings[side === 'left' ? 'leftWidth' : 'rightWidth'] = w;
    document.documentElement.style.setProperty(side === 'left' ? '--left-w' : '--right-w', w + 'px');
  }

  // AI 会话面板需要更宽的阅读区；宽度单独持久化，切回角色/统计时恢复原宽度
  function applyAiPanelWidth(on) {
    if (!lib) return;
    const w = on ? lib.settings.aiWidth : lib.settings.rightWidth;
    document.documentElement.style.setProperty('--right-w', w + 'px');
  }

  function bindSplitters() {
    $$('.splitter').forEach(handle => {
      handle.addEventListener('pointerdown', (e) => {
        if ($('#app').classList.contains('zen')) return;
        e.preventDefault();
        const side = handle.dataset.side;
        const rect = $('#workspace').getBoundingClientRect();
        $('#app').classList.add('resizing');
        handle.classList.add('active');
        const move = (ev) => {
          const w = side === 'left'
            ? clamp(ev.clientX - rect.left, 190, 460)
            : clamp(rect.right - ev.clientX, 230, 560);
          setPanelWidth(side, Math.round(w));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          $('#app').classList.remove('resizing');
          handle.classList.remove('active');
          scheduleSave();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      handle.addEventListener('dblclick', () => {
        setPanelWidth(handle.dataset.side, handle.dataset.side === 'left' ? DEFAULT_VIEW.leftWidth : DEFAULT_VIEW.rightWidth);
        scheduleSave();
        toast('面板宽度已恢复默认');
      });
    });
  }

  function openAppearance() {
    const base = normalizeSettings(lib.settings);
    const swatches = PAPER_PRESETS.map(p =>
      `<button class="swatch" type="button" data-paper="${p.paper}" data-ink="${p.ink}" title="${esc(p.label)}" style="--sw:${p.paper}"></button>`).join('');
    const fontOptions = Object.entries(FONT_PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    const row = (id, label, min, max, step) =>
      `<div class="view-row"><label>${label}</label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}"><output id="${id}Out"></output></div>`;
    showModal({
      title: '编辑器外观与面板布局', wide: true,
      body: `<div class="view-hint">拖动左右面板的分隔条可直接调整宽度，双击恢复默认；下方改动实时预览，保存后写入本机配置。</div>
        <div class="view-section">
          <div class="view-title">稿纸</div>
          <div class="view-color">
            <span class="view-label">纸张颜色</span>
            <label class="view-check"><input type="checkbox" id="viewPaperOn">自定义</label>
            <input type="color" id="viewPaper" value="#fbf9f4">
            <div class="view-swatches">${swatches}</div>
          </div>
          <div class="view-color">
            <span class="view-label">文字颜色</span>
            <label class="view-check"><input type="checkbox" id="viewInkOn">自定义</label>
            <input type="color" id="viewInk" value="#1e2026">
          </div>
          <div class="view-font-row"><label>正文字体</label><select id="viewFont">${fontOptions}</select></div>
          <div class="view-font-row" id="viewFontCustomRow"><label>字体名称</label><input id="viewFontCustom" type="text" spellcheck="false" placeholder="例如：'Noto Serif SC', serif"></div>
          ${row('viewSize', '字号', 12, 24, 1)}
          ${row('viewLeading', '行距', 1.2, 2.2, 0.1)}
          ${row('viewWidth', '纸张宽度', 600, 1100, 10)}
          <div class="view-note">字体、字号与纸张颜色只作用于稿纸，导出的 PDF 会沿用所选字体。</div>
        </div>
        <div class="view-section">
          <div class="view-title">剧本格式（仅编辑器呈现）</div>
          <div class="view-font-row"><label>显示格式</label><select id="viewFormat"><option value="fountain">Fountain 标准</option><option value="cn">国内剧本（场次·角色居中·台词缩进）</option></select></div>
          <div class="view-note">切换后编辑器按所选风格排版；导出时仍可单独选择 Fountain 或国内格式。</div>
        </div>
        <div class="view-section">
          <div class="view-title">面板布局</div>
          ${row('viewLeft', '左侧大纲', 190, 460, 2)}
          ${row('viewRight', '右侧面板', 230, 560, 2)}
        </div>`,
      actions: [
        { label: '恢复默认', onClick: () => { fillForm(DEFAULT_VIEW); onFormChange(); } },
        { label: '取消' },
        { label: '保存', primary: true, onClick: () => {
          Object.assign(lib.settings, draft());
          appearanceModalOpen = false;
          applyAppearance(lib.settings);
          renderBlocks();
          updateStatus();
          scheduleSave();
          closeModal();
          toast('外观设置已保存');
        } }
      ],
      onMount: () => {
        fillForm(base);
        $('#modalBody').addEventListener('input', onFormChange);
        $('#modalBody').addEventListener('change', onFormChange);
        $$('.swatch').forEach(sw => sw.addEventListener('click', () => {
          $('#viewPaperOn').checked = true;
          $('#viewInkOn').checked = true;
          $('#viewPaper').value = sw.dataset.paper;
          $('#viewInk').value = sw.dataset.ink;
          onFormChange();
        }));
      }
    });
    appearanceModalOpen = true;

    function draft() {
      return normalizeSettings({
        ...lib.settings,
        scriptFormat: $('#viewFormat').value,
        paper: $('#viewPaperOn').checked ? $('#viewPaper').value : '',
        ink: $('#viewInkOn').checked ? $('#viewInk').value : '',
        font: $('#viewFont').value,
        fontCustom: $('#viewFontCustom').value,
        editorSize: Number($('#viewSize').value),
        leading: Number($('#viewLeading').value),
        paperWidth: Number($('#viewWidth').value),
        leftWidth: Number($('#viewLeft').value),
        rightWidth: Number($('#viewRight').value)
      });
    }
    function fillForm(s) {
      const v = normalizeSettings(s);
      $('#viewPaperOn').checked = Boolean(v.paper);
      $('#viewPaper').value = v.paper || '#fbf9f4';
      $('#viewInkOn').checked = Boolean(v.ink);
      $('#viewInk').value = v.ink || '#1e2026';
      $('#viewFont').value = v.font;
      $('#viewFontCustom').value = v.fontCustom;
      $('#viewFormat').value = v.scriptFormat;
      $('#viewSize').value = v.editorSize;
      $('#viewLeading').value = v.leading;
      $('#viewWidth').value = v.paperWidth;
      $('#viewLeft').value = v.leftWidth;
      $('#viewRight').value = v.rightWidth;
      syncOutputs();
      toggleCustomFont();
      $$('.swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.paper === v.paper));
    }
    function syncOutputs() {
      $('#viewSizeOut').textContent = $('#viewSize').value + ' px';
      $('#viewLeadingOut').textContent = Number($('#viewLeading').value).toFixed(1);
      $('#viewWidthOut').textContent = $('#viewWidth').value + ' px';
      $('#viewLeftOut').textContent = $('#viewLeft').value + ' px';
      $('#viewRightOut').textContent = $('#viewRight').value + ' px';
    }
    function toggleCustomFont() {
      $('#viewFontCustomRow').classList.toggle('hidden', $('#viewFont').value !== 'custom');
    }
    function onFormChange() {
      syncOutputs();
      toggleCustomFont();
      applyAppearance(draft());
      $$('.swatch').forEach(sw => sw.classList.toggle('active', $('#viewPaperOn').checked && sw.dataset.paper === $('#viewPaper').value));
    }
  }

  function applyTheme(t) {
    const theme = t === 'light' ? 'light' : 'dark';
    lib.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    $('#themeBtn').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-${theme === 'dark' ? 'moon' : 'sun'}"/></svg>`;
    api.setTheme(theme);
    scheduleSave();
  }
  function toggleTheme() { applyTheme(lib.settings.theme === 'dark' ? 'light' : 'dark'); }
  function toggleZen() {
    lib.settings.zen = !lib.settings.zen;
    $('#app').classList.toggle('zen', lib.settings.zen);
    $('#focusBtn').classList.toggle('primary', lib.settings.zen);
    scheduleSave();
    toast(lib.settings.zen ? '专注模式：已隐藏侧栏（F11 退出）' : '已退出专注模式');
  }
  function zoom(delta) {
    lib.settings.editorSize = clamp(lib.settings.editorSize + delta, 12, 20);
    updateStatus(); applyAppearance(lib.settings); scheduleSave();
  }
  function togglePanel(which) {
    const cls = which === 'left' ? 'force-left' : 'force-right';
    $('#app').classList.toggle(cls);
  }

  /* ------------------------------ 动作表 ------------------------------ */
  const ACTIONS = {
    new:        { label: '新建剧本', desc: '创建一个新剧本文档', icon: 'i-plus', key: 'Ctrl+N', group: '文件', run: newScript },
    importFile: { label: '打开剧本文件…', desc: '导入 .fountain / .txt / .screenplay', icon: 'i-folder', key: 'Ctrl+O', group: '文件', run: importFromFile },
    importPaste:{ label: '从文本粘贴导入…', desc: '解析 Fountain 格式的剧本文本', icon: 'i-file', group: '文件', run: openImportModal },
    save:       { label: '立即保存', desc: '写入本机文档库', icon: 'i-check', key: 'Ctrl+S', group: '文件', run: () => saveNow(false) },
    saveAs:     { label: '另存为剧本工程…', desc: '完整工程文件，可再次导入', icon: 'i-download', key: 'Ctrl+Shift+S', group: '文件', run: () => doExport('project') },
    workspace:  { label: '设置工作目录…', desc: '更改剧本文档的保存位置，可迁移已有剧本', icon: 'i-folder', group: '文件', run: () => openWorkspace() },
    undo:       { label: '撤销', desc: '回到上一步', icon: 'i-undo', key: 'Ctrl+Z', group: '编辑', run: undo },
    redo:       { label: '重做', desc: '恢复刚才撤销的操作', icon: 'i-undo', key: 'Ctrl+Shift+Z', group: '编辑', run: redo },
    deleteBlock:{ label: '删除当前内容块', desc: '合并或移除当前段落', icon: 'i-trash', group: '编辑', run: () => activeId && deleteBlock(activeId) },
    dupBlock:   { label: '复制当前内容块', desc: '在下方插入副本', icon: 'i-copy', key: 'Ctrl+D', group: '编辑', run: () => activeId && duplicateBlock(activeId) },
    moveUp:     { label: '上移当前内容块', desc: '与上方块交换位置', icon: 'i-chevron', key: 'Ctrl+↑', group: '编辑', run: () => activeId && moveBlock(activeId, -1) },
    moveDown:   { label: '下移当前内容块', desc: '与下方块交换位置', icon: 'i-chevron', key: 'Ctrl+↓', group: '编辑', run: () => activeId && moveBlock(activeId, 1) },
    newScene:   { label: '新建场景', desc: '插入场景标题 INT./EXT.', icon: 'i-scene', key: 'Ctrl+Enter', group: '插入', run: () => appendTypedBlock('scene') },
    insAction:  { label: '插入动作描述', desc: '场景中的画面与动作', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('action') },
    insChar:    { label: '插入角色', desc: '说话的角色名', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('character') },
    insDlg:     { label: '插入对白', desc: '角色台词', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('dialogue') },
    insParen:   { label: '插入括号提示', desc: '语气、动作提示', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('parenthetical') },
    insTrans:   { label: '插入转场', desc: 'CUT TO: / FADE OUT.', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('transition') },
    insSection: { label: '插入幕 / 分节', desc: '剧本结构分节', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('section') },
    insNote:    { label: '插入备注', desc: '写给自己的笔记，不导出', icon: 'i-plus', group: '插入', run: () => appendTypedBlock('note') },
    zen:        { label: '切换专注模式', desc: '隐藏所有侧栏，只留下稿纸', icon: 'i-focus', key: 'F11', group: '视图', run: toggleZen },
    theme:      { label: '切换明暗主题', desc: '暗房 / 纸白', icon: 'i-moon', group: '视图', run: toggleTheme },
    appearance: { label: '编辑器外观与面板布局…', desc: '纸张颜色、正文字体、字号、行距与面板宽度', icon: 'i-sun', group: '视图', run: openAppearance },
    zoomIn:     { label: '放大正文', desc: '增大剧本字号', icon: 'i-plus', key: 'Ctrl+=', group: '视图', run: () => zoom(1) },
    zoomOut:    { label: '缩小正文', desc: '减小剧本字号', icon: 'i-plus', key: 'Ctrl+-', group: '视图', run: () => zoom(-1) },
    panelLeft:  { label: '显示 / 隐藏大纲', desc: '窄窗口下的场景大纲', icon: 'i-scene', group: '视图', run: () => togglePanel('left') },
    panelRight: { label: '显示 / 隐藏角色与统计', desc: '窄窗口下的右侧面板', icon: 'i-chart', group: '视图', run: () => togglePanel('right') },
    fmtFountain:{ label: '格式：Fountain 标准', desc: '编辑器按 Fountain 风格呈现', icon: 'i-cmd', group: '视图', run: () => setScriptFormat('fountain') },
    fmtCn:      { label: '格式：国内剧本', desc: '场次编号、角色居中、台词缩进', icon: 'i-cmd', group: '视图', run: () => setScriptFormat('cn') },
    command:    { label: '打开命令面板', desc: '搜索命令与场景', icon: 'i-cmd', key: 'Ctrl+K', group: '视图', run: openCommand },
    expFtn:     { label: '导出 Fountain', desc: '通用编剧格式，可与 Final Draft 等互通', icon: 'i-download', group: '导出', run: () => doExport('fountain') },
    expTxt:     { label: '导出纯文本', desc: '保留剧本缩进的 .txt', icon: 'i-download', group: '导出', run: () => doExport('txt') },
    expCn:      { label: '导出国内格式', desc: '剧本杀 / 话剧式排版：角色独占行、场次编号', icon: 'i-download', group: '导出', run: () => doExport('cn') },
    expProj:    { label: '导出剧本工程', desc: '包含全部元数据的 .screenplay', icon: 'i-download', group: '导出', run: () => doExport('project') },
    expPdf:     { label: '导出 PDF 剧本', desc: 'A4 标准剧本排版，封面独立成页', icon: 'i-print', key: 'Ctrl+P', group: '导出', run: () => doExport('pdf') },
    expPrint:   { label: '打印…', desc: '调用系统打印对话框', icon: 'i-print', group: '导出', run: () => doExport('print') },
    shortcuts:  { label: '快捷键一览', desc: '查看全部键盘操作', icon: 'i-keyboard', group: '帮助', run: openShortcuts },
    about:      { label: '关于剧本工坊', desc: '版本与功能说明', icon: 'i-logo', group: '帮助', run: openAbout }
  };

  const MENUS = {
    file:   [ 'new', 'importFile', 'importPaste', '-', 'save', 'saveAs', '-', 'workspace' ],
    edit:   [ 'undo', 'redo', '-', 'dupBlock', 'deleteBlock', 'moveUp', 'moveDown' ],
    insert: [ 'newScene', 'insAction', 'insChar', 'insDlg', 'insParen', 'insTrans', 'insSection', 'insNote' ],
    view:   [ 'zen', 'theme', '-', 'appearance', 'fmtFountain', 'fmtCn', '-', 'zoomIn', 'zoomOut', 'panelLeft', 'panelRight', '-', 'command' ],
    export: [ 'expFtn', 'expCn', 'expTxt', 'expProj', '-', 'expPdf', 'expPrint' ],
    help:   [ 'shortcuts', 'about' ]
  };

  /* ------------------------------ 菜单 ------------------------------ */
  function closeMenus() {
    $('#menuPopup').classList.add('hidden');
    $$('.menu-root').forEach(b => b.classList.remove('open'));
    menuOpen = null;
  }

  function showMenu(kind, anchor) {
    if (menuOpen === kind) { closeMenus(); return; }
    closeMenus();
    menuOpen = kind;
    const btn = anchor || $(`.menu-root[data-menu="${kind}"]`);
    if (btn) { $$('.menu-root').forEach(b => b.classList.remove('open')); btn.classList.add('open'); }
    const r = (btn || anchor).getBoundingClientRect();
    const box = $('#menuPopup');
    box.innerHTML = MENUS[kind].map(id => {
      if (id === '-') return '<div class="menu-sep"></div>';
      const a = ACTIONS[id];
      return `<button class="menu-item" data-action="${id}"><svg class="ic" viewBox="0 0 24 24"><use href="#${a.icon}"/></svg><span class="mi-label">${a.label}</span><span class="mi-key">${a.key || ''}</span></button>`;
    }).join('');
    box.style.left = r.left + 'px';
    box.style.top = r.bottom + 3 + 'px';
    box.classList.remove('hidden');
  }

  function showTypeMenu(id, anchor) {
    closeMenus();
    const b = blocks().find(x => x.id === id);
    if (!b) return;
    const r = anchor.getBoundingClientRect();
    const box = $('#menuPopup');
    box.innerHTML = `<div class="menu-heading">切换元素类型</div>` + ORDER.map((t, i) =>
      `<button class="menu-item ${b.type === t ? 'active' : ''}" data-type="${t}" data-block="${id}"><span class="mi-label">${b.type === t ? '✓ ' : '　'}${TYPES[t].label}</span><span class="mi-key">${i + 1}</span></button>`
    ).join('');
    box.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
    box.style.top = r.bottom + 3 + 'px';
    box.classList.remove('hidden');
  }

  function showInsertMenu(beforeId, anchor) {
    closeMenus();
    const r = (anchor || document.activeElement).getBoundingClientRect();
    const box = $('#menuPopup');
    box.innerHTML = `<div class="menu-heading">插入内容块</div>` + ORDER.map((t, i) =>
      `<button class="menu-item" data-insert-type="${t}" data-insert-before="${beforeId}"><span class="mi-label">${TYPES[t].label}</span><span class="mi-key">${i + 1}</span></button>`
    ).join('');
    box.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
    box.style.top = r.bottom + 3 + 'px';
    box.classList.remove('hidden');
  }

  /* ------------------------------ 命令面板 ------------------------------ */
  function openCommand() {
    $('#cmdOverlay').classList.remove('hidden');
    $('#cmdInput').value = '';
    cmdIndex = 0;
    renderCommand('');
    setTimeout(() => $('#cmdInput').focus(), 20);
  }
  function closeCommand() { $('#cmdOverlay').classList.add('hidden'); }
  function commandData() {
    const base = Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, desc: a.group + ' · ' + a.desc, icon: a.icon, run: a.run }));
    for (const s of sceneList()) {
      if (s.section) continue;
      base.push({ id: 'goto:' + s.id, label: `跳到第 ${s.index} 场：${s.place}`, desc: `${s.kind || '场景'} · ${s.time} · ${s.chars} 字`, icon: 'i-scene', run: () => { focusBlock(s.id); scrollToBlock(s.id); } });
    }
    return base;
  }
  function renderCommand(q) {
    const query = q.trim().toLowerCase();
    cmdItems = commandData().filter(x => !query || x.label.toLowerCase().includes(query) || x.desc.toLowerCase().includes(query)).slice(0, 40);
    cmdIndex = clamp(cmdIndex, 0, Math.max(0, cmdItems.length - 1));
    $('#cmdList').innerHTML = cmdItems.length ? cmdItems.map((x, i) => `<div class="cmd-item ${i === cmdIndex ? 'active' : ''}" data-cmd="${i}"><svg class="ic" viewBox="0 0 24 24"><use href="#${x.icon}"/></svg><div class="cmd-text"><div class="cmd-title">${esc(x.label)}</div><div class="cmd-desc">${esc(x.desc)}</div></div></div>`).join('') : '<div class="cmd-noresult">没有匹配的命令</div>';
  }
  function runCommand(i) {
    const item = cmdItems[i];
    if (!item) return;
    closeCommand();
    item.run();
  }

  /* ------------------------------ 模态框 ------------------------------ */
  let appearanceModalOpen = false;
  function showModal({ title, body, actions = [], onMount, wide = false }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalActions').innerHTML = actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-modal-action="${i}">${esc(a.label)}</button>`).join('');
    $('#modalActions').dataset.actions = 'set';
    $('#modalActions')._actions = actions;
    $('#modalOverlay').querySelector('.modal').classList.toggle('wide', wide);
    $('#modalOverlay').classList.remove('hidden');
    if (onMount) onMount();
  }
  function closeModal() {
    $('#modalOverlay').classList.add('hidden');
    if (appearanceModalOpen) { appearanceModalOpen = false; applyAppearance(lib.settings); }
  }

  function openImportModal() {
    showModal({
      title: '导入剧本',
      body: `<div class="import-options">
          <button class="import-opt" id="importFileOpt"><svg class="ic" viewBox="0 0 24 24"><use href="#i-folder"/></svg>打开本地文件</button>
          <button class="import-opt" id="importPasteOpt"><svg class="ic" viewBox="0 0 24 24"><use href="#i-file"/></svg>粘贴文本</button>
        </div>
        <div class="modal-hint">支持 Fountain、国内剧本格式（角色独占行 + 场次编号）以及本编辑器导出的 .screenplay 工程文件。</div>
        <label class="modal-field"><span>解析格式</span><select id="importFmt"><option value="auto">自动识别</option><option value="fountain">Fountain</option><option value="cn">国内剧本格式</option></select></label>
        <label class="modal-field"><span>剧本文本</span><textarea id="importText" placeholder="第1场　内景·咖啡馆·夜&#10;&#10;雨下个不停。&#10;&#10;林越&#10;　　我们十分钟后打烊。" spellcheck="false"></textarea></label>`,
      actions: [{ label: '取消' }, { label: '解析并导入', primary: true, onClick: () => importFromPaste($('#importText').value, $('#importFmt') ? $('#importFmt').value : 'auto') }],
      onMount: () => {
        $('#importFileOpt').addEventListener('click', importFromFile);
        $('#importPasteOpt').addEventListener('click', () => $('#importText').focus());
      }
    });
  }

  function openShortcuts() {
    const rows = [
      ['Tab / Shift+Tab', '切换元素类型'], ['Enter', '智能续行（对白→角色→动作→新场景）'],
      ['Ctrl + Enter', '新建场景'], ['Shift + Enter', '段内换行'],
      ['Backspace（行首）', '合并 / 删除内容块'], ['Ctrl + D', '复制当前块'],
      ['Ctrl + ↑ / ↓', '上下移动当前块'], ['Ctrl + Z / Shift+Z', '撤销 / 重做'],
      ['Ctrl + K', '命令面板'], ['Ctrl + S', '立即保存'], ['Ctrl + O', '打开文件'],
      ['Ctrl + P', '导出 PDF'], ['F11', '专注模式'], ['Ctrl + = / -', '缩放正文'], ['Esc', '关闭弹层']
    ];
    showModal({ title: '快捷键一览', body: `<div class="kbd-list">${rows.map(([k, v]) => `<div><span>${esc(v)}</span><kbd>${esc(k)}</kbd></div>`).join('')}</div>`, actions: [{ label: '知道了', primary: true, onClick: closeModal }] });
  }

  /* ------------------------------ 工作目录 ------------------------------ */
  async function refreshLocationLabel() {
    try {
      const info = await api.workspace.get();
      const el = $('#statusLocation');
      if (!el || !info) return;
      const name = info.isCustom ? (info.dataDir.split(/[\\/]/).filter(Boolean).pop() || info.dataDir) : '默认位置';
      if (!api.isDesktop) el.textContent = '工作目录：仅桌面版可设置';
      else el.textContent = info.isCustom ? `工作目录：${name}` : '工作目录：默认位置 · 点此设置';
      el.title = `剧本文件夹：${info.scriptsDir || info.libraryPath}\n点击设置工作目录`;
    } catch {}
  }

  async function applyWorkspaceResult(result) {
    if (!result) return;
    if (!result.ok) { toast('切换失败：' + (result.error || '未知错误'), true); return; }
    if (result.library && Array.isArray(result.library.scripts) && result.library.scripts.length) {
      lib = {
        scripts: result.library.scripts.map(normalizeScript),
        activeId: result.library.activeId,
        settings: normalizeSettings(result.library.settings)
      };
      if (!lib.scripts.some(s => s.id === lib.activeId)) lib.activeId = lib.scripts[0].id;
      activeId = blocks()[0].id;
      history = []; future = []; settleHistory();
      applyAppearance(lib.settings);
      renderAll();
    }
    await refreshLocationLabel();
    closeModal();
    toast('工作目录已切换：' + result.dataDir);
  }

  async function openWorkspace() {
    const info = await api.workspace.get().catch(() => null);
    if (!info) { toast('无法读取存储信息', true); return; }
    const browser = !api.isDesktop;
    showModal({
      title: '工作目录与剧本工程文件',
      body: `<div class="modal-hint">每份剧本默认保存为一个独立的 <code>.screenplay</code> 工程文件，位于工作目录的 <code>scripts</code> 子文件夹，编辑时自动保存。<code>library.json</code> 只保存当前剧本、界面设置等少量索引信息。</div>
        <label class="modal-field"><span>工作目录</span><input id="wsDir" type="text" readonly value=""></label>
        <label class="modal-field"><span>剧本文件夹</span><input id="wsScripts" type="text" readonly value=""></label>
        <label class="modal-field"><span>索引文件</span><input id="wsFile" type="text" readonly value=""></label>
        <div class="modal-hint" id="wsMeta"></div>
        <div class="ws-files" id="wsFiles"></div>
        <div class="modal-hint">切换目录时现有剧本会一起写入新目录；若新目录已有剧本，会合并而不会覆盖，原目录文件保留。导出文件的默认位置也跟随工作目录。</div>
        ${browser ? '<div class="modal-hint ws-browser-tip">当前是网页预览：请在项目目录运行 <code>npm start</code> 打开桌面版，才能设置工作目录。</div>' : ''}
        <div class="ws-actions">
          <button class="btn" id="wsChoose" ${browser ? 'disabled' : ''}>更改目录…</button>
          <button class="btn" id="wsReset" ${browser ? 'disabled' : ''}>恢复默认</button>
          <button class="btn" id="wsReveal" ${browser ? 'disabled' : ''}>打开剧本文件夹</button>
        </div>`,
      actions: [{ label: '关闭', primary: true, onClick: closeModal }],
      onMount: () => {
        $('#wsDir').value = info.dataDir;
        $('#wsScripts').value = info.scriptsDir || '';
        $('#wsFile').value = info.libraryPath;
        $('#wsMeta').textContent = `已存 ${info.scriptCount || lib.scripts.length} 份剧本 · ${info.isCustom ? '自定义目录' : '默认目录（文档 / 剧本工坊）'}${browser ? ' · 网页预览模式不支持更改' : ''}`;
        const files = info.scriptFiles || [];
        $('#wsFiles').innerHTML = files.length
          ? `<div class="ws-files-title">工程文件（${files.length}）</div>` + files.map(f => `<div class="ws-file"><span class="ws-file-name">${esc(f.name)}</span><span>${(f.size / 1024).toFixed(1)} KB</span></div>`).join('')
          : '<div class="modal-hint">还没有工程文件，保存剧本后会自动生成。</div>';
        $('#wsChoose').addEventListener('click', async () => {
          await api.saveLibrary(lib);
          applyWorkspaceResult(await api.workspace.choose());
        });
        $('#wsReset').addEventListener('click', async () => {
          await api.saveLibrary(lib);
          applyWorkspaceResult(await api.workspace.reset());
        });
        $('#wsReveal').addEventListener('click', () => api.workspace.reveal());
      }
    });
  }

  /* ------------------------------ AI 助手 ------------------------------ */
  const AI_PRESETS = {
    deepseek: { label: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai:   { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    moonshot: { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu:    { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    qwen:     { label: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ark:      { label: '火山方舟 / 豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
    gemini:   { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
    custom:   { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
  };
  const AI_SYSTEM = '你是一位资深编剧助理，精通中文剧本创作与标准剧本格式（Fountain / 好莱坞剧本排版）。始终使用简体中文。除非明确要求，不要输出解释、标题、Markdown 标记或代码块，只输出结果本身。';
  let aiState = { busy: false, mode: null, text: '' };
  let aiConfig = null;
  let aiStepCount = 0;
  let aiPendingFlash = null;

  function setAiMode(mode) {
    $$('.ai-mode').forEach(b => b.classList.toggle('active', b.dataset.aiMode === mode));
    $('#aiAgentPane').classList.toggle('hidden', mode !== 'agent');
    $('#aiQuickPane').classList.toggle('hidden', mode !== 'quick');
    if (mode === 'quick') updateAiScope();
  }

  function updateEngineTip() {
    const el = $('#aiEngineTip');
    if (!el) return;
    el.textContent = $('#aiEngine').value === 'deepagents'
      ? 'LangChain Deep Agents：目标驱动，系统按任务清单验收；未达标自动接续，端点不兼容自动回退。'
      : '内置工具引擎：兼容所有 OpenAI 兼容端点；系统维护待办清单并验收，目标未达成会持续续跑。';
  }

  function clearAiPlan() {
    const box = $('#aiPlan');
    if (!box) return;
    $('#aiPlanList').replaceChildren();
    $('#aiPlanCount').textContent = '';
    box.classList.remove('verified');
    box.classList.add('hidden');
  }

  function showAiLive() {
    $('#aiLive')?.classList.remove('hidden');
  }

  function clearAiSteps() {
    aiStepCount = 0;
    aiPendingFlash = null;
    aiLiveSteps = [];
    aiLivePlan = [];
    const host = $('#aiSteps');
    if (host) { host.replaceChildren(); host.classList.add('hidden'); }
    clearAiPlan();
    const live = $('#aiLive');
    if (live) {
      live.classList.add('hidden');
      live.classList.remove('collapsed');
      const title = $('#aiLiveTitle');
      if (title) title.textContent = '正在执行…';
    }
  }

  function applyAgentPlan(steps) {
    const box = $('#aiPlan');
    if (!box || !Array.isArray(steps) || !steps.length) return;
    aiLivePlan = steps.map(raw => (typeof raw === 'string'
      ? { title: String(raw), done: false }
      : { title: String(raw?.title || ''), done: Boolean(raw?.done) })).filter(x => x.title).slice(-40);
    showAiLive();
    const list = $('#aiPlanList');
    list.replaceChildren();
    let done = 0;
    for (const raw of steps) {
      const item = typeof raw === 'string' ? { title: raw, done: false } : (raw || {});
      const li = document.createElement('li');
      li.className = item.done ? 'done' : 'pending';
      const mark = document.createElement('span');
      mark.className = 'ai-plan-mark';
      mark.textContent = item.done ? '✓' : '○';
      const text = document.createElement('span');
      text.textContent = String(item.title || '');
      li.append(mark, text);
      if (item.done) done += 1;
      list.appendChild(li);
    }
    const total = steps.length;
    $('#aiPlanCount').textContent = done === total
      ? `${done}/${total} 已完成 · 验收通过`
      : `${done}/${total} 已完成 · 剩余 ${total - done} 项`;
    box.classList.toggle('verified', done === total);
    box.classList.remove('hidden');
  }

  function addAiStep(step) {
    const host = $('#aiSteps');
    if (!host || !step) return;
    host.querySelectorAll('.ai-step.pending').forEach(n => n.remove());
    host.classList.remove('hidden');
    showAiLive();
    aiLiveSteps = aiLiveSteps.filter(x => !x.pending);
    if (!step.pending) aiStepCount += 1;
    aiLiveSteps.push({
      no: aiStepCount, ok: step.ok !== false, pending: Boolean(step.pending),
      summary: String(step.summary || step.name || '工具调用').slice(0, 400)
    });
    if (aiLiveSteps.length > 120) aiLiveSteps.splice(0, aiLiveSteps.length - 120);
    if (step.focusId || typeof step.focus === 'number') aiPendingFlash = step.focusId || step.focus;
    const row = document.createElement('div');
    row.className = 'ai-step' + (step.ok === false ? ' fail' : '') + (step.pending ? ' pending' : '') + (step.name === 'continue' ? ' continue' : '');
    const mark = step.name === 'continue' ? '↻' : (step.ok === false ? '✕' : '✓');
    row.innerHTML = `<span class="ai-step-no">${step.pending ? '··' : String(aiStepCount).padStart(2, '0')}</span><span class="ai-step-mark">${mark}</span><span class="ai-step-text"></span>`;
    row.querySelector('.ai-step-text').textContent = step.summary || step.name || '工具调用';
    host.appendChild(row);
    while (host.children.length > 120) host.removeChild(host.firstElementChild);
    host.scrollTop = host.scrollHeight;
  }

  // 只高亮改动块，不强制滚动：用户正在浏览剧本时不应被 AI 拉走
  function flashAgentBlock(key) {
    if (key === undefined || key === null) return;
    let id = typeof key === 'string' ? key : null;
    if (!id && typeof key === 'number' && blocks()[key]) id = blocks()[key].id;
    if (!id) return;
    const el = document.querySelector(`.block[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.remove('ai-flash');
    void el.offsetWidth;
    el.classList.add('ai-flash');
    setTimeout(() => el.classList.remove('ai-flash'), 1600);
  }

  // 主进程每次工具调用后推送最新剧本文档；重绘时保留滚动位置、焦点与选区
  function applyAgentLibrary(next) {
    if (!next || !Array.isArray(next.scripts) || !next.scripts.length) return;
    clearTimeout(saveTimer);
    const scroller = $('#editorArea');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    const pageY = window.scrollY;
    const active = document.activeElement;
    const focusedId = active && active.classList && active.classList.contains('block-input') ? active.dataset.id : null;
    const selStart = focusedId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const selEnd = focusedId && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;

    lib = next;
    const s = script();
    if (!s.blocks.length) s.blocks = [newBlock('action', '')];
    if (!s.blocks.some(b => b.id === activeId)) activeId = s.blocks[0].id;
    renderAll();
    settleHistory();

    if (scroller) scroller.scrollTop = scrollTop;
    if (pageY) window.scrollTo(0, pageY);
    if (focusedId) {
      const ta = $(`.block-input[data-id="${CSS.escape(focusedId)}"]`);
      if (ta) {
        ta.focus({ preventScroll: true });
        if (selStart !== null && selEnd !== null) {
          try { ta.setSelectionRange(Math.min(selStart, ta.value.length), Math.min(selEnd, ta.value.length)); } catch {}
        }
      }
    }
    const focus = aiPendingFlash;
    aiPendingFlash = null;
    flashAgentBlock(focus);
  }

  function aiTarget() {
    const ta = document.activeElement;
    const selected = ta && ta.classList && ta.classList.contains('block-input')
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : '';
    const block = blocks().find(x => x.id === activeId) || blocks()[0];
    return { block, text: selected || (block ? block.text.trim() : ''), selected: Boolean(selected) };
  }

  function aiContext(limit = 4200) {
    const s = script();
    const lines = [
      `【剧本标题】${s.title}`,
      `【类型】${s.genre || '未设定'}`,
      `【一句话故事】${s.logline || '未设定'}`,
      `【已有角色】${charStats().map(c => c.name).join('、') || '未设定'}`,
      `【场景数】${sceneList().filter(x => !('section' in x)).length}`,
      '', '【当前位置附近正文】'
    ];
    const idx = Math.max(0, blocks().findIndex(b => b.id === activeId));
    const from = Math.max(0, idx - 14), to = Math.min(blocks().length, idx + 8);
    for (let i = from; i < to; i++) {
      const b = blocks()[i];
      if (b.text.trim()) lines.push(`[${TYPES[b.type].label}] ${b.text}`);
    }
    return lines.join('\n').slice(-limit);
  }

  function updateAiResultButtons() {
    const has = Boolean(aiState.text.trim()) && !aiState.busy;
    const isAgent = aiState.mode === 'agent';
    $('#aiReplace').disabled = !has || isAgent || !['expand', 'polish'].includes(aiState.mode);
    $('#aiInsert').disabled = !has || isAgent;
    $('#aiCopy').disabled = !has;
    $('#aiStop').disabled = !aiState.busy;
  }

  function setAiOutput(text, isError, stopped) {
    const out = $('#aiOutput');
    if (!out) return;
    out.classList.toggle('error', Boolean(isError));
    // 当前回复只在生成中 / 出错 / 有内容时显示；归档进会话后隐藏，避免与历史消息重复
    const show = Boolean(text) || Boolean(aiState.busy) || Boolean(isError);
    out.classList.toggle('hidden', !show);
    if (!text) {
      out.innerHTML = `<div class="ai-placeholder">${stopped ? '已停止生成' : (aiState.busy ? '正在生成…' : '')}<br><small>内容会实时出现在这里</small></div>`;
    } else {
      out.textContent = text;
    }
    updateAiResultButtons();
    scrollAiMessages(true);
  }

  function setAiBusy(busy) {
    $$('.ai-action').forEach(b => { b.disabled = busy; });
    $$('.ai-chip').forEach(b => { b.disabled = busy; });
    $('#aiAgentRun').disabled = busy;
    $('#aiAgentResume').disabled = busy || !aiHasSession;
    $('#aiSessionNew').disabled = busy;
    $('#aiSessionsToggle').disabled = busy;
    $('#aiAgentClear').disabled = busy;
    $('#aiOutput').classList.toggle('busy', busy);
    document.body.classList.toggle('ai-editing', busy);
    $$('.block-input').forEach(ta => { ta.readOnly = busy; });
    $$('.block-ai-btn').forEach(b => { b.disabled = busy; });
    $('#addBlockBtn').disabled = busy;
    $('#addSceneBtn').disabled = busy;
    $('#statusHint').textContent = busy ? 'AI 正在编辑 · 剧本暂时只读，可自由浏览' : '就绪';
    const title = $('#aiLiveTitle');
    if (title) title.textContent = busy ? '正在执行 · 实时过程' : '本次执行过程';
    $('#aiLive')?.classList.toggle('running', busy);
    updateAiResultButtons();
  }

  function updateAiScope() {
    const el = $('#aiScope');
    if (!el) return;
    const t = aiTarget();
    el.textContent = `作用于 ${t.selected ? `选中文本（${t.text.length} 字）` : `当前块：${t.block ? TYPES[t.block.type].label : '—'}`} · 自动带入前后剧情`;
  }

  async function refreshAiStatus() {
    const cfg = await api.ai.getConfig().catch(() => null);
    aiConfig = cfg;
    const label = $('#aiModelLabel');
    if (!label) return;
    if (!cfg) {
      label.textContent = 'AI 仅桌面版可用';
      $('#aiDot').classList.remove('on');
      return;
    }
    label.textContent = cfg.hasKey ? `${cfg.model || '未设置模型'} · 已配置` : '未配置模型';
    $('#aiDot').classList.toggle('on', Boolean(cfg.hasKey));
  }

  async function saveAiConfigFromForm(silent) {
    const payload = {
      provider: $('#aiProvider').value,
      baseUrl: $('#aiBaseUrl').value,
      model: $('#aiModel').value,
      apiKey: $('#aiKey').value,
      temperature: Number($('#aiTemp').value),
      maxTokens: Number($('#aiMaxTokens').value)
    };
    const r = await api.ai.saveConfig(payload).catch(e => ({ ok: false, error: String(e) }));
    if (!r.ok) { toast('保存失败：' + (r.error || ''), true); return false; }
    aiConfig = r.config;
    await refreshAiStatus();
    if (!silent) toast('模型配置已保存');
    return true;
  }

  async function openAiConfig() {
    const cfg = await api.ai.getConfig().catch(() => null);
    if (!cfg) {
      showAiPanel();
      setAiOutput('AI 能力仅在桌面版可用。请在项目目录运行 npm start 打开桌面应用后配置模型。', true);
      toast('AI 能力仅在桌面版可用', true);
      return;
    }
    aiConfig = cfg;
    const options = Object.entries(AI_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    showModal({
      title: '大模型配置',
      body: `<div class="ai-preset-hint">支持所有 OpenAI 兼容接口（DeepSeek / Kimi / 智谱 / 通义 / 豆包 / Gemini / OpenAI 及自建代理）。API Key 经系统加密保存在本机，只发送给你选择的服务商。豆包需填写模型 ID 或 Endpoint ID。</div>
        <label class="modal-field"><span>服务商</span><select id="aiProvider">${options}</select></label>
        <label class="modal-field"><span>接口地址 Base URL</span><input id="aiBaseUrl" type="text" spellcheck="false" placeholder="https://api.example.com/v1"></label>
        <label class="modal-field"><span>模型名称 / ID</span><input id="aiModel" type="text" spellcheck="false" placeholder="例如 deepseek-chat"></label>
        <label class="modal-field"><span>API Key ${cfg.hasKey ? `（当前 ${esc(cfg.maskedKey)}，留空保持不变）` : ''}</span><input id="aiKey" type="password" placeholder="sk-..." autocomplete="off"></label>
        <label class="modal-field"><span>创造性 temperature</span><div class="ai-range"><input id="aiTemp" type="range" min="0" max="1.5" step="0.1"><output id="aiTempOut"></output></div></label>
        <label class="modal-field"><span>单次最大输出 Token</span><input id="aiMaxTokens" type="number" min="256" max="16384" step="256"></label>
        <div class="ai-test-result" id="aiTestResult"></div>`,
      actions: [
        { label: '测试连接', onClick: async () => {
          if (!(await saveAiConfigFromForm(true))) return;
          const el = $('#aiTestResult');
          if (!el) return;
          el.className = 'ai-test-result';
          el.textContent = '正在测试连接…';
          const t = await api.ai.test().catch(e => ({ ok: false, error: String(e) }));
          el.className = 'ai-test-result ' + (t.ok ? 'ok' : 'err');
          el.textContent = t.ok ? `连接成功，模型回复：${t.reply}` : `连接失败：${t.error}`;
        } },
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => { if (await saveAiConfigFromForm(false)) closeModal(); } }
      ],
      onMount: () => {
        $('#aiProvider').value = cfg.provider in AI_PRESETS ? cfg.provider : 'custom';
        $('#aiBaseUrl').value = cfg.baseUrl || '';
        $('#aiModel').value = cfg.model || '';
        $('#aiTemp').value = cfg.temperature;
        $('#aiTempOut').textContent = cfg.temperature;
        $('#aiMaxTokens').value = cfg.maxTokens;
        $('#aiTemp').addEventListener('input', e => { $('#aiTempOut').textContent = e.target.value; });
        $('#aiProvider').addEventListener('change', e => {
          const p = AI_PRESETS[e.target.value];
          if (!p) return;
          if (p.baseUrl) $('#aiBaseUrl').value = p.baseUrl;
          if (p.model) $('#aiModel').value = p.model;
        });
      }
    });
  }

  async function aiRun(mode, messages, opts = {}) {
    showAiPanel();
    if (aiState.busy) { toast('正在生成中，请先停止', true); return null; }
    if (!aiConfig || !aiConfig.hasKey) {
      openAiConfig();
      toast('请先配置模型与 API Key', true);
      return null;
    }
    aiState = { busy: true, mode, text: '' };
    appendAiMessage({ role: 'user', mode, text: opts.label || '快捷能力' });
    setAiBusy(true);
    setAiOutput('', false);
    const res = await api.ai.run({ messages, temperature: opts.temperature, maxTokens: opts.maxTokens, attachments: opts.attachments })
      .catch(e => ({ ok: false, error: String(e) }));
    aiState.busy = false;
    setAiBusy(false);
    if (!res || !res.ok) {
      const err = '生成失败：' + ((res && res.error) || '未知错误');
      appendAiMessage({ role: 'assistant', mode, text: err, error: true });
      setAiOutput('', false);
      persistAiSessions(true);
      return null;
    }
    aiState.text = res.text || '';
    const text = aiState.text || (res.stopped ? '' : '（模型未返回内容）');
    if (text.trim()) appendAiMessage({ role: 'assistant', mode, text });
    setAiOutput('', false);
    persistAiSessions(true);
    if (res.stopped) toast('已停止生成');
    return aiState.text;
  }

  async function aiHint() {
    updateAiScope();
    const t = aiTarget();
    const messages = [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: `${aiContext()}\n\n【当前内容块】${t.block ? TYPES[t.block.type].label : ''}：${t.text || '（空）'}\n\n请作为剧本医生给出 4 条具体、可执行的建议，覆盖：①这场戏下一步如何推进；②冲突与悬念是否足够；③对白是否贴合人物；④画面与动作能否更可视化。每条用「1.」「2.」开头，不要复述原文，不要输出解释或代码块。` }
    ];
    await aiRun('hint', messages, { temperature: 0.7, maxTokens: 1024, label: '智能提示 · 给当前剧情 4 条具体建议' });
  }

  async function aiExpand() {
    const t = aiTarget();
    if (!t.text) { toast('当前块是空的，请先写一句描述', true); return; }
    updateAiScope();
    const messages = [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: `${aiContext()}\n\n【需要扩写的内容块】类型：${TYPES[t.block.type].label}\n原文：${t.text}\n\n请扩写成更具体、更有画面感的剧本正文：补充可见的动作、细节、声音与节奏，保持现在时态、简明克制。不要新增人物对白、场景标题，不要解释，只输出扩写后的正文。` }
    ];
    await aiRun('expand', messages, { temperature: 0.8, maxTokens: 900, label: `智能扩写 · ${t.text.slice(0, 32)}${t.text.length > 32 ? '…' : ''}` });
  }

  async function aiPolish() {
    const t = aiTarget();
    if (!t.text) { toast('当前块是空的，没有可润色的内容', true); return; }
    updateAiScope();
    const messages = [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: `${aiContext()}\n\n【需要润色的内容块】类型：${TYPES[t.block.type].label}\n原文：${t.text}\n\n在保持原意、人物语气与剧本格式的前提下润色：删除冗余、让句子更有力、对白更自然、动作更可视化。不要改变剧情事实，不要新增台词，不要输出解释或引号，只输出润色后的正文。` }
    ];
    await aiRun('polish', messages, { temperature: 0.6, maxTokens: 900, label: `智能润色 · ${t.text.slice(0, 32)}${t.text.length > 32 ? '…' : ''}` });
  }

  function openAiWrite() {
    showModal({
      title: '自动写剧本',
      body: `<div class="ai-preset-hint">根据设定生成一份完整 Fountain 剧本，并作为新的剧本文档打开。原剧本不会被修改。</div>
        <label class="modal-field"><span>剧本标题（可留空）</span><input id="aiWTitle" type="text" placeholder="留空则用故事概括命名"></label>
        <label class="modal-field"><span>一句话故事 *</span><textarea id="aiWIdea" rows="2" placeholder="例如：一个深夜便利店里，两个陌生人用一杯热水交换了不肯说出口的告别"></textarea></label>
        <label class="modal-field"><span>类型 / 风格</span><input id="aiWGenre" type="text" placeholder="剧情 / 悬疑 / 喜剧…"></label>
        <label class="modal-field"><span>主要角色（逗号分隔，可留空）</span><input id="aiWChars" type="text" placeholder="林越、女孩"></label>
        <label class="modal-field"><span>场景数量</span><input id="aiWScenes" type="number" min="1" max="12" value="4"></label>
        <label class="modal-field"><span>额外要求</span><input id="aiWExtra" type="text" placeholder="例如：结尾留一个反转、对白克制"></label>`,
      actions: [
        { label: '取消' },
        { label: '开始生成', primary: true, onClick: () => {
          const idea = $('#aiWIdea').value.trim();
          if (!idea) { toast('请填写一句话故事', true); return; }
          const opts = {
            title: $('#aiWTitle').value.trim(),
            idea,
            genre: $('#aiWGenre').value.trim(),
            characters: $('#aiWChars').value.trim(),
            scenes: clamp(Number($('#aiWScenes').value) || 4, 1, 12),
            extra: $('#aiWExtra').value.trim()
          };
          closeModal();
          aiWriteScript(opts);
        } }
      ]
    });
  }

  async function aiWriteScript(opts) {
    showAiPanel();
    setAiMode('quick');
    const messages = [
      { role: 'system', content: AI_SYSTEM + ' 你输出的剧本必须是标准 Fountain 纯文本。' },
      { role: 'user', content: `请创作一个完整的中文短片剧本。
标题：${opts.title || '未命名剧本'}
一句话故事：${opts.idea}
类型 / 风格：${opts.genre || '剧情'}
主要角色：${opts.characters || '自行设计 2-3 个角色'}
场景数量：约 ${opts.scenes} 场
额外要求：${opts.extra || '无'}

严格按 Fountain 语法输出，不要输出任何解释、标题行、Markdown 或代码块：
- 场景标题独占一行，形如「INT. 地点 - 日」「EXT. 地点 - 夜」
- 动作描述独占一行，段落之间空一行
- 角色名独占一行（全大写或简短中文名），前后空一行
- 对白紧跟角色名下一行
- 括号提示形如（低声），独占一行
- 转场形如 CUT TO: / FADE OUT.，独占一行
- 每场戏都要有可视化的动作与有冲突的对白，结尾要有收束` }
    ];
    const text = await aiRun('write', messages, { temperature: 0.85, maxTokens: 4096, label: `自动写剧本 · ${opts.idea.slice(0, 40)}${opts.idea.length > 40 ? '…' : ''}` });
    if (!text) return;
    const parsed = parseFountain(text);
    if (parsed.blocks.length < 3) { toast('生成内容不足以构成剧本，请重试', true); return; }
    addImportedScript(opts.title || opts.idea.slice(0, 14), parsed.blocks,
      { author: '', genre: opts.genre, logline: opts.idea });
    toast(`已生成新剧本：${parsed.blocks.length} 个内容块`);
  }

  function openNovelToScript() {
    let novelAttachments = [];
    showModal({
      title: '小说生成剧本',
      wide: true,
      body: `<div class="ai-preset-hint">把一段小说 / 散文改写成标准 Fountain 剧本，作为新的剧本文档打开（原剧本不会被修改）。可粘贴正文，或引用本地文件由 AI 自行读取。</div>
        <div class="novel-upload" id="novelUpload">
          <button type="button" class="novel-upload-btn" id="novelFileBtn"><svg class="ic" viewBox="0 0 24 24"><use href="#i-folder"/></svg>引用文件（Markdown / TXT）</button>
          <span class="novel-upload-hint">点击选择本地文件作为参考，生成时由 AI 自行读取，不会在这里读取或截断</span>
          <div class="novel-files hidden" id="novelFiles"></div>
        </div>
        <label class="modal-field"><span>小说 / 散文正文（可留空，仅引用文件时）</span><textarea id="aiNText" rows="10" placeholder="在此粘贴小说片段或整章…"></textarea></label>
        <label class="modal-field"><span>剧本标题（可留空）</span><input id="aiNTitle" type="text" placeholder="留空则用正文前几个字命名"></label>
        <label class="modal-field"><span>类型 / 风格</span><input id="aiNGenre" type="text" placeholder="剧情 / 悬疑 / 喜剧…"></label>
        <label class="modal-field"><span>额外要求</span><input id="aiNExtra" type="text" placeholder="例如：对白克制、保留原结局、拆成 3 场"></label>`,
      actions: [
        { label: '取消' },
        { label: '开始生成', primary: true, onClick: () => {
          const text = $('#aiNText').value.trim();
          if (!text && !novelAttachments.length) { toast('请粘贴小说或引用文件', true); return; }
          if (text.length > 12000) { toast('正文过长，请控制在 12000 字以内', true); return; }
          const opts = {
            text,
            title: $('#aiNTitle').value.trim(),
            genre: $('#aiNGenre').value.trim(),
            extra: $('#aiNExtra').value.trim(),
            attachments: novelAttachments
          };
          closeModal();
          aiNovelToScript(opts);
        } }
      ],
      onMount: () => {
        const filesBox = $('#novelFiles');
        const render = () => {
          if (!novelAttachments.length) { filesBox.classList.add('hidden'); filesBox.innerHTML = ''; return; }
          filesBox.classList.remove('hidden');
          filesBox.innerHTML = novelAttachments.map((a, i) =>
            `<span class="file-chip" data-nv-att="${i}">${esc(a.name)}<button type="button" class="file-chip-x" title="移除">×</button></span>`
          ).join('');
        };
        $('#novelFileBtn').addEventListener('click', async () => {
          const list = await pickRefFiles();
          if (list && list.length) { novelAttachments = novelAttachments.concat(list); render(); toast(`已引用 ${list.length} 个文件`); }
        });
        filesBox.addEventListener('click', (e) => {
          const x = e.target.closest('[data-nv-att]');
          if (x) { novelAttachments.splice(Number(x.dataset.nvAtt), 1); render(); }
        });
      }
    });
  }

  async function aiNovelToScript(opts) {
    showAiPanel();
    setAiMode('quick');
    const messages = [
      { role: 'system', content: AI_SYSTEM + ' 你输出的剧本必须是标准 Fountain 纯文本。' },
      { role: 'user', content: `请把下面这段小说 / 散文改写成标准 Fountain 剧本。
类型 / 风格：${opts.genre || '剧情'}
额外要求：${opts.extra || '无'}

改写规则：
- 把叙事性散文转化为剧本格式：环境与时空调度写成「INT./EXT. 地点 - 时间」场景标题；可见的动作与神态写成动作描述；角色说的话写成对白（角色名全大写独占一行，对白紧随其后）；低声、动作提示用（括号）另起一行。
- 不要新增原文没有的重要情节或人物，保持故事原意、语气与结局。
- 若原文没有对白，可依据情境为关键角色补少量贴合性格的台词，但不要过度发挥。
- 严格按 Fountain 语法输出，不要输出任何解释、标题行、Markdown 或代码块。

【小说 / 散文正文】
${opts.text || '（请基于本次附加的参考文件进行改写）'}` }
    ];
    const text = await aiRun('novel', messages, { temperature: 0.5, maxTokens: 4096, attachments: opts.attachments, label: `小说生成剧本 · ${(opts.text || '参考文件').slice(0, 40)}${(opts.text || '参考文件').length > 40 ? '…' : ''}` });
    if (!text) return;
    const parsed = parseFountain(text);
    if (parsed.blocks.length < 3) { toast('生成内容不足以构成剧本，请重试', true); return; }
    addImportedScript(opts.title || opts.text.slice(0, 14), parsed.blocks, { author: '', genre: opts.genre, logline: '' });
    toast(`已生成新剧本：${parsed.blocks.length} 个内容块`);
  }

  function aiApplyResult(kind, sourceText) {
    const value = String(sourceText !== undefined ? sourceText : (aiState.text || '')).trim();
    if (!value) return;
    const t = aiTarget();
    if (kind === 'copy') {
      const tmp = document.createElement('textarea');
      tmp.value = value;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板'); }
      catch { toast('复制失败', true); }
      tmp.remove();
      return;
    }
    if (kind === 'replace') {
      if (!t.block) return;
      beginChange();
      t.block.text = t.selected ? t.block.text.replace(t.text, value) : value;
      changed(true);
      focusBlock(t.block.id);
      toast('已替换当前块');
      return;
    }
    if (kind === 'insert') {
      const type = aiState.mode === 'hint' ? 'note' : (t.block ? t.block.type : 'action');
      insertBlock(t.block ? t.block.id : null, type, value);
      toast('已插入为新内容块');
    }
  }

  /* --------------------- AI 会话：持久化 / 消息流 / 续跑 --------------------- */
  let aiHasSession = false;
  let aiStore = { version: 1, activeId: '', sessions: [] };
  let aiSessionReady = false;
  let aiSessionSaveTimer = null;
  let aiLiveSteps = [];
  let aiLivePlan = [];
  let aiLiveInstruction = '';

  const aiSession = () => aiStore.sessions.find(s => s.id === aiStore.activeId) || null;
  const aiShort = (v, n) => String(v ?? '').slice(0, n);
  const aiPlanItems = (raw) => (Array.isArray(raw) ? raw : []).slice(-40)
    .map(p => (typeof p === 'string' ? { title: String(p), done: false }
      : { title: String(p?.title || ''), done: Boolean(p?.done) })).filter(p => p.title);
  const aiStepItems = (raw) => (Array.isArray(raw) ? raw : []).slice(-120)
    .map(s => (typeof s === 'string' ? { no: 0, ok: true, summary: String(s) }
      : { no: Number(s?.no) || 0, ok: s?.ok !== false, summary: String(s?.summary || '') })).filter(s => s.summary);

  function normalizeAiStore(raw) {
    const out = { version: 1, activeId: '', sessions: [] };
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return out;
    out.sessions = raw.sessions.slice(-60).filter(s => s && typeof s === 'object').map(s => ({
      id: aiShort(s.id, 40) || uid(),
      title: aiShort(s.title, 80) || '新会话',
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
      scriptId: aiShort(s.scriptId, 40),
      scriptTitle: aiShort(s.scriptTitle, 80),
      engine: aiShort(s.engine, 24) || 'builtin',
      messages: (Array.isArray(s.messages) ? s.messages : []).slice(-160)
        .filter(m => m && typeof m === 'object').map(m => {
          const type = m.type === 'run' ? 'run' : 'text';
          return {
            id: aiShort(m.id, 40) || uid(),
            role: m.role === 'user' ? 'user' : 'assistant',
            type, text: aiShort(m.text, type === 'text' ? 20000 : 4000),
            at: Number(m.at) || Date.now(),
            mode: aiShort(m.mode, 24), engine: aiShort(m.engine, 24),
            error: Boolean(m.error), verified: Boolean(m.verified),
            steps: aiStepItems(m.steps), plan: aiPlanItems(m.plan)
          };
        }),
      prior: s.prior && typeof s.prior === 'object' ? {
        instruction: aiShort(s.prior.instruction, 4000),
        plan: aiPlanItems(s.prior.plan),
        steps: (Array.isArray(s.prior.steps) ? s.prior.steps : []).slice(-120)
          .map(x => aiShort(typeof x === 'string' ? x : x?.summary, 400)).filter(Boolean),
        toolCalls: Number(s.prior.toolCalls) || 0,
        editCount: Number(s.prior.editCount) || 0,
        verified: Boolean(s.prior.verified),
        engine: s.prior.engine === 'deepagents' ? 'deepagents' : 'builtin'
      } : null
    }));
    const last = out.sessions[out.sessions.length - 1];
    out.activeId = out.sessions.some(s => s.id === raw.activeId) ? raw.activeId : (last ? last.id : '');
    return out;
  }

  function makeAiSession(title) {
    const now = Date.now();
    return {
      id: uid(), title: title || '新会话', createdAt: now, updatedAt: now,
      scriptId: script()?.id || '', scriptTitle: script()?.title || '',
      engine: $('#aiEngine')?.value || 'builtin', messages: [], prior: null
    };
  }

  function persistAiSessions(immediate = false) {
    if (!aiSessionReady) return;
    clearTimeout(aiSessionSaveTimer);
    const flush = () => {
      try { Promise.resolve(api.ai.sessions.save(JSON.parse(JSON.stringify(aiStore)))).catch(() => {}); }
      catch {}
    };
    if (immediate) flush(); else aiSessionSaveTimer = setTimeout(flush, 260);
  }

  async function loadAiSessions() {
    let raw = null;
    try { raw = await api.ai.sessions.load(); } catch {}
    aiStore = normalizeAiStore(raw);
    if (!aiSession()) {
      const s = makeAiSession();
      aiStore.sessions.push(s);
      aiStore.activeId = s.id;
    }
    aiSessionReady = true;
    aiHasSession = Boolean(aiSession().prior);
    $('#aiAgentResume').disabled = !aiHasSession;
    renderAiSessions();
    renderAiMessages();
    resetAiLive();
    updateAiResultButtons();
    persistAiSessions(true);
  }

  function formatAiTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }

  function scrollAiMessages(force = false) {
    const host = $('#aiMessages');
    if (!host) return;
    if (force || host.scrollHeight - host.scrollTop - host.clientHeight < 90) host.scrollTop = host.scrollHeight;
  }

  function renderAiSessions() {
    const cur = aiSession();
    $('#aiSessionTitle').textContent = cur ? cur.title : '新会话';
    $('#aiSessionCount').textContent = String(aiStore.sessions.length);
    const q = ($('#aiSessionSearch').value || '').trim().toLowerCase();
    const list = $('#aiSessionList');
    list.replaceChildren();
    aiStore.sessions.slice().reverse().forEach(s => {
      const hay = (s.title + ' ' + s.messages.map(m => m.text).join(' ')).toLowerCase();
      if (q && !hay.includes(q)) return;
      const row = document.createElement('div');
      row.className = 'ai-session-item' + (s.id === aiStore.activeId ? ' active' : '');
      row.dataset.id = s.id;
      row.innerHTML = `<div class="ai-session-item-main"><div class="ai-session-item-title"></div><div class="ai-session-item-meta"></div></div>
        <button class="ai-session-item-btn" data-action="rename" title="重命名"><svg class="ic" viewBox="0 0 24 24"><use href="#i-edit"/></svg></button>
        <button class="ai-session-item-btn" data-action="delete" title="删除"><svg class="ic" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>`;
      row.querySelector('.ai-session-item-title').textContent = s.title;
      row.querySelector('.ai-session-item-meta').textContent =
        `${s.messages.length} 条 · ${formatAiTime(s.updatedAt)}${s.scriptTitle ? ' · ' + s.scriptTitle : ''}${s.prior ? ' · 可续跑' : ''}`;
      list.appendChild(row);
    });
    if (!list.children.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-session-empty';
      empty.textContent = q ? '没有匹配的会话' : '还没有会话';
      list.appendChild(empty);
    }
  }

  function buildAiMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + (m.type === 'run' ? 'run' : m.role);
    wrap.dataset.id = m.id;
    if (m.type === 'run') {
      const plan = m.plan || [];
      const done = plan.filter(p => p.done).length;
      const head = document.createElement('button');
      head.className = 'ai-run-head';
      head.dataset.aiToggle = '1';
      head.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-chevron"/></svg><span class="ai-run-label">执行过程</span><span class="ai-run-count"></span><span class="ai-msg-time"></span>';
      head.querySelector('.ai-run-count').textContent = `${(m.steps || []).length} 步${plan.length ? ` · 清单 ${done}/${plan.length}` : ''}${m.verified ? ' · 已验收' : ''}`;
      head.querySelector('.ai-msg-time').textContent = formatAiTime(m.at);
      const body = document.createElement('div');
      body.className = 'ai-run-body hidden';
      if (plan.length) {
        const planBox = document.createElement('div');
        planBox.className = 'ai-run-plan';
        for (const p of plan) {
          const row = document.createElement('div');
          row.className = 'ai-run-plan-item' + (p.done ? ' done' : '');
          row.textContent = (p.done ? '✓ ' : '○ ') + p.title;
          planBox.appendChild(row);
        }
        body.appendChild(planBox);
      }
      const ol = document.createElement('ol');
      ol.className = 'ai-run-steps';
      for (const s of m.steps || []) {
        const li = document.createElement('li');
        if (!s.ok) li.className = 'fail';
        li.textContent = s.summary;
        ol.appendChild(li);
      }
      body.appendChild(ol);
      wrap.append(head, body);
      return wrap;
    }
    const avatar = document.createElement('div');
    avatar.className = 'ai-msg-avatar';
    avatar.textContent = m.role === 'user' ? '你' : 'AI';
    const main = document.createElement('div');
    main.className = 'ai-msg-main';
    const meta = document.createElement('div');
    meta.className = 'ai-msg-meta';
    const who = document.createElement('span');
    who.textContent = m.role === 'user' ? '你' : 'AI 助手';
    const time = document.createElement('span');
    time.className = 'ai-msg-time';
    time.textContent = formatAiTime(m.at);
    meta.append(who, time);
    if (m.mode) {
      const tag = document.createElement('span');
      tag.className = 'ai-msg-tag';
      tag.textContent = ({ agent: '智能体', hint: '智能提示', expand: '智能扩写', polish: '智能润色', write: '自动写剧本' })[m.mode] || m.mode;
      meta.appendChild(tag);
    }
    const body = document.createElement('div');
    body.className = 'ai-msg-body' + (m.error ? ' error' : '');
    body.textContent = m.text || '（空）';
    main.append(meta, body);
    if (m.role === 'assistant' && m.text) {
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      for (const [act, label] of [['copy', '复制'], ['replace', '替换当前块'], ['insert', '插入为新块']]) {
        const b = document.createElement('button');
        b.className = 'ai-msg-action';
        b.dataset.msgAction = act;
        b.textContent = label;
        actions.appendChild(b);
      }
      main.appendChild(actions);
    }
    wrap.append(avatar, main);
    return wrap;
  }

  function renderAiMessages() {
    const host = $('#aiMessages');
    host.querySelectorAll('.ai-msg').forEach(n => n.remove());
    const s = aiSession();
    const msgs = s ? s.messages : [];
    $('#aiWelcome').classList.toggle('hidden', msgs.length > 0);
    const frag = document.createDocumentFragment();
    for (const m of msgs) frag.appendChild(buildAiMessage(m));
    host.insertBefore(frag, $('#aiOutput'));
    scrollAiMessages(true);
  }

  function appendAiMessage(raw) {
    const s = aiSession();
    if (!s) return null;
    const m = {
      id: uid(), at: Date.now(),
      role: raw.role === 'user' ? 'user' : 'assistant',
      type: raw.type === 'run' ? 'run' : 'text',
      text: aiShort(raw.text, raw.type === 'run' ? 4000 : 20000),
      mode: aiShort(raw.mode, 24), engine: aiShort(raw.engine, 24),
      error: Boolean(raw.error), verified: Boolean(raw.verified),
      steps: aiStepItems(raw.steps), plan: aiPlanItems(raw.plan)
    };
    s.messages.push(m);
    if (s.messages.length > 160) s.messages.splice(0, s.messages.length - 160);
    s.updatedAt = Date.now();
    if (m.role === 'user' && m.type === 'text' && s.title === '新会话') {
      s.title = m.text.replace(/\s+/g, ' ').slice(0, 24) || '新会话';
    }
    $('#aiMessages').insertBefore(buildAiMessage(m), $('#aiOutput'));
    $('#aiWelcome').classList.add('hidden');
    scrollAiMessages();
    renderAiSessions();
    persistAiSessions();
    return m;
  }

  function resetAiLive() {
    aiLiveInstruction = '';
    clearAiSteps();
    setAiOutput('', false);
  }

  function archiveAiRun(opts = {}) {
    const steps = aiLiveSteps.filter(s => !s.pending).map(s => ({ no: s.no, ok: s.ok, summary: s.summary }));
    const plan = aiPlanItems(aiLivePlan);
    if (steps.length || plan.length) {
      appendAiMessage({ role: 'assistant', type: 'run', text: '执行过程', steps, plan, verified: opts.verified, mode: 'agent' });
    }
    if (opts.text && String(opts.text).trim()) {
      appendAiMessage({ role: 'assistant', type: 'text', mode: 'agent', text: String(opts.text), error: Boolean(opts.error) });
    }
    setAiOutput('', false);
    $('#aiLive')?.classList.add('hidden');
  }

  function openAiSession(id) {
    aiStore.activeId = id;
    const s = aiSession();
    aiHasSession = Boolean(s?.prior);
    aiState = { busy: false, mode: null, text: '' };
    $('#aiAgentInput').value = '';
    if (s?.engine) $('#aiEngine').value = s.engine === 'deepagents' ? 'deepagents' : 'builtin';
    updateEngineTip();
    $('#aiSessionDrawer').classList.add('hidden');
    renderAiSessions();
    renderAiMessages();
    resetAiLive();
    $('#aiAgentResume').disabled = !aiHasSession;
    updateAiResultButtons();
    persistAiSessions(true);
  }

  function switchAiSession(id) {
    if (id === aiStore.activeId) { $('#aiSessionDrawer').classList.add('hidden'); return; }
    if (aiState.busy) { toast('AI 正在执行，完成后再切换会话', true); return; }
    persistAiSessions(true);
    openAiSession(id);
  }

  function createAiSession() {
    if (aiState.busy) { toast('AI 正在执行，完成后再新建会话', true); return; }
    const cur = aiSession();
    if (cur && !cur.messages.length && !cur.prior) { toast('已在一个空会话中'); return; }
    persistAiSessions(true);
    const s = makeAiSession();
    aiStore.sessions.push(s);
    if (aiStore.sessions.length > 60) aiStore.sessions.splice(0, aiStore.sessions.length - 60);
    openAiSession(s.id);
    $('#aiAgentInput').focus();
    toast('已新建会话');
  }

  function renameAiSession(id) {
    const s = aiStore.sessions.find(x => x.id === id);
    if (!s) return;
    showModal({
      title: '重命名会话',
      body: '<label class="modal-field"><span>会话名称</span><input id="aiRenameInput" type="text" maxlength="60" spellcheck="false"></label>',
      actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: () => {
          const v = $('#aiRenameInput').value.trim();
          if (v) { s.title = v.slice(0, 60); s.updatedAt = Date.now(); renderAiSessions(); persistAiSessions(true); }
          closeModal();
        } }
      ],
      onMount: () => { $('#aiRenameInput').value = s.title; $('#aiRenameInput').focus(); $('#aiRenameInput').select(); }
    });
  }

  function deleteAiSession(id) {
    if (aiStore.sessions.length <= 1) { toast('至少保留一个会话，可用「清空会话」', true); return; }
    if (id === aiStore.activeId && aiState.busy) { toast('AI 正在执行，完成后再删除会话', true); return; }
    const s = aiStore.sessions.find(x => x.id === id);
    if (!s) return;
    showModal({
      title: '删除会话',
      body: `<div class="modal-hint">将删除「${esc(s.title)}」的全部消息与续跑进度，此操作不可恢复。</div>`,
      actions: [
        { label: '取消' },
        { label: '删除', danger: true, onClick: () => {
          aiStore.sessions = aiStore.sessions.filter(x => x.id !== id);
          if (id === aiStore.activeId) openAiSession(aiStore.sessions[aiStore.sessions.length - 1].id);
          else { renderAiSessions(); persistAiSessions(true); }
          closeModal();
          toast('会话已删除');
        } }
      ]
    });
  }

  function clearAiSession() {
    const s = aiSession();
    if (!s) return;
    if (!s.messages.length && !s.prior) { toast('当前会话已经是空的'); return; }
    showModal({
      title: '清空当前会话',
      body: '<div class="modal-hint">将清空该会话的全部消息、执行记录与续跑进度，会话本身会保留。</div>',
      actions: [
        { label: '取消' },
        { label: '清空', danger: true, onClick: () => {
          s.messages = []; s.prior = null; s.title = '新会话'; s.updatedAt = Date.now();
          aiHasSession = false;
          aiState = { busy: false, mode: null, text: '' };
          $('#aiAgentInput').value = '';
          $('#aiAgentResume').disabled = true;
          renderAiMessages(); renderAiSessions(); resetAiLive(); updateAiResultButtons();
          persistAiSessions(true);
          closeModal();
          toast('会话已清空');
        } }
      ]
    });
  }

  let aiAttachments = [];
  async function pickRefFiles() {
    if (api.ai && typeof api.ai.pickFiles === 'function') {
      try { const list = await api.ai.pickFiles(); return Array.isArray(list) ? list : []; } catch { return []; }
    }
    // 非桌面环境（网页预览）：用隐藏 input 读取，便于演示；桌面端走上面的真实路径对话框
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt,.fountain,.spmd,.json,.csv,text/plain,text/markdown';
      input.multiple = true;
      input.addEventListener('change', async () => {
        const out = [];
        for (const f of [...input.files]) { try { out.push({ name: f.name, path: 'web://' + f.name, content: await f.text() }); } catch {} }
        resolve(out);
      });
      input.click();
    });
  }
  function renderAiAttachments() {
    const box = $('#aiAttachments');
    if (!box) return;
    if (!aiAttachments.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = aiAttachments.map((a, i) =>
      `<span class="file-chip" data-ai-att="${i}">${esc(a.name)}<button type="button" class="file-chip-x" title="移除">×</button></span>`
    ).join('');
  }

  async function aiAgentRun(resume = false) {
    showAiPanel();
    setAiMode('agent');
    if (aiState.busy) { toast('正在执行中，请先停止', true); return; }
    if (!aiConfig || !aiConfig.hasKey) { openAiConfig(); toast('请先配置模型与 API Key', true); return; }
    const session = aiSession();
    if (!session) return;
    // 续跑状态来自当前会话，而不是主进程内存：程序重启后依然能接着做
    const prior = resume ? session.prior : null;
    const instruction = $('#aiAgentInput').value.trim();
    if (!instruction && !resume) { toast('请先输入要执行的编辑指令', true); $('#aiAgentInput').focus(); return; }
    if (resume && !prior && !instruction) { toast('当前会话还没有可继续的任务', true); return; }
    const engine = $('#aiEngine').value;
    if (resume && prior && session.scriptId && lib.activeId !== session.scriptId) {
      toast(`该会话关联「${session.scriptTitle || '另一份剧本'}」，续跑会作用于当前打开的剧本`);
    }
    session.engine = engine;
    session.scriptId = lib.activeId;
    session.scriptTitle = script()?.title || '';
    aiLiveInstruction = instruction || prior?.instruction || '';
    const sendAttachments = resume ? [] : aiAttachments.slice();
    aiAttachments = []; renderAiAttachments();
    aiState = { busy: true, mode: 'agent', text: '' };
    appendAiMessage({ role: 'user', mode: 'agent', engine, text: (resume ? '继续任务：' : '') + aiLiveInstruction });
    $('#aiAgentInput').value = '';
    resetAiLive();
    commitHistory();
    clearTimeout(saveTimer);
    setAiBusy(true);
    setAiOutput('', false);
    addAiStep({ name: 'start', ok: true, pending: true, summary: `${resume ? '续跑' : engine === 'deepagents' ? 'Deep Agents' : '内置引擎'} 正在规划并持续执行任务…` });
    const res = await api.ai.agent({ instruction, engine, resume, prior: resume ? prior : null, attachments: sendAttachments })
      .catch(e => ({ ok: false, error: String(e) }));
    aiState.busy = false;
    setAiBusy(false);
    if (!res || !res.ok) {
      const err = (res && res.error) || '未知错误';
      addAiStep({ name: 'error', ok: false, summary: err });
      archiveAiRun({ text: '执行失败：' + err, error: true });
      renderAiSessions();
      persistAiSessions(true);
      return;
    }
    if (res.prior) { session.prior = res.prior; aiHasSession = true; }
    aiState.text = res.text || '';
    if (res.library) applyAgentLibrary(res.library);
    if (Array.isArray(res.plan) && res.plan.length) applyAgentPlan(res.plan);
    markSaved();
    const verified = Boolean(res.verified);
    const truncated = Boolean(res.truncated) && !res.stopped && !verified;
    const pg = res.progress || {};
    const remain = Array.isArray(pg.pending) ? pg.pending : [];
    const fallback = truncated
      ? `目标尚未达成：清单完成 ${pg.done || 0}/${pg.total || 0} 项${remain.length ? `，剩余「${remain.slice(0, 2).join('、')}${remain.length > 2 ? '…' : ''}」` : ''}。已执行 ${res.steps || aiStepCount} 步，点「继续任务」会从剩余目标接着完成，不会重做已完成的编辑。`
      : verified
        ? '任务清单已全部完成并通过系统验收，剧本已按整体目标更新。'
        : '剧本已按指令更新，详见上方任务计划与工具调用记录。';
    const finalText = aiState.text || (res.stopped ? '' : fallback);
    addAiStep({ name: 'done', ok: !truncated, summary: res.stopped ? '已停止 · 可点「继续任务」接着做' : (truncated ? `未完成 · 剩余 ${remain.length} 项，可继续` : `验收通过 · 当前剧本共 ${blocks().length} 个内容块`) });
    archiveAiRun({ text: finalText || (res.stopped ? '已停止，可点「继续任务」接着做。' : '剧本已按指令更新。'), verified });
    renderAiSessions();
    persistAiSessions(true);
    $('#aiAgentResume').disabled = false;
    toast(res.stopped ? '已停止生成' : (truncated ? '目标未达成，可继续' : '任务已验收通过'));
  }

  async function aiStop() {
    await api.ai.stop().catch(() => {});
  }

  function showAiPanel() {
    $$('.side-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'ai'));
    $('#panelChars').classList.add('hidden');
    $('#panelStats').classList.add('hidden');
    $('#panelAI').classList.remove('hidden');
    $('#rightSidebar').classList.add('ai-active');
    $('#app').classList.add('ai-mode');
    applyAiPanelWidth(true);
    if (aiSessionReady) { renderAiSessions(); scrollAiMessages(true); }
    refreshAiStatus();
  }

  Object.assign(ACTIONS, {
    aiConfig: { label: 'AI 模型配置…', desc: '配置服务商、模型与加密保存的 API Key', icon: 'i-cmd', group: 'AI', run: openAiConfig },
    aiAgent:  { label: '智能体：直接编辑剧本…', desc: '用工具调用持续改写当前剧本', icon: 'i-logo', group: 'AI', run: () => { showAiPanel(); setAiMode('agent'); $('#aiAgentInput').focus(); } },
    aiResume: { label: '继续未完成的 AI 任务', desc: '从上次任务的进度接着执行，可在输入框改写指令', icon: 'i-undo', group: 'AI', run: () => aiAgentRun(true) },
    inlineAi: { label: '行内 AI：改写当前块…', desc: '在内容块内就地对话，结果可替换、插入或复制', icon: 'i-spark', group: 'AI', key: 'Alt+Enter', run: () => openInlineAi(activeId || blocks()[0].id) },
    aiHint:   { label: '智能提示', desc: '获取剧情推进、冲突与对白建议', icon: 'i-sun', group: 'AI', run: aiHint },
    aiExpand: { label: '智能扩写', desc: '把当前块扩写成更有画面感的正文', icon: 'i-plus', group: 'AI', run: aiExpand },
    aiPolish: { label: '智能润色', desc: '精简并强化当前块文字', icon: 'i-check', group: 'AI', run: aiPolish },
    aiWrite:  { label: '自动写剧本…', desc: '根据一句话故事生成完整 Fountain 剧本', icon: 'i-logo', group: 'AI', run: openAiWrite },
    aiNovel:  { label: '小说生成剧本…', desc: '把小说 / 散文改写成 Fountain 剧本', icon: 'i-logo', group: 'AI', run: openNovelToScript },
    aiStop:   { label: '停止 AI 生成', desc: '中断当前生成', icon: 'i-close', group: 'AI', run: aiStop }
  });
  MENUS.ai = ['aiConfig', '-', 'inlineAi', 'aiAgent', 'aiResume', '-', 'aiHint', 'aiExpand', 'aiPolish', '-', 'aiWrite', 'aiNovel', 'aiStop'];

  function openAbout() {
    showModal({
      title: '关于',
      body: `<div class="about-logo"><div class="brand-mark"><svg class="ic" viewBox="0 0 24 24"><use href="#i-logo"/></svg></div><h3>剧本工坊</h3><p>Scriptwriter Studio · 桌面版</p></div>
        <div class="modal-hint">专为编剧打造的写作环境：标准剧本元素排版、场景大纲、角色台词统计、自动补全、Fountain 互通与 A4 PDF 导出。所有剧本保存在本机，无需联网。</div>
        <div class="modal-hint">数据位置：${api.isDesktop ? '工作目录 scripts 文件夹，每份剧本一个 .screenplay 工程文件' : '浏览器 localStorage'}</div>`,
      actions: [{ label: '关闭', primary: true, onClick: closeModal }]
    });
  }

  /* ------------------------------ Toast ------------------------------ */
  function toast(msg, error) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', Boolean(error));
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 220);
    }, 2300);
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindEvents() {
    const blocksHost = $('#blocks');
    bindSplitters();
    $('#statusZoom').addEventListener('click', openAppearance);

    blocksHost.addEventListener('input', (e) => {
      const inlineInput = e.target.closest('.inline-ai-input');
      if (inlineInput) {
        inlineAi.draft = inlineInput.value;
        inlineInput.style.height = 'auto';
        inlineInput.style.height = Math.min(inlineInput.scrollHeight, 120) + 'px';
        const send = inlineInput.closest('.inline-ai')?.querySelector('.inline-ai-send');
        if (send) send.disabled = !inlineInput.value.trim() || inlineAi.busy;
        return;
      }
      if (aiState.busy) return;
      const ta = e.target.closest('.block-input');
      if (!ta) return;
      const b = blocks().find(x => x.id === ta.dataset.id);
      if (!b) return;
      b.text = ta.value;
      autoHeight(ta);
      refreshLight();
      scheduleHistory();
      if (['character', 'scene', 'transition', 'parenthetical', 'section'].includes(b.type)) updateSuggest(ta);
      else closeSuggest();
    });

    blocksHost.addEventListener('keydown', (e) => {
      const inlineInput = e.target.closest('.inline-ai-input');
      if (inlineInput) {
        if (e.isComposing) return;
        if (e.key === 'Escape') { e.preventDefault(); closeInlineAi(); return; }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); inlineAiSend(); return; }
        return;
      }
      if (!aiState.busy) { onBlockKeydown(e); return; }
      const k = String(e.key).toLowerCase();
      const nav = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', 'home', 'end', 'escape'].includes(k);
      const copy = (e.ctrlKey || e.metaKey) && ['c', 'a', 'f'].includes(k);
      if (!nav && !copy) e.preventDefault();
    });
    blocksHost.addEventListener('focusin', (e) => {
      const ta = e.target.closest('.block-input');
      if (ta) setActive(ta.dataset.id);
    });
    blocksHost.addEventListener('click', (e) => {
      const action = e.target.closest('[data-inline-action]');
      if (action) {
        e.preventDefault();
        const act = action.dataset.inlineAction;
        if (act === 'close') closeInlineAi();
        else if (act === 'send') inlineAiSend();
        else if (act === 'stop') inlineAiStop();
        else if (act === 'regenerate') inlineAiRegenerate();
        else inlineAiApply(act);
        return;
      }
      const chip = e.target.closest('[data-inline-prompt]');
      if (chip) { e.preventDefault(); inlineAiSend(chip.dataset.inlinePrompt); return; }
      const aiBtn = e.target.closest('[data-ai-block]');
      if (aiBtn) { e.preventDefault(); openInlineAi(aiBtn.dataset.aiBlock); return; }
      const addBefore = e.target.closest('[data-add-before]');
      if (addBefore) { e.preventDefault(); showInsertMenu(addBefore.dataset.addBefore, addBefore); return; }
      const badge = e.target.closest('[data-badge]');
      if (badge) { e.preventDefault(); showTypeMenu(badge.dataset.badge, badge); }
    });
    $('#addBlockBtn').addEventListener('click', () => appendTypedBlock('action'));

    /* 封面元数据 */
    const metaMap = [['#metaTitle', 'title'], ['#metaAuthor', 'author'], ['#metaGenre', 'genre'], ['#metaLogline', 'logline']];
    metaMap.forEach(([sel, key]) => $(sel).addEventListener('input', (e) => {
      script()[key] = e.target.value;
      if (key === 'title') { $('#docName').textContent = e.target.value; document.title = `${e.target.value} — 剧本工坊`; api.setTitle(e.target.value); renderDocMenu(); }
      renderPrintView(); scheduleSave();
    }));

    /* 文档菜单 */
    $('#docBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      renderDocMenu();
      $('#docMenu').classList.toggle('hidden');
      closeMenus();
    });
    $('#docMenu').addEventListener('click', (e) => {
      const item = e.target.closest('[data-doc-id]');
      if (item) { switchScript(item.dataset.docId); return; }
      const act = e.target.closest('[data-doc-action]');
      if (!act) return;
      ({ new: newScript, rename: renameScript, duplicate: duplicateScript, delete: deleteScript })[act.dataset.docAction]?.();
      $('#docMenu').classList.add('hidden');
    });

    /* 菜单栏 */
    $$('.menu-root').forEach(btn => btn.addEventListener('mouseenter', () => { if (menuOpen) showMenu(btn.dataset.menu, btn); }));
    $$('.menu-root').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); showMenu(btn.dataset.menu, btn); }));
    $('#menuPopup').addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (item) { closeMenus(); ACTIONS[item.dataset.action]?.run(); return; }
      const typeItem = e.target.closest('[data-type]');
      if (typeItem) { const id = typeItem.dataset.block; closeMenus(); changeType(id, typeItem.dataset.type); return; }
      const insertItem = e.target.closest('[data-insert-type]');
      if (insertItem) { closeMenus(); insertBeforeBlock(insertItem.dataset.insertBefore, insertItem.dataset.insertType); }
    });

    /* 大纲 */
    $('#outline').addEventListener('click', (e) => {
      const item = e.target.closest('.outline-item');
      if (!item) return;
      focusBlock(item.dataset.id); scrollToBlock(item.dataset.id);
    });
    $('#outlineSearch').addEventListener('input', renderOutline);
    $('#addSceneBtn').addEventListener('click', () => appendTypedBlock('scene'));
    $('#targetPages').addEventListener('input', (e) => {
      script().targetPages = Math.max(0, Number(e.target.value) || 0);
      renderGoal(); scheduleSave();
    });

    /* 角色 / 统计 */
    $$('.side-tab').forEach(t => t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      const ai = tab === 'ai';
      $$('.side-tab').forEach(x => x.classList.toggle('active', x === t));
      $('#panelChars').classList.toggle('hidden', tab !== 'chars');
      $('#panelStats').classList.toggle('hidden', tab !== 'stats');
      $('#panelAI').classList.toggle('hidden', !ai);
      $('#rightSidebar').classList.toggle('ai-active', ai);
      $('#app').classList.toggle('ai-mode', ai);
      applyAiPanelWidth(ai);
      if (ai) { refreshAiStatus(); updateAiScope(); updateEngineTip(); renderAiSessions(); scrollAiMessages(true); }
      else $('#aiSessionDrawer').classList.add('hidden');
      lib.settings.aiLastTab = tab;
      scheduleSave();
    }));
    $('#charList').addEventListener('click', (e) => {
      const item = e.target.closest('.char-item');
      if (!item) return;
      const c = insertBlock(blocks()[blocks().length - 1].id, 'character', item.dataset.name);
      insertBlock(c.id, 'dialogue');
    });

    /* 顶栏按钮 */
    $('#cmdBtn').addEventListener('click', openCommand);
    $('#statusLocation').addEventListener('click', openWorkspace);

    /* AI 助手 */
    if (api.ai && api.ai.onChunk) {
      api.ai.onChunk((delta) => {
        const agentMode = aiState.mode === 'agent';
        aiState.text = agentMode ? delta : (aiState.text + delta);
        const out = $('#aiOutput');
        out.textContent = aiState.text;
        out.classList.remove('error', 'hidden');
        out.scrollTop = out.scrollHeight;
        scrollAiMessages();
        updateAiResultButtons();
      });
    }
    if (api.ai && api.ai.onStep) {
      api.ai.onStep((step) => addAiStep(step));
    }
    if (api.ai && api.ai.onLibrary) {
      api.ai.onLibrary((library) => applyAgentLibrary(library));
    }
    if (api.ai && api.ai.onPlan) {
      api.ai.onPlan((steps) => applyAgentPlan(steps));
    }
    $$('.ai-mode').forEach(b => b.addEventListener('click', () => setAiMode(b.dataset.aiMode)));
    $('#aiEngine').addEventListener('change', () => {
      updateEngineTip();
      const s = aiSession();
      if (s) { s.engine = $('#aiEngine').value; persistAiSessions(); }
    });
    $('#aiAgentRun').addEventListener('click', () => aiAgentRun(false));
    $('#aiAgentResume').addEventListener('click', () => aiAgentRun(true));
    $('#aiAgentInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiAgentRun(); }
      if (e.key === 'Escape') $('#aiMention').classList.add('hidden');
    });
    $('#aiAgentInput').addEventListener('input', () => {
      const ta = $('#aiAgentInput');
      const v = ta.value;
      const pos = ta.selectionStart ?? v.length;
      const before = v.slice(0, pos);
      const trigger = /@$/.test(before) && (before.length === 1 || /[\s\n]$/.test(before.slice(0, -1)));
      $('#aiMention').classList.toggle('hidden', !trigger);
    });
    $('#aiMentionFileBtn').addEventListener('click', async () => {
      $('#aiMention').classList.add('hidden');
      const list = await pickRefFiles();
      if (list && list.length) { aiAttachments = aiAttachments.concat(list); renderAiAttachments(); toast(`已引用 ${list.length} 个文件，发送时由 AI 自行读取`); }
    });
    $('#aiAttachments').addEventListener('click', (e) => {
      const x = e.target.closest('[data-ai-att]');
      if (x) { aiAttachments.splice(Number(x.dataset.aiAtt), 1); renderAiAttachments(); }
    });
    $$('.ai-chip').forEach(b => b.addEventListener('click', () => {
      $('#aiAgentInput').value = b.dataset.aiPrompt;
      $('#aiAgentInput').focus();
    }));
    $('#aiAgentClear').addEventListener('click', clearAiSession);
    $('#aiLiveToggle').addEventListener('click', () => $('#aiLive').classList.toggle('collapsed'));

    /* 会话栏与会话列表 */
    $('#aiSessionsToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const drawer = $('#aiSessionDrawer');
      drawer.classList.toggle('hidden');
      if (!drawer.classList.contains('hidden')) { renderAiSessions(); $('#aiSessionSearch').focus(); }
    });
    $('#aiSessionDrawer').addEventListener('click', (e) => e.stopPropagation());
    $('#aiSessionNew').addEventListener('click', createAiSession);
    $('#aiSessionSearch').addEventListener('input', renderAiSessions);
    $('#aiSessionList').addEventListener('click', (e) => {
      const row = e.target.closest('.ai-session-item');
      if (!row) return;
      const btn = e.target.closest('[data-action]');
      if (btn) {
        if (btn.dataset.action === 'rename') renameAiSession(row.dataset.id);
        else deleteAiSession(row.dataset.id);
        return;
      }
      switchAiSession(row.dataset.id);
    });

    /* 消息流：折叠执行过程、对任意历史回复执行复制 / 替换 / 插入 */
    $('#aiMessages').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-ai-toggle]');
      if (toggle) {
        const card = toggle.closest('.ai-msg');
        const body = card?.querySelector('.ai-run-body');
        if (body) { body.classList.toggle('hidden'); card.classList.toggle('open', !body.classList.contains('hidden')); }
        return;
      }
      const act = e.target.closest('[data-msg-action]');
      if (!act) return;
      const wrap = act.closest('.ai-msg');
      const msg = aiSession()?.messages.find(m => m.id === wrap?.dataset.id);
      if (msg) aiApplyResult(act.dataset.msgAction, msg.text);
    });

    updateEngineTip();
    $('#aiConfigBtn').addEventListener('click', openAiConfig);
    $$('.ai-action').forEach(b => b.addEventListener('click', () => {
      ({ hint: aiHint, expand: aiExpand, polish: aiPolish, write: openAiWrite, novel: openNovelToScript })[b.dataset.ai]?.();
    }));
    $('#aiReplace').addEventListener('click', () => aiApplyResult('replace'));
    $('#aiInsert').addEventListener('click', () => aiApplyResult('insert'));
    $('#aiCopy').addEventListener('click', () => aiApplyResult('copy'));
    $('#aiStop').addEventListener('click', aiStop);
    updateAiResultButtons();
    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#focusBtn').addEventListener('click', toggleZen);
    $('#quickExportBtn').addEventListener('click', (e) => { e.stopPropagation(); showMenu('export', $('#quickExportBtn')); });

    /* 命令面板 */
    $('#cmdInput').addEventListener('input', (e) => { cmdIndex = 0; renderCommand(e.target.value); });
    $('#cmdInput').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = clamp(cmdIndex + 1, 0, cmdItems.length - 1); renderCommand($('#cmdInput').value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = clamp(cmdIndex - 1, 0, cmdItems.length - 1); renderCommand($('#cmdInput').value); }
      else if (e.key === 'Enter') { e.preventDefault(); runCommand(cmdIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCommand(); }
    });
    $('#cmdList').addEventListener('click', (e) => { const it = e.target.closest('[data-cmd]'); if (it) runCommand(Number(it.dataset.cmd)); });
    $('#cmdOverlay').addEventListener('click', (e) => { if (e.target.id === 'cmdOverlay') closeCommand(); });

    /* 模态框 */
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalActions').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-modal-action]');
      if (!btn) return;
      const action = $('#modalActions')._actions[Number(btn.dataset.modalAction)];
      if (!action) return;
      if (action.onClick) action.onClick(); else closeModal();
    });
    $('#modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

    /* 补全浮层 */
    $('#suggest').addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-sg]');
      if (item) { e.preventDefault(); acceptSuggest(Number(item.dataset.sg)); }
    });

    /* 点击空白关闭弹层 */
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#menuPopup') && !e.target.closest('.menu-root') && !e.target.closest('#quickExportBtn') && !e.target.closest('.type-badge') && !e.target.closest('.block-add')) closeMenus();
      if (!e.target.closest('#docMenu') && !e.target.closest('#docBtn')) $('#docMenu').classList.add('hidden');
      if (!e.target.closest('#suggest') && !e.target.closest('.block-input')) closeSuggest();
      if (!e.target.closest('#aiSessionDrawer') && !e.target.closest('#aiSessionsToggle')) $('#aiSessionDrawer').classList.add('hidden');
      if (!e.target.closest('.inline-ai') && !e.target.closest('.block-ai-btn') && !e.target.closest('.block.ai-open')) closeInlineAi();
    });

    /* 全局快捷键 */
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (!$('#cmdOverlay').classList.contains('hidden')) return;
      if (e.key === 'Escape') {
        if (!$('#modalOverlay').classList.contains('hidden')) { closeModal(); return; }
        closeMenus(); closeSuggest(); $('#docMenu').classList.add('hidden'); return;
      }
      if (!$('#modalOverlay').classList.contains('hidden')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod) {
        const shift = e.shiftKey;
        if (k === 's') { e.preventDefault(); shift ? doExport('project') : saveNow(false); }
        else if (k === 'o') { e.preventDefault(); importFromFile(); }
        else if (k === 'n') { e.preventDefault(); newScript(); }
        else if (k === 'k') { e.preventDefault(); openCommand(); }
        else if (k === 'p') { e.preventDefault(); doExport('pdf'); }
        else if (k === 'z') { e.preventDefault(); shift ? redo() : undo(); }
        else if (k === 'y') { e.preventDefault(); redo(); }
        else if (k === '=' || k === '+') { e.preventDefault(); zoom(1); }
        else if (k === '-') { e.preventDefault(); zoom(-1); }
        return;
      }
      if (e.key === 'F11') { e.preventDefault(); toggleZen(); }
    });

    /* 拖放文件（Electron 中阻止导航，浏览器里读取内容） */
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const name = file.name.replace(/\.[^.]+$/, '');
        if (/\.(json|screenplay)$/i.test(file.name)) {
          try {
            const raw = JSON.parse(reader.result);
            if (raw && Array.isArray(raw.blocks)) { addImportedScript(raw.title || name, raw.blocks.map(b => ({ ...b, id: uid() })), raw); return; }
          } catch {}
        }
        const parsed = parseFountain(reader.result);
        addImportedScript(parsed.meta.title || name, parsed.blocks, parsed.meta);
      };
      reader.readAsText(file, 'utf8');
    });

    window.addEventListener('beforeunload', () => {
      try { api.flushLibrary(); } catch {}
      persistAiSessions(true);
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  async function init() {
    const info = await api.info().catch(() => null);
    $('#statusVersion').textContent = info ? `v${info.version} · 桌面版` : '浏览器预览模式';
    let loaded = null;
    try { loaded = await api.loadLibrary(); } catch {}
    if (loaded && Array.isArray(loaded.scripts) && loaded.scripts.length) {
      lib = { scripts: loaded.scripts.map(normalizeScript), activeId: loaded.activeId, settings: normalizeSettings(loaded.settings) };
      if (!lib.scripts.some(s => s.id === lib.activeId)) lib.activeId = lib.scripts[0].id;
    } else {
      lib = defaultLib();
      await api.saveLibrary(lib);
    }
    activeId = blocks()[0].id;
    lastSnapshot = JSON.stringify(blocks());
    bindEvents();
    await loadAiSessions();
    applyTheme(lib.settings.theme);
    applyAppearance(lib.settings);
    $('#app').classList.toggle('zen', Boolean(lib.settings.zen));
    $('#focusBtn').classList.toggle('primary', Boolean(lib.settings.zen));
    renderAll();
    markSaved();
    refreshLocationLabel();
    // 上次停在 AI 会话且有历史消息时，重启后直接回到对话，而不是让用户重新找标签
    if (lib.settings.aiLastTab === 'ai' && aiSession()?.messages.length) showAiPanel();
    else refreshAiStatus();
    setTimeout(() => toast('欢迎使用剧本工坊 · Ctrl+K 打开命令面板'), 500);
  }

  init();
})();

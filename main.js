'use strict';

/*
 * 知识库助手（kb-assistant）
 *
 * 在 Obsidian 里问本机知识库，不依赖 Copilot：
 *   1. 上下文：直接遍历库内「知识库/」文件夹的条目（跳过下划线开头的派生文件），
 *      手机上刚写进去的条目立刻就能被问到，不必等电脑刷新 _全文合并.md。
 *   2. 模型：默认复用「AI 笔记总结」（ai-note-summary）里已经填好的 API 配置，
 *      不用再填一遍 key；也可以在本插件里单独填。
 *   3. 写入：回答可一键整理成知识库条目，直接写进「知识库/」（只新建文件，永不覆盖）。
 *   4. 留痕：问答自动追加到「AI对话/」里的会话文件。
 *
 * 行为规范（提示词）优先从库内「知识库/_手机助手提示词.md」读取，缺省用内置默认。
 */

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Notice = obsidian.Notice;
const Modal = obsidian.Modal;
const ItemView = obsidian.ItemView;
const MarkdownRenderer = obsidian.MarkdownRenderer;
const MarkdownView = obsidian.MarkdownView;
const TFile = obsidian.TFile;
const normalizePath = obsidian.normalizePath;
const requestUrl = obsidian.requestUrl;
const Platform = obsidian.Platform;

const VIEW_TYPE = 'kb-assistant-chat';

const DEFAULT_SYSTEM_PROMPT = [
  '你是「星五晚」的知识库助手，运行在他自己的 Obsidian 库里。守则：',
  '1. 只依据下方提供的「知识库内容」回答；库里没有的，明确说没有，并说明该去哪里查。绝不编造条目名、数字或文件路径。',
  '2. 用中文回答；先给结论，再给依据；引用知识库时写出条目名，必要带上「最后核对」日期。',
  '3. 库里的记录和你的常识冲突时，以库里的为准，并说明这是库里的记录。',
  '4. 不确定就直接说不确定，不要用流畅的措辞掩盖。不要迎合、不要谄媚，内核优先于包装。',
  '5. 涉及命令和路径时写可执行的原文，不要臆造参数。',
].join('\n');

const DRAFT_SYSTEM_PROMPT = [
  '你负责把用户的一段内容整理成一则知识库条目。严格按下面的格式输出，只输出条目正文，不要任何额外说明：',
  '',
  '# <简短中文条目名>',
  '',
  '来源：手机端对话（<今天日期>）／最后核对：待电脑端核对',
  '',
  '## 结论',
  '## 证据（实测）',
  '## 操作步骤',
  '## 踩坑与限制',
  '## 未验证',
  '',
  '要求：',
  '- 只写内容里出现的事实，不补充、不推测；凡是推测一律放进「未验证」并写明这是推测。',
  '- 没有内容的节整节删掉，不要留空标题。',
  '- 绝不写任何 API Key、token、口令；遇到就写「（略）」。',
  '- 第一行必须是「# 条目名」，紧接的一段必须是「来源：…／最后核对：…」那一行。',
].join('\n');

const DEFAULT_SETTINGS = {
  kbFolder: '知识库',
  maxContextChars: 300000,
  systemPromptFile: '知识库/_手机助手提示词.md',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  providerMode: 'borrow',
  borrowPluginId: 'ai-note-summary',
  borrowModel: 'deepseek-flash',
  apiUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.3,
  maxHistoryChars: 12000,
  markPending: true,
  logChat: true,
  logFolder: 'AI对话',
};

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/,
  /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\./,
];

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

function pad2(n) {
  const s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function stampStr() {
  const d = new Date();
  return todayStr() + ' ' + pad2(d.getHours()) + '-' + pad2(d.getMinutes());
}

function sanitizeName(name) {
  return String(name || '')
    .replace(ILLEGAL_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function trimSlashes(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '').trim();
}

function humanChars(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

function findSecret(text) {
  const s = String(text || '');
  for (let i = 0; i < SECRET_PATTERNS.length; i++) {
    const m = s.match(SECRET_PATTERNS[i]);
    if (m) return m[0];
  }
  return null;
}

/* ---------------- 写入前确认弹窗 ---------------- */

class EntryConfirmModal extends Modal {
  constructor(app, name, body, resolve) {
    super(app);
    this.entryName = name;
    this.body = body;
    this.resolve = resolve;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '存进知识库' });
    contentEl.createEl('p', {
      text: '会新建一个条目文件（已存在同名就自动加序号），不会改动任何现有文件。',
      cls: 'kb-hint',
    });

    new Setting(contentEl)
      .setName('条目名')
      .setDesc('文件名（不含 .md）')
      .addText((t) => {
        t.setValue(this.entryName).onChange((v) => {
          this.entryName = v;
        });
      });

    contentEl.createEl('div', { text: '正文预览', cls: 'kb-hint' });
    contentEl.createDiv({ cls: 'kb-entry-preview', text: this.body });

    const actions = contentEl.createDiv({ cls: 'kb-head-btns' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const ok = actions.createEl('button', { text: '写入知识库', cls: 'mod-cta' });
    ok.onclick = () => {
      this.done = true;
      this.resolve({ name: sanitizeName(this.entryName) || this.entryName, body: this.body });
      this.close();
    };
  }

  onClose() {
    if (!this.done) this.resolve(null);
    this.contentEl.empty();
  }
}

/* ---------------- 聊天视图 ---------------- */

class KBChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.history = [];
    this.busy = false;
    this.lastQuestion = '';
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '知识库助手';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('kb-assistant-view');

    const head = root.createDiv({ cls: 'kb-head' });
    this.metaEl = head.createDiv({ cls: 'kb-meta' });
    const btns = head.createDiv({ cls: 'kb-head-btns' });
    const reloadBtn = btns.createEl('button', { text: '重新载入' });
    reloadBtn.onclick = () => this.reload();
    const freshBtn = btns.createEl('button', { text: '新会话' });
    freshBtn.onclick = () => this.newSession();

    this.listEl = root.createDiv({ cls: 'kb-messages' });

    const foot = root.createDiv({ cls: 'kb-input' });
    this.inputEl = foot.createEl('textarea', { cls: 'kb-textarea' });
    this.inputEl.rows = 3;
    this.inputEl.placeholder = '问知识库…（Enter 发送，Shift+Enter 换行）';
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !Platform.isMobile) {
        e.preventDefault();
        this.send();
      }
    });
    this.sendBtn = foot.createEl('button', { text: '发送', cls: 'mod-cta' });
    this.sendBtn.onclick = () => this.send();

    await this.plugin.ensureKnowledgeBase();
    this.renderMeta();
    this.greet();
  }

  async onClose() {
    this.contentEl.empty();
  }

  renderMeta() {
    const kb = this.plugin.kb;
    let cfg = { model: '未配置' };
    try {
      cfg = this.plugin.resolveProvider();
    } catch (e) {
      /* 保持默认 */
    }
    const parts = [];
    parts.push(kb ? '知识库 ' + kb.entries.length + ' 篇 · ' + humanChars(kb.chars) + ' 字符' : '知识库未载入');
    parts.push('模型 ' + (cfg.model || '未配置'));
    this.metaEl.setText(parts.join('　|　'));
  }

  greet() {
    if (this.listEl.childElementCount) return;
    const hint = this.listEl.createDiv({ cls: 'kb-msg kb-msg-pending' });
    hint.setText(
      '可以直接问知识库里的任何事。回答下方的「存进知识库」会把这一问一答整理成条目；' +
      '问答会自动留痕到「' + (this.plugin.settings.logFolder || 'AI对话') + '/」。'
    );
  }

  newSession() {
    this.history = [];
    this.listEl.empty();
    this.plugin.sessionLogPath = null;
    this.greet();
    new Notice('已开新会话');
  }

  async reload() {
    await this.plugin.loadKnowledgeBase(true);
    this.renderMeta();
  }

  pushUser(text) {
    const el = this.listEl.createDiv({ cls: 'kb-msg kb-msg-user' });
    el.setText(text);
    this.scrollDown();
    return el;
  }

  pushPending() {
    const el = this.listEl.createDiv({ cls: 'kb-msg kb-msg-assistant kb-msg-pending' });
    const started = Date.now();
    const tick = () => {
      const sec = Math.round((Date.now() - started) / 1000);
      el.setText('正在想…（已 ' + sec + ' 秒；每次都要把整套知识库发出去，慢一点是正常的）');
    };
    tick();
    el._kbTimer = window.setInterval(tick, 1000);
    this.scrollDown();
    return el;
  }

  async finishPending(pendingEl, text, isError, question) {
    if (pendingEl._kbTimer) {
      window.clearInterval(pendingEl._kbTimer);
      pendingEl._kbTimer = null;
    }
    pendingEl.removeClass('kb-msg-pending');
    if (isError) pendingEl.addClass('kb-msg-error');
    pendingEl.empty();
    try {
      await MarkdownRenderer.render(this.plugin.app, text, pendingEl, '', this);
    } catch (e) {
      pendingEl.setText(text);
    }
    if (!isError) {
      const actions = pendingEl.createDiv({ cls: 'kb-msg-actions' });
      const save = actions.createEl('button', { text: '存进知识库' });
      save.onclick = () => this.plugin.saveTextToKB(String(question || '') + '\n\n' + text);
      const copy = actions.createEl('button', { text: '复制' });
      copy.onclick = () => {
        navigator.clipboard.writeText(text).then(
          () => new Notice('已复制'),
          () => new Notice('复制失败')
        );
      };
    }
    this.scrollDown();
  }

  scrollDown() {
    window.setTimeout(() => {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }, 30);
  }

  async send() {
    if (this.busy) {
      new Notice('上一条还在跑，稍等一下');
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = '';
    this.busy = true;
    this.sendBtn.disabled = true;
    this.lastQuestion = text;
    this.pushUser(text);
    const pendingEl = this.pushPending();
    try {
      const answer = await this.plugin.ask(text, this.history);
      await this.finishPending(pendingEl, answer, false, text);
      this.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      const logPath = await this.plugin.appendLog(text, answer);
      if (logPath) new Notice('已留痕：' + logPath, 4000);
    } catch (e) {
      await this.finishPending(pendingEl, '请求失败：' + (e && e.message ? e.message : e), true, text);
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
    }
  }
}

/* ---------------- 插件主类 ---------------- */

class KBAssistantPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.kb = null;
    this.sessionLogPath = null;

    this.registerView(VIEW_TYPE, (leaf) => new KBChatView(leaf, this));

    this.addRibbonIcon('book-open', '知识库助手：打开对话', () => this.activateView());

    this.addCommand({
      id: 'open-chat',
      name: '打开知识库对话',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'save-selection-to-kb',
      name: '把选中内容（或当前笔记）存进知识库',
      callback: () => this.saveSelectionToKB(),
    });

    this.addCommand({
      id: 'reload-kb',
      name: '重新载入知识库',
      callback: () => this.loadKnowledgeBase(true),
    });

    this.addCommand({
      id: 'test-connection',
      name: '测试模型连接',
      callback: () => this.testConnection(),
    });

    this.addSettingTab(new KBAssistantSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.loadKnowledgeBase(false).catch((e) => console.error('[kb-assistant] 载入知识库失败', e));
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---------- 知识库上下文 ---------- */

  async ensureKnowledgeBase() {
    if (!this.kb) await this.loadKnowledgeBase(false);
    return this.kb;
  }

  async loadKnowledgeBase(notify) {
    const folder = trimSlashes(this.settings.kbFolder) || '知识库';
    const entries = [];
    const all = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < all.length; i++) {
      const f = all[i];
      if (f.parent && f.parent.path === folder && !f.basename.startsWith('_')) entries.push(f);
    }
    entries.sort((a, b) => {
      const ar = a.basename.toUpperCase() === 'README';
      const br = b.basename.toUpperCase() === 'README';
      if (ar !== br) return ar ? 1 : -1;
      return a.basename.localeCompare(b.basename, 'zh');
    });

    const parts = [];
    for (let i = 0; i < entries.length; i++) {
      let body = '';
      try {
        body = (await this.app.vault.cachedRead(entries[i])).trim();
      } catch (e) {
        body = '（读取失败：' + (e && e.message ? e.message : e) + '）';
      }
      parts.push('## ' + entries[i].basename + '\n\n' + body);
    }

    let text = parts.join('\n\n');
    const limit = Math.max(0, Number(this.settings.maxContextChars) || 0);
    let truncated = false;
    if (limit && text.length > limit) {
      text = text.slice(0, limit) + '\n\n（上下文达到上限，后面的条目被截断）';
      truncated = true;
    }

    this.kb = {
      folder: folder,
      entries: entries.map((f) => f.basename),
      chars: text.length,
      text: text,
      truncated: truncated,
      loadedAt: todayStr(),
    };

    if (notify) {
      new Notice(
        '知识库已载入：' + this.kb.entries.length + ' 篇 · ' + humanChars(this.kb.chars) + ' 字符' +
        (truncated ? '（已截断，可在设置里放宽上限）' : ''),
        5000
      );
    }
    return this.kb;
  }

  async resolveSystemPrompt() {
    const path = trimSlashes(this.settings.systemPromptFile);
    if (path) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (f instanceof TFile) {
        try {
          const t = (await this.app.vault.cachedRead(f)).trim();
          if (t) return t;
        } catch (e) {
          /* 读不到就退回内置 */
        }
      }
    }
    const own = String(this.settings.systemPrompt || '').trim();
    return own || DEFAULT_SYSTEM_PROMPT;
  }

  /* ---------- 模型 ---------- */

  otherPlugin() {
    const id = String(this.settings.borrowPluginId || '').trim();
    if (!id) return null;
    try {
      const pm = this.app.plugins;
      if (pm) {
        if (typeof pm.getPlugin === 'function') {
          const p = pm.getPlugin(id);
          if (p) return p;
        }
        if (pm.plugins && pm.plugins[id]) return pm.plugins[id];
      }
    } catch (e) {
      /* 拿不到就当没有 */
    }
    return null;
  }

  resolveProvider() {
    if (String(this.settings.providerMode) === 'borrow') {
      const other = this.otherPlugin();
      const s = other && other.settings;
      if (s && s.apiUrl && s.apiKey && s.model) {
        const override = String(this.settings.borrowModel || '').trim();
        return {
          apiUrl: String(s.apiUrl).trim(),
          apiKey: String(s.apiKey).trim(),
          model: override || String(s.model).trim(),
          source: 'borrowed',
        };
      }
    }
    return {
      apiUrl: String(this.settings.apiUrl || '').trim(),
      apiKey: String(this.settings.apiKey || '').trim(),
      model: String(this.settings.model || '').trim(),
      source: 'own',
    };
  }

  async callModel(cfg, messages) {
    if (!cfg.apiUrl || !cfg.apiKey || !cfg.model) {
      throw new Error(
        '还没有可用的模型配置：把设置里「模型来源」设为复用「AI 笔记总结」，或切到「本插件自己填」并填好地址/Key/模型'
      );
    }

    let resp;
    try {
      resp = await requestUrl({
        url: cfg.apiUrl,
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          stream: false,
          temperature: Number(this.settings.temperature),
        }),
        throw: false,
      });
    } catch (e) {
      const status = e && e.status;
      if (status && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status + '：' + (e.message || ''));
      }
      throw new Error('请求没发出去：' + (e && e.message ? e.message : e));
    }

    if (resp.status < 200 || resp.status >= 300) {
      let detail = '';
      try {
        const j = resp.json;
        detail = (j && j.error && j.error.message) || JSON.stringify(j);
      } catch (e) {
        detail = resp.text || '';
      }
      throw new Error('HTTP ' + resp.status + (detail ? '：' + detail : ''));
    }

    const data = resp.json;
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const out = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    if (out) return out;
    const reasoning = msg && msg.reasoning_content;
    if (reasoning) return String(reasoning).trim();
    throw new Error('模型返回了空内容');
  }

  async ask(question, history) {
    const cfg = this.resolveProvider();
    const kb = await this.ensureKnowledgeBase();
    const system = (await this.resolveSystemPrompt()) +
      '\n\n===== 知识库内容（共 ' + kb.entries.length + ' 篇，' + kb.loadedAt + ' 载入）=====\n' + kb.text;

    const messages = [{ role: 'system', content: system }];

    const maxHist = Math.max(0, Number(this.settings.maxHistoryChars) || 0);
    const keep = [];
    let used = 0;
    const hist = history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const c = String(hist[i].content || '');
      if (maxHist && used + c.length > maxHist) break;
      used += c.length;
      keep.unshift({ role: hist[i].role, content: c });
    }
    for (let i = 0; i < keep.length; i++) messages.push(keep[i]);
    messages.push({ role: 'user', content: question });

    return await this.callModel(cfg, messages);
  }

  async testConnection() {
    const n = new Notice('正在测试模型连接…', 0);
    try {
      const cfg = this.resolveProvider();
      const out = await this.callModel(cfg, [{ role: 'user', content: '只回复两个字：可用' }]);
      n.hide();
      new Notice(
        '连接正常（' + (cfg.source === 'borrowed' ? '复用配置' : '本插件配置') + ' · ' + cfg.model + '）\n' +
        out.slice(0, 60),
        8000
      );
    } catch (e) {
      n.hide();
      new Notice('连接失败：' + (e && e.message ? e.message : e), 12000);
    }
  }

  /* ---------- 写入知识库 ---------- */

  async saveTextToKB(text) {
    const content = String(text || '').trim();
    if (!content) {
      new Notice('没有可存的内容');
      return null;
    }
    const n = new Notice('正在整理成条目…', 0);
    let draft;
    try {
      const cfg = this.resolveProvider();
      draft = await this.callModel(cfg, [
        { role: 'system', content: DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: content },
      ]);
    } catch (e) {
      n.hide();
      new Notice('整理失败：' + (e && e.message ? e.message : e), 12000);
      return null;
    }
    n.hide();
    return await this.confirmAndWrite(draft);
  }

  async saveSelectionToKB() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let text = '';
    if (view && view.editor) {
      text = view.editor.getSelection();
      if (!text) text = view.editor.getValue();
    } else {
      const f = this.app.workspace.getActiveFile();
      if (f instanceof TFile) text = await this.app.vault.cachedRead(f);
    }
    if (!String(text).trim()) {
      new Notice('先打开一篇笔记，或选中一段内容');
      return null;
    }
    return await this.saveTextToKB(text);
  }

  normalizeEntry(draft) {
    const lines = String(draft || '').replace(/\r\n/g, '\n').trim().split('\n');
    let idx = 0;
    while (idx < lines.length && !lines[idx].trim()) idx++;
    const name = sanitizeName(String(lines[idx] || '').replace(/^#+\s*/, '')) || '未命名条目';
    let body = lines.join('\n').trim();

    if (!/最后核对：/.test(body)) {
      const line = '来源：手机端对话（' + todayStr() + '）／最后核对：' +
        (this.settings.markPending ? '待电脑端核对' : todayStr());
      lines.splice(idx + 1, 0, '', line);
      body = lines.join('\n').trim();
    } else if (!this.settings.markPending) {
      body = body.replace(/最后核对：[^／\n]*/, '最后核对：' + todayStr());
    }
    return { name: name, body: body };
  }

  async confirmAndWrite(draft) {
    const entry = this.normalizeEntry(draft);
    const secret = findSecret(entry.body);
    if (secret) {
      new Notice(
        '内容里像是含密钥（' + String(secret).slice(0, 8) + '…）。知识库规矩不放任何 Key / token，请先删掉那一行再存。',
        12000
      );
      return null;
    }

    const picked = await new Promise((resolve) => {
      new EntryConfirmModal(this.app, entry.name, entry.body, resolve).open();
    });
    if (!picked) return null;

    const folder = trimSlashes(this.settings.kbFolder) || '知识库';
    await this.ensureFolder(folder);
    const path = this.uniquePath(folder, picked.name);
    try {
      await this.app.vault.create(path, picked.body.endsWith('\n') ? picked.body : picked.body + '\n');
    } catch (e) {
      new Notice('写入失败：' + (e && e.message ? e.message : e), 12000);
      return null;
    }
    await this.loadKnowledgeBase(false);
    new Notice(
      '已写入 ' + path + '\n它立刻进入本插件的上下文；同步到电脑后由电脑端补 README 表格行。',
      8000
    );
    return path;
  }

  /* ---------- 留痕 ---------- */

  async appendLog(question, answer) {
    if (!this.settings.logChat) return null;
    const folder = trimSlashes(this.settings.logFolder) || 'AI对话';
    try {
      await this.ensureFolder(folder);
      if (!this.sessionLogPath || !this.app.vault.getAbstractFileByPath(this.sessionLogPath)) {
        this.sessionLogPath = this.uniquePath(folder, stampStr() + ' 知识库问答');
        const cfg = this.resolveProvider();
        const head = [
          '---',
          'created: ' + todayStr(),
          'source: 知识库助手（' + (Platform.isMobile ? '手机端' : '电脑端') + '）',
          'model: ' + (cfg.model || ''),
          'entries: ' + (this.kb ? this.kb.entries.length : 0),
          '---',
          '',
          '# ' + stampStr() + ' 知识库问答',
          '',
        ].join('\n');
        await this.app.vault.create(this.sessionLogPath, head);
      }
      const block = ['## 我问', '', question, '', '## 它答', '', answer, '', '---', ''].join('\n');
      const file = this.app.vault.getAbstractFileByPath(this.sessionLogPath);
      if (file instanceof TFile) await this.app.vault.append(file, block);
      return this.sessionLogPath;
    } catch (e) {
      console.error('[kb-assistant] 留痕失败', e);
      return null;
    }
  }

  /* ---------- 工具 ---------- */

  async ensureFolder(path) {
    const clean = trimSlashes(path);
    if (!clean) return;
    if (this.app.vault.getAbstractFileByPath(normalizePath(clean))) return;
    const segs = clean.split('/');
    let cur = '';
    for (let i = 0; i < segs.length; i++) {
      cur = cur ? cur + '/' + segs[i] : segs[i];
      if (!this.app.vault.getAbstractFileByPath(normalizePath(cur))) {
        try {
          await this.app.vault.createFolder(normalizePath(cur));
        } catch (e) {
          /* 并发创建会报「已存在」，忽略 */
        }
      }
    }
  }

  uniquePath(folder, baseName) {
    const base = sanitizeName(baseName) || '未命名';
    let path = normalizePath(folder + '/' + base + '.md');
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(folder + '/' + base + ' (' + i + ').md');
      i++;
      if (i > 200) break;
    }
    return path;
  }

  async activateView() {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE);
    let leaf = leaves.length ? leaves[0] : null;
    if (!leaf) {
      leaf = Platform.isMobile ? ws.getLeaf(true) : ws.getRightLeaf(false);
      if (!leaf) leaf = ws.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
  }
}

/* ---------------- 设置页 ---------------- */

class KBAssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    containerEl.createEl('h2', { text: '知识库助手' });

    containerEl.createEl('h3', { text: '① 知识库' });

    new Setting(containerEl)
      .setName('知识库文件夹')
      .setDesc('库内放条目的文件夹，默认「知识库」。只读取该文件夹根目录的 .md，跳过下划线开头的派生文件。')
      .addText((t) =>
        t.setValue(p.settings.kbFolder).onChange(async (v) => {
          p.settings.kbFolder = v.trim() || '知识库';
          await p.saveSettings();
          await p.loadKnowledgeBase(true);
        })
      );

    new Setting(containerEl)
      .setName('上下文上限（字符）')
      .setDesc('整套知识库都会发出去，超过这个字符数才截断；0 表示不限制。')
      .addText((t) =>
        t.setValue(String(p.settings.maxContextChars)).onChange(async (v) => {
          const n = Number(v);
          p.settings.maxContextChars = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SETTINGS.maxContextChars;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('行为提示词文件')
      .setDesc('优先读这个文件当系统提示词；文件不在就用下面的内置提示词。放在知识库里可以随同步走，也能让电脑端 Codex 帮你改。')
      .addText((t) =>
        t.setValue(p.settings.systemPromptFile).onChange(async (v) => {
          p.settings.systemPromptFile = v.trim();
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('内置系统提示词')
      .setDesc('上面那个文件读不到时用这段。')
      .addTextArea((ta) => {
        ta.setValue(p.settings.systemPrompt).onChange(async (v) => {
          p.settings.systemPrompt = v;
          await p.saveSettings();
        });
        ta.inputEl.rows = 8;
        ta.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('重新载入知识库')
      .setDesc('写入新条目后会自动重载，这里也可以手动刷一次。')
      .addButton((b) =>
        b.setButtonText('载入').onClick(async () => {
          const kb = await p.loadKnowledgeBase(true);
          new Notice('共 ' + kb.entries.length + ' 篇 · ' + humanChars(kb.chars) + ' 字符', 6000);
        })
      );

    containerEl.createEl('h3', { text: '② 模型' });

    new Setting(containerEl)
      .setName('模型来源')
      .setDesc('「复用」= 直接用别的插件里已填好的地址 / Key / 模型，本插件不另存一份密钥。')
      .addDropdown((d) => {
        d.addOption('borrow', '复用「AI 笔记总结」的配置');
        d.addOption('own', '本插件自己填');
        d.setValue(p.settings.providerMode).onChange(async (v) => {
          p.settings.providerMode = v;
          await p.saveSettings();
          this.display();
        });
      });

    if (String(p.settings.providerMode) === 'borrow') {
      new Setting(containerEl)
        .setName('要复用的插件 id')
        .setDesc('默认 ai-note-summary；该插件必须已启用并填好 API Key。')
        .addText((t) =>
          t.setValue(p.settings.borrowPluginId).onChange(async (v) => {
            p.settings.borrowPluginId = v.trim() || 'ai-note-summary';
            await p.saveSettings();
          })
        );
      new Setting(containerEl)
        .setName('模型（覆盖对方的）')
        .setDesc('留空就沿用对方插件里填的模型名；对方的旧名（如 deepseek-chat）可能已停服，建议留 deepseek-flash。')
        .addText((t) =>
          t.setValue(p.settings.borrowModel).onChange(async (v) => {
            p.settings.borrowModel = v.trim();
            await p.saveSettings();
          })
        );
    } else {
      new Setting(containerEl)
        .setName('API 地址')
        .setDesc('OpenAI 兼容接口，填到 /chat/completions')
        .addText((t) =>
          t.setValue(p.settings.apiUrl).onChange(async (v) => {
            p.settings.apiUrl = v.trim();
            await p.saveSettings();
          })
        );
      new Setting(containerEl)
        .setName('API Key')
        .setDesc('只存在本插件 data.json（明文），和另外两个插件同样的做法')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setValue(p.settings.apiKey).onChange(async (v) => {
            p.settings.apiKey = v.trim();
            await p.saveSettings();
          });
        });
      new Setting(containerEl)
        .setName('模型')
        .setDesc('DeepSeek 可用 deepseek-flash；要更强推理可换 deepseek-v4-pro')
        .addText((t) =>
          t.setValue(p.settings.model).onChange(async (v) => {
            p.settings.model = v.trim();
            await p.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName('历史对话上限（字符）')
      .setDesc('追问时最多带多少历史正文；0 表示全带。')
      .addText((t) =>
        t.setValue(String(p.settings.maxHistoryChars)).onChange(async (v) => {
          const n = Number(v);
          p.settings.maxHistoryChars = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SETTINGS.maxHistoryChars;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('测试连接')
      .addButton((b) => b.setButtonText('测试').onClick(() => p.testConnection()));

    containerEl.createEl('h3', { text: '③ 写入与留痕' });

    new Setting(containerEl)
      .setName('写入时标注「待电脑端核对」')
      .setDesc('开：条目里写「最后核对：待电脑端核对」，符合知识库「只写已验证内容」的规矩；关：直接写当天日期。')
      .addToggle((t) =>
        t.setValue(!!p.settings.markPending).onChange(async (v) => {
          p.settings.markPending = v;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('问答自动留痕')
      .setDesc('每个会话一个文件，一问一答追加进去；点「新会话」会另起一个文件。')
      .addToggle((t) =>
        t.setValue(!!p.settings.logChat).onChange(async (v) => {
          p.settings.logChat = v;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('留痕文件夹')
      .setDesc('不存在会自动新建')
      .addText((t) =>
        t.setValue(p.settings.logFolder).onChange(async (v) => {
          p.settings.logFolder = v.trim() || 'AI对话';
          await p.saveSettings();
        })
      );

    containerEl.createEl('p', {
      cls: 'kb-hint',
      text:
        '写入规矩：只新建文件（同名自动加序号），绝不改动已有条目、README 或 _全文合并.md；' +
        '含密钥样式的内容会被拦下。手机端写完 → EasySync 回电脑 → 电脑端补 README 表格行并刷新 _全文合并.md。',
    });
  }
}

module.exports = KBAssistantPlugin;
module.exports.default = KBAssistantPlugin;

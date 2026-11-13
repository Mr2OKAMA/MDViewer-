import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { loadSettings, saveSettings } from './settings.js';

const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdx', 'rmd'];
const PLAIN_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/x-web-markdown',
  'application/markdown',
  'application/x-markdown'
];

function hasMarkdownExtension(url) {
  try {
    const path = new URL(url).pathname;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return MD_EXTENSIONS.includes(ext);
  } catch {
    return false;
  }
}

/**
 * ブラウザがプレーンテキストとして表示しているドキュメントか判定する。
 * GitHub 等の HTML ページを誤って書き換えないための最重要チェック。
 */
function isPlainTextDocument() {
  if (PLAIN_TYPES.includes((document.contentType || '').toLowerCase()) === false) return false;
  const pre = document.body && document.body.firstElementChild;
  return !!pre && pre.tagName === 'PRE' && document.body.children.length === 1;
}

function getRawText() {
  return document.body.firstElementChild.textContent;
}

function slugify(text, used) {
  let base = text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!base) base = 'section';
  let slug = base;
  let i = 1;
  while (used.has(slug)) slug = `${base}-${i++}`;
  used.add(slug);
  return slug;
}

async function injectStyle(id, href) {
  const existing = document.getElementById(id);
  const res = await fetch(chrome.runtime.getURL(href));
  const css = await res.text();
  const style = existing || document.createElement('style');
  style.id = id;
  style.textContent = css;
  if (!existing) document.head.appendChild(style);
}

function resolveTheme(theme) {
  if (theme !== 'auto') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function codeThemeFile(codeTheme, resolved) {
  if (codeTheme === 'auto') return resolved === 'dark' ? 'github-dark' : 'github';
  return codeTheme;
}

class Viewer {
  constructor(raw, settings) {
    this.raw = raw;
    this.settings = settings;
    this.rawMode = false;
    this.editing = false;
    this.showPreview = false;
    this.draftKey = `mdr:draft:${location.href}`;
    this.marked = new Marked({ gfm: true, breaks: settings.lineBreaks });
  }

  renderHtml() {
    const dirty = this.marked.parse(this.raw);
    return DOMPurify.sanitize(dirty, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel', 'align', 'start', 'colspan', 'rowspan', 'checked', 'disabled'],
      FORBID_TAGS: ['style', 'form'],
      ALLOW_DATA_ATTR: false
    });
  }

  build() {
    const title = document.title || decodeURIComponent(location.pathname.split('/').pop());
    document.documentElement.setAttribute('data-md-reader', 'on');
    document.head.innerHTML = '';
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
    document.title = title;

    document.body.innerHTML = '';
    document.body.className = 'mdr-body';

    this.toc = document.createElement('nav');
    this.toc.className = 'mdr-toc';

    this.toolbar = this.buildToolbar();

    this.article = document.createElement('article');
    this.article.className = 'markdown-body mdr-content';
    this.article.innerHTML = this.renderHtml();

    this.rawPre = document.createElement('pre');
    this.rawPre.className = 'mdr-raw';
    this.rawPre.hidden = true;
    this.rawPre.textContent = this.raw;

    const main = document.createElement('main');
    main.className = 'mdr-main';
    this.editor = document.createElement('textarea');
    this.editor.className = 'mdr-editor';
    this.editor.spellcheck = false;
    this.editor.setAttribute('aria-label', 'Markdown エディタ');
    this.editor.addEventListener('input', () => this.onEdit());
    this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));

    this.pane = document.createElement('div');
    this.pane.className = 'mdr-editor-pane';
    this.pane.hidden = true;
    this.pane.append(this.buildEditTools(), this.editor);

    main.append(this.pane, this.article, this.rawPre);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.toggleEdit();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.openFile();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) e.preventDefault();
    });

    document.body.append(this.toolbar, this.toc, main);

    this.enhance();
    this.applySettings();
    this.restoreScroll();
  }

  buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'mdr-toolbar';
    const mk = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdr-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
      return b;
    };
    this.tocBtn = mk('☰', '目次の表示/非表示', () => this.toggleToc());
    this.themeBtn = mk('◐', 'テーマ切替 (自動 → ライト → ダーク)', () => this.cycleTheme());
    this.editBtn = mk('✎', 'エディタを開く (Ctrl+E)', () => this.toggleEdit());
    this.rawBtn = mk('</>', '元の Markdown を表示', () => this.toggleRaw());
    this.openBtn = mk('📂', 'ファイルを開く (Ctrl+O)', () => this.openFile());
    mk('🖨', '印刷', () => window.print());
    mk('⚙', '設定を開く', () => chrome.runtime.sendMessage({ type: 'open-options' }));
    return bar;
  }

  enhance() {
    const used = new Set();
    const headings = this.article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const tocList = document.createElement('ul');
    tocList.className = 'mdr-toc-list';
    const tocTitle = document.createElement('div');
    tocTitle.className = 'mdr-toc-title';
    tocTitle.textContent = '目次';
    this.toc.append(tocTitle, tocList);

    headings.forEach((h) => {
      const id = h.id || slugify(h.textContent, used);
      h.id = id;
      if (this.settings.headingAnchors) {
        const anchor = document.createElement('a');
        anchor.className = 'mdr-anchor';
        anchor.href = `#${id}`;
        anchor.setAttribute('aria-label', `${h.textContent} へのリンク`);
        anchor.textContent = '#';
        h.prepend(anchor);
      }
      const level = Number(h.tagName.slice(1));
      if (level <= 4) {
        const li = document.createElement('li');
        li.className = `mdr-toc-l${level}`;
        const a = document.createElement('a');
        a.href = `#${id}`;
        a.textContent = h.textContent.replace(/^#/, '').trim();
        li.appendChild(a);
        tocList.appendChild(li);
      }
    });
    if (!tocList.children.length) this.toc.classList.add('mdr-toc-empty');

    this.article.querySelectorAll('pre > code').forEach((code) => {
      const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
      try {
        if (lang && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value;
        } else {
          code.innerHTML = hljs.highlightAuto(code.textContent).value;
        }
        code.classList.add('hljs');
      } catch {
        /* ハイライトに失敗しても本文はそのまま表示する */
      }
      if (this.settings.copyCodeButton) this.addCopyButton(code.parentElement, code);
    });

    this.article.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.disabled = true;
    });

    this.article.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (/^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });

    this.setupScrollSpy();
  }

  addCopyButton(pre, code) {
    pre.classList.add('mdr-pre');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mdr-copy';
    btn.textContent = 'コピー';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'コピー済';
      } catch {
        btn.textContent = '失敗';
      }
      setTimeout(() => {
        btn.textContent = 'コピー';
      }, 1500);
    });
    pre.appendChild(btn);
  }

  setupScrollSpy() {
    const links = new Map();
    this.toc.querySelectorAll('a[href^="#"]').forEach((a) => {
      links.set(decodeURIComponent(a.getAttribute('href').slice(1)), a);
    });
    if (!links.size) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const link = links.get(e.target.id);
          if (!link) return;
          this.toc.querySelectorAll('.mdr-active').forEach((el) => el.classList.remove('mdr-active'));
          link.classList.add('mdr-active');
        });
      },
      { rootMargin: '0px 0px -75% 0px' }
    );
    this.article.querySelectorAll('h1, h2, h3, h4').forEach((h) => observer.observe(h));
  }

  applySettings() {
    const s = this.settings;
    const resolved = resolveTheme(s.theme);
    document.documentElement.dataset.mdrTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.style.setProperty('--mdr-width', `${s.contentWidth}px`);
    document.documentElement.style.setProperty('--mdr-font-size', `${s.fontSize}px`);
    document.body.classList.toggle('mdr-no-toc', !s.showToc);

    injectStyle('mdr-base', 'css/viewer.css');
    injectStyle(
      'mdr-github',
      resolved === 'dark' ? 'css/github-markdown-dark.css' : 'css/github-markdown-light.css'
    );
    injectStyle('mdr-hljs', `css/hljs/${codeThemeFile(s.codeTheme, resolved)}.min.css`);
  }

  toggleToc() {
    this.settings.showToc = !this.settings.showToc;
    document.body.classList.toggle('mdr-no-toc', !this.settings.showToc);
    saveSettings({ showToc: this.settings.showToc });
  }

  cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(this.settings.theme) + 1) % order.length];
    this.settings.theme = next;
    this.applySettings();
    saveSettings({ theme: next });
  }

  toggleRaw() {
    this.rawMode = !this.rawMode;
    this.article.hidden = this.rawMode;
    this.rawPre.hidden = !this.rawMode;
    this.rawBtn.textContent = this.rawMode ? '📄' : '</>';
    this.rawBtn.title = this.rawMode ? '描画結果を表示' : '元の Markdown を表示';
  }

  rerender() {
    this.article.innerHTML = this.renderHtml();
    this.toc.innerHTML = '';
    this.enhance();
  }

  toggleEdit() {
    this.editing = !this.editing;
    if (this.editing) {
      if (this.rawMode) this.toggleRaw();
      this.showPreview = false;
      this.editor.value = this.raw;
      this.offerDraft();
    }
    this.pane.hidden = !this.editing;
    this.editBtn.textContent = this.editing ? '👁' : '✎';
    this.editBtn.title = this.editing ? 'エディタを閉じる (Ctrl+E)' : 'エディタを開く (Ctrl+E)';
    if (this.editing) {
      this.saveBtn = this.saveBtn || this.addEditorButtons();
      this.saveBtn.hidden = false;
      this.paneBtn.hidden = false;
      this.editor.focus();
    } else if (this.saveBtn) {
      this.saveBtn.hidden = true;
      this.paneBtn.hidden = true;
    }
    this.applyLayout();
  }

  applyLayout() {
    const toggle = this.settings.editorLayout === 'toggle';
    const b = document.body.classList;
    b.toggle('mdr-editing', this.editing);
    b.toggle('mdr-edit-toggle', this.editing && toggle);
    b.toggle('mdr-show-preview', this.editing && toggle && this.showPreview);
    if (this.paneBtn) {
      this.paneBtn.classList.toggle('mdr-hidden-btn', !toggle);
      this.paneBtn.textContent = this.showPreview ? '✎' : '👁';
      this.paneBtn.title = this.showPreview ? 'エディタに切替' : 'プレビューに切替';
    }
  }

  togglePane() {
    this.showPreview = !this.showPreview;
    if (!this.showPreview) this.editor.focus();
    this.applyLayout();
  }

  addEditorButtons() {
    const mk = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdr-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      this.toolbar.prepend(b);
      return b;
    };
    this.paneBtn = mk('👁', 'プレビューに切替', () => this.togglePane());
    return mk('💾', '上書き保存 (Ctrl+S)', () => this.save());
  }

  buildEditTools() {
    const bar = document.createElement('div');
    bar.className = 'mdr-edit-tools';
    const tools = [
      ['B', '太字 (Ctrl+B)', () => this.wrap('**', '**', 'text')],
      ['I', '斜体 (Ctrl+I)', () => this.wrap('*', '*', 'text')],
      ['S', '取り消し線', () => this.wrap('~~', '~~', 'text')],
      ['H', '見出し', () => this.prefixLines('## ')],
      ['•', '箇条書き', () => this.prefixLines('- ')],
      ['1.', '番号付きリスト', () => this.prefixLines('1. ')],
      ['☑', 'タスクリスト', () => this.prefixLines('- [ ] ')],
      ['❝', '引用', () => this.prefixLines('> ')],
      ['`', 'インラインコード', () => this.wrap('`', '`', 'code')],
      ['{ }', 'コードブロック', () => this.insertCodeBlock()],
      ['🔗', 'リンク (Ctrl+K)', () => this.insertLink()],
      ['▦', '表', () => this.insertTable()]
    ];
    for (const [label, title, fn] of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdr-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        fn();
        this.editor.focus();
      });
      bar.appendChild(b);
    }
    return bar;
  }

  replaceRange(start, end, text, selStart, selEnd) {
    const ta = this.editor;
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand は Undo 履歴を保つ。失敗時は setRangeText にフォールバック
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, start, end, 'end');
    }
    ta.setSelectionRange(selStart, selEnd);
    this.onEdit();
  }

  wrap(before, after, placeholder) {
    const ta = this.editor;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b) || placeholder;
    this.replaceRange(a, b, before + sel + after, a + before.length, a + before.length + sel.length);
  }

  prefixLines(prefix) {
    const ta = this.editor;
    const v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let b = v.indexOf('\n', ta.selectionEnd);
    if (b === -1) b = v.length;
    let n = 0;
    const text = v
      .slice(a, b)
      .split('\n')
      .map((line) => {
        n++;
        return (prefix === '1. ' ? `${n}. ` : prefix) + line;
      })
      .join('\n');
    this.replaceRange(a, b, text, a, a + text.length);
  }

  insertCodeBlock() {
    const ta = this.editor;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b);
    const lead = a > 0 && value[a - 1] !== '\n' ? '\n' : '';
    const head = `${lead}\`\`\`\n`;
    this.replaceRange(a, b, `${head}${sel}\n\`\`\`\n`, a + head.length, a + head.length + sel.length);
  }

  insertTable() {
    const ta = this.editor;
    const a = ta.selectionStart;
    const lead = a > 0 && ta.value[a - 1] !== '\n' ? '\n\n' : '';
    const table = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n';
    this.replaceRange(a, ta.selectionEnd, lead + table, a + lead.length + 2, a + lead.length + 5);
  }

  insertLink() {
    const ta = this.editor;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b) || 'リンクテキスト';
    const text = `[${sel}](https://)`;
    const urlStart = a + sel.length + 3;
    this.replaceRange(a, b, text, urlStart, urlStart + 8);
  }

  continueList(e) {
    const ta = this.editor;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const pos = ta.selectionStart;
    const v = ta.value;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(ls, pos);
    const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/);
    if (!m) {
      const indent = line.match(/^\s+/);
      if (!indent) return false;
      e.preventDefault();
      const ins = `\n${indent[0]}`;
      this.replaceRange(pos, pos, ins, pos + ins.length, pos + ins.length);
      return true;
    }
    e.preventDefault();
    const [, indent, bullet, num, delim, space, task, rest] = m;
    if (!rest.trim() && !task) {
      // 空の項目で Enter: リストを終了する
      this.replaceRange(ls, pos, '', ls, ls);
      return true;
    }
    const marker = bullet || `${Number(num) + 1}${delim}`;
    const ins = `\n${indent}${marker}${space}${task ? '[ ] ' : ''}`;
    this.replaceRange(pos, pos, ins, pos + ins.length, pos + ins.length);
    return true;
  }

  async offerDraft() {
    if (!this.settings.autoSave) return;
    let draft = null;
    try {
      draft = localStorage.getItem(this.draftKey);
    } catch {
      return;
    }
    if (draft !== null && draft !== this.raw && confirm('保存されていない下書きがあります。復元しますか?')) {
      this.raw = draft;
      this.editor.value = draft;
      this.rawPre.textContent = draft;
      this.dirty = true;
      this.rerender();
    }
  }

  onEdit() {
    this.raw = this.editor.value;
    this.dirty = true;
    this.rawPre.textContent = this.raw;
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => this.rerender(), 200);
    if (!this.settings.autoSave) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.draftKey, this.raw);
      } catch {
        /* 容量超過などは無視 */
      }
    }, 300);
    if (this.fileHandle) {
      clearTimeout(this.fileTimer);
      this.fileTimer = setTimeout(() => this.writeToHandle().catch(() => {}), 1500);
    }
  }

  onEditorKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && key === 's') {
      e.preventDefault();
      this.save();
    } else if (mod && !e.shiftKey && key === 'b') {
      e.preventDefault();
      this.wrap('**', '**', 'text');
    } else if (mod && !e.shiftKey && key === 'i') {
      e.preventDefault();
      this.wrap('*', '*', 'text');
    } else if (mod && !e.shiftKey && key === 'k') {
      e.preventDefault();
      this.insertLink();
    } else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.isComposing) {
      this.continueList(e);
    } else if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const ta = this.editor;
      this.replaceRange(ta.selectionStart, ta.selectionEnd, '  ', ta.selectionStart + 2, ta.selectionStart + 2);
    }
  }

  setContent(text) {
    this.raw = text;
    this.editor.value = text;
    this.rawPre.textContent = text;
    this.rerender();
  }

  async openFile() {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx', '.rmd', '.txt'] } }]
        });
        const file = await handle.getFile();
        this.fileHandle = handle;
        this.fileName = file.name;
        this.setContent(await file.text());
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.md,.markdown,.mdown,.mkd,.mkdn,.mdx,.rmd,.txt,text/*';
        input.addEventListener('change', async () => {
          const file = input.files[0];
          if (!file) return;
          this.fileHandle = null;
          this.fileName = file.name;
          this.setContent(await file.text());
        });
        input.click();
      }
      this.dirty = false;
      if (!this.editing) this.toggleEdit();
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn('[Markdown Reader] open failed', err);
    }
  }

  async writeToHandle() {
    const w = await this.fileHandle.createWritable();
    await w.write(this.raw);
    await w.close();
    this.dirty = false;
    try {
      localStorage.removeItem(this.draftKey);
    } catch {
      /* 無視 */
    }
  }

  async save() {
    const name = this.fileName || decodeURIComponent(location.pathname.split('/').pop()) || 'document.md';
    try {
      if (window.showSaveFilePicker) {
        if (!this.fileHandle) {
          this.fileHandle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
          });
        }
        await this.writeToHandle();
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([this.raw], { type: 'text/markdown' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        this.dirty = false;
      }
    } catch (err) {
      if (err?.name !== 'AbortError') this.fileHandle = null;
    }
  }

  restoreScroll() {
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) {
        target.scrollIntoView();
        return;
      }
    }
    if (!this.settings.rememberScroll) return;
    const key = `mdr:scroll:${location.href}`;
    const saved = Number(sessionStorage.getItem(key) || 0);
    if (saved) window.scrollTo(0, saved);
    let timer = null;
    window.addEventListener(
      'scroll',
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => sessionStorage.setItem(key, String(window.scrollY)), 200);
      },
      { passive: true }
    );
  }

  update(settings) {
    const needsRerender =
      settings.lineBreaks !== this.settings.lineBreaks ||
      settings.copyCodeButton !== this.settings.copyCodeButton ||
      settings.headingAnchors !== this.settings.headingAnchors;
    this.settings = settings;
    if (needsRerender) {
      this.marked = new Marked({ gfm: true, breaks: settings.lineBreaks });
      this.rerender();
    }
    this.applySettings();
    this.applyLayout();
  }
}

function showActivateButton(onActivate) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Markdown として表示';
  Object.assign(btn.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483647',
    padding: '8px 14px',
    font: '14px/1.4 system-ui, sans-serif',
    background: '#0969da',
    color: '#fff',
    border: '0',
    borderRadius: '6px',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,.3)'
  });
  btn.addEventListener('click', () => onActivate());
  document.body.appendChild(btn);
}

async function main() {
  if (!isPlainTextDocument()) return;
  if (!hasMarkdownExtension(location.href) && !/^file:/.test(location.href)) return;

  const settings = await loadSettings();
  const raw = getRawText();
  const isRemote = /^https?:/.test(location.protocol) || /^https?:/.test(location.href);
  const blocked = settings.blockedOrigins.includes(location.origin);

  const start = () => {
    const viewer = new Viewer(raw, settings);
    viewer.build();
    window.__mdReaderViewer = viewer;
    chrome.storage.onChanged.addListener(async () => {
      viewer.update(await loadSettings());
    });
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => viewer.applySettings());
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'toggle-raw') viewer.toggleRaw();
      if (msg?.type === 'toggle-toc') viewer.toggleToc();
      if (msg?.type === 'cycle-theme') viewer.cycleTheme();
      if (msg?.type === 'status') sendResponse({ active: true, rawMode: viewer.rawMode });
      return false;
    });
  };

  if (isRemote && (!settings.autoRenderRemote || blocked)) {
    showActivateButton(start);
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'render-now') start();
      return false;
    });
    return;
  }
  start();
}

main();

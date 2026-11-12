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
    main.append(this.article, this.rawPre);

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
    this.rawBtn = mk('</>', '元の Markdown を表示', () => this.toggleRaw());
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
      this.article.innerHTML = this.renderHtml();
      this.toc.innerHTML = '';
      this.enhance();
    }
    this.applySettings();
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

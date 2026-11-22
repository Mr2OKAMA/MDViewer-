import { loadSettings } from './settings.js';
import { Viewer } from './viewer.js';

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

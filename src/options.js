import { DEFAULTS, loadSettings, saveSettings } from './settings.js';

const CHECKBOXES = [
  'showToc',
  'headingAnchors',
  'copyCodeButton',
  'rememberScroll',
  'lineBreaks',
  'autoSave',
  'autoRenderRemote'
];
const SELECTS = ['theme', 'codeTheme', 'editorLayout'];
const RANGES = ['contentWidth', 'fontSize'];

const $ = (id) => document.getElementById(id);

function showStatus(text) {
  const el = $('status');
  el.textContent = text;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    el.textContent = '';
  }, 1500);
}

function fill(settings) {
  CHECKBOXES.forEach((id) => {
    $(id).checked = Boolean(settings[id]);
  });
  SELECTS.forEach((id) => {
    $(id).value = settings[id];
  });
  RANGES.forEach((id) => {
    $(id).value = settings[id];
    $(`${id}Out`).textContent = settings[id];
  });
  $('blockedOrigins').value = (settings.blockedOrigins || []).join('\n');
}

function parseOrigins(text) {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

async function persist(patch) {
  await saveSettings(patch);
  showStatus('保存しました');
}

async function init() {
  fill(await loadSettings());

  CHECKBOXES.forEach((id) => {
    $(id).addEventListener('change', (e) => persist({ [id]: e.target.checked }));
  });
  SELECTS.forEach((id) => {
    $(id).addEventListener('change', (e) => persist({ [id]: e.target.value }));
  });
  RANGES.forEach((id) => {
    $(id).addEventListener('input', (e) => {
      $(`${id}Out`).textContent = e.target.value;
      persist({ [id]: Number(e.target.value) });
    });
  });
  $('blockedOrigins').addEventListener('change', (e) =>
    persist({ blockedOrigins: parseOrigins(e.target.value) })
  );
  $('reset').addEventListener('click', async () => {
    await saveSettings(DEFAULTS);
    fill(DEFAULTS);
    showStatus('既定値に戻しました');
  });
}

init();

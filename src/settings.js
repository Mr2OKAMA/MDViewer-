export const DEFAULTS = {
  theme: 'auto',               // 'light' | 'dark' | 'auto'
  codeTheme: 'auto',         // 'auto' | 'github' | 'github-dark' | 'a11y-light' | 'a11y-dark' | 'monokai' | 'nord'
  contentWidth: 980,           // px
  fontSize: 16,                // px
  showToc: true,
  autoRenderRemote: true,      // http(s) 上の .md を自動描画
  blockedOrigins: [],          // 自動描画しないオリジン
  copyCodeButton: true,
  headingAnchors: true,
  rememberScroll: true,
  lineBreaks: false            // 改行を <br> に変換 (GFM 風)
};

export async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    const stored = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  }
}

export async function saveSettings(patch) {
  try {
    await chrome.storage.sync.set(patch);
  } catch {
    await chrome.storage.local.set(patch);
  }
}

/** 拡張機能内の Markdown 専用エディタページ (src/editor.html) */
import { loadSettings } from './settings.js';
import { Viewer } from './viewer.js';

async function main() {
  const settings = await loadSettings();
  const viewer = new Viewer('', settings, { standalone: true });
  viewer.build();
  viewer.toggleEdit();
  window.__mdReaderViewer = viewer;
  // ポップアップの「新規作成」から開かれた場合 (?new) はテンプレート選択を表示する
  const params = new URLSearchParams(location.search);
  if (params.has('new')) {
    history.replaceState(null, '', location.pathname);
    viewer.showTemplatePicker();
  }
  chrome.storage.onChanged.addListener(async () => {
    viewer.update(await loadSettings());
  });
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => viewer.applySettings());
}

main();

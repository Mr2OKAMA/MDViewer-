const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    return null;
  }
}

async function init() {
  const status = await send('status');
  $('state').textContent = status?.active
    ? 'このページを描画中です。'
    : 'このページでは描画していません (.md ファイルを開いてください)。';
  $('render').hidden = Boolean(status?.active);

  $('render').addEventListener('click', async () => {
    await send('render-now');
    window.close();
  });
  $('toc').addEventListener('click', () => send('toggle-toc'));
  $('theme').addEventListener('click', () => send('cycle-theme'));
  $('raw').addEventListener('click', async () => {
    await send('toggle-raw');
    window.close();
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html?welcome=1') });
  }
});

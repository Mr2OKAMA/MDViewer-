/**
 * README 用のスクリーンショットを docs/ に生成する。
 *   npm run screenshots   (事前に npm run build)
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sample = await readFile(path.join(root, 'SAMPLE.md'), 'utf8');
const out = (name) => path.join(root, 'docs', name);
const VIEWPORT = { width: 1280, height: 800 };

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(sample);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/SAMPLE.md`;

const profile = await mkdtemp(path.join(tmpdir(), 'mdr-shot-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  args: [
    '--no-sandbox',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`
  ]
});

async function openViewer(scheme) {
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(url);
  await page.waitForSelector('article.markdown-body');
  await page.waitForTimeout(500);
  return page;
}

// ツールバーは通常半透明なので、撮影時は不透明にしてはっきり見せる
const showToolbar = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.mdr-toolbar');
    bar.style.transition = 'none';
    bar.style.opacity = '1';
  });

try {
  for (const scheme of ['light', 'dark']) {
    const page = await openViewer(scheme);
    await showToolbar(page);
    await page.screenshot({ path: out(`screenshot-${scheme}.png`) });
    await page.close();
  }

  const page = await openViewer('light');
  await page.keyboard.press('Control+e');
  const ed = page.locator('textarea.mdr-editor');
  await ed.waitFor();
  // コードブロック付近までスクロールし、カーソルを関数の引数に置く
  const pos = sample.indexOf('greet(name)') + 'greet(na'.length;
  await ed.evaluate((el, p) => {
    el.focus();
    el.setSelectionRange(p, p);
    el.scrollTop = 0;
    el.dispatchEvent(new Event('click'));
  }, pos);
  await page.waitForTimeout(500);
  await showToolbar(page);
  await page.screenshot({ path: out('screenshot-editor.png') });

  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(300);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await showToolbar(page);
  await page.screenshot({ path: out('screenshot-editor-dark.png') });
  // プレビュー表示の設定を元に戻す
  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(300);
  await page.close();

  const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/src/popup.html`);
  await popup.waitForTimeout(300);
  // .md を表示中のタブで開いたときの表示を再現する
  await popup.evaluate(() => {
    document.getElementById('state').textContent = 'このページを描画中です。';
    document.getElementById('render').hidden = true;
  });
  const box = await popup.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await popup.screenshot({ path: out('screenshot-popup.png'), clip: { x: 0, y: 0, ...box } });
} finally {
  await ctx.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
console.log('screenshots done');

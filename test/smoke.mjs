/**
 * 実ブラウザ (Chromium 系) に拡張機能を読み込み、.md が正しく描画されるかを検証する。
 *   node test/smoke.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SAMPLE = `# 見出し1

テスト段落と **強調**、\`inline code\`、[リンク](https://example.com)。

## 見出し2

- [x] 完了タスク
- [ ] 未完了タスク

| 列A | 列B |
| --- | --- |
| 1   | 2   |

\`\`\`js
const greet = (name) => \`hello \${name}\`;
\`\`\`

<script>window.__xss = true;</script>
<img src=x onerror="window.__xss2 = true">

### 見出し3
`;

const DECOY_HTML =
  '<!doctype html><meta charset="utf-8"><title>decoy</title><h1 id="decoy">plain html</h1>';

const checks = [];
const check = (name, ok, extra = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` -> ${extra}` : ''}`);
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/sample.md') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(SAMPLE);
  } else if (url === '/decoy.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DECOY_HTML);
  } else if (url === '/readme.md') {
    // Content-Type が text/markdown のケース
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end('# markdown content type\n\n本文');
  } else {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(path.join(tmpdir(), 'mdr-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`
  ]
});

try {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/sample.md`);
  await page.waitForSelector('article.markdown-body', { timeout: 15000 });

  check('見出しが h1 として描画される', (await page.locator('article h1').count()) === 1);
  check('テーブルが描画される', (await page.locator('article table td').count()) === 2);
  check('タスクリストが描画される', (await page.locator('article input[type=checkbox]').count()) === 2);
  check(
    'タスクリストは編集不可',
    await page.locator('article input[type=checkbox]').first().isDisabled()
  );
  check('コードがハイライトされる', (await page.locator('article pre code span').count()) > 0);
  check('コピーボタンがある', (await page.locator('article pre .mdr-copy').count()) === 1);
  check('目次が生成される', (await page.locator('nav.mdr-toc a').count()) === 3);
  check('見出しアンカーが付く', (await page.locator('article h2 a.mdr-anchor').count()) === 1);
  check('ツールバーがある', (await page.locator('.mdr-toolbar .mdr-btn').count()) === 7);
  check('GitHub スタイルが適用される', (await page.locator('style#mdr-github').count()) === 1);
  check('XSS: script が実行されない', (await page.evaluate(() => window.__xss)) === undefined);
  check('XSS: onerror が除去される', (await page.locator('article img[onerror]').count()) === 0);
  check(
    '外部リンクは別タブで開く',
    (await page.locator('article a[href^="https://example.com"]').getAttribute('target')) ===
      '_blank'
  );

  const tocHref = await page.locator('nav.mdr-toc a').nth(1).getAttribute('href');
  check('目次リンクが見出し ID と一致', (await page.locator(`article ${tocHref}`).count()) === 1, tocHref);

  await page.locator('.mdr-toolbar .mdr-btn', { hasText: '</>' }).click();
  check('生 Markdown 表示に切り替わる', await page.locator('pre.mdr-raw').isVisible());

  await page.locator('.mdr-toolbar .mdr-btn', { hasText: '📄' }).click();
  await page.locator('.mdr-toolbar .mdr-btn', { hasText: '✎' }).click();
  const ed = page.locator('textarea.mdr-editor');
  check('エディタが開く', await ed.isVisible());
  await ed.fill('- a');
  await ed.press('End');
  await ed.press('Enter');
  await ed.type('b');
  check('リストが自動継続される', (await ed.inputValue()) === '- a\n- b');
  await ed.press('Control+a');
  await ed.press('Control+b');
  check('Ctrl+B で太字', (await ed.inputValue()) === '**- a\n- b**');
  await page.waitForTimeout(400);
  check('プレビューが更新される', (await page.locator('article').innerText()).includes('a'));
  await page.locator('.mdr-edit-tools .mdr-btn[title="表"]').click();
  check('表を挿入できる', (await ed.inputValue()).includes('| --- |'));
  await page.locator('.mdr-toolbar .mdr-btn', { hasText: '👁' }).last().click();
  check('エディタを閉じられる', !(await ed.isVisible()));

  await page.locator('.mdr-toolbar .mdr-btn[title^="目次"]').click();
  await page.waitForTimeout(150);
  check('目次を非表示にできる', !(await page.locator('nav.mdr-toc').isVisible()));

  check('ページ内 JS エラーなし', errors.length === 0, errors.join(' | '));

  const page2 = await ctx.newPage();
  await page2.goto(`${base}/decoy.html`);
  await page2.waitForTimeout(400);
  check('HTML ページは書き換えない', (await page2.locator('#decoy').count()) === 1);

  const page3 = await ctx.newPage();
  await page3.emulateMedia({ colorScheme: 'dark' });
  await page3.goto(`${base}/readme.md`);
  await page3.waitForSelector('article.markdown-body', { timeout: 15000 });
  check('text/markdown でも描画される', (await page3.locator('article h1').count()) === 1);
  check(
    'OS 設定に合わせてダークになる',
    (await page3.locator('html').getAttribute('data-mdr-theme')) === 'dark'
  );
} finally {
  await ctx.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);

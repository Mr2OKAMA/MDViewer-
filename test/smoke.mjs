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

  await ed.fill('# Title\n\n```js\nfunction greet(name, age) { return name; }\n```\n- [ ] **todo** [link](https://example.com)\n');
  const hl = page.locator('.mdr-hl');
  check('エディタ: 見出しが色分けされる', (await hl.locator('.mdh-heading').count()) === 1);
  check('エディタ: コード内の関数名が色分けされる', (await hl.locator('.hljs-title').count()) > 0);
  check('エディタ: コード内の引数が色分けされる', (await hl.locator('.hljs-params').innerText()) === 'name, age');
  check(
    'エディタ: リスト・リンク・太字が色分けされる',
    (await hl.locator('.mdh-list').count()) === 1 &&
      (await hl.locator('.mdh-url').count()) === 1 &&
      (await hl.locator('.mdh-strong').count()) === 1
  );
  check(
    'エディタ: ハイライト層の文字が入力と一致する',
    (await hl.evaluate((el) => el.textContent.replace(/\n \n $/, ''))) === (await ed.inputValue())
  );
  const geom = await page.evaluate(() => {
    const ta = document.querySelector('textarea.mdr-editor');
    const pre = document.querySelector('.mdr-hl');
    return { ta: ta.clientWidth, pre: pre.clientWidth };
  });
  check('エディタ: ハイライト層と入力欄の幅が一致する', geom.ta === geom.pre, JSON.stringify(geom));

  const article = page.locator('article.markdown-body');
  check('編集中はプレビューが表示される', await article.isVisible());
  const narrow = (await ed.boundingBox()).width;
  await page.locator('.mdr-toolbar .mdr-btn[title^="プレビューを隠す"]').click();
  check('プレビューを非表示にできる', !(await article.isVisible()));
  check('プレビュー非表示でエディタが広がる', (await ed.boundingBox()).width > narrow);
  await ed.press('Alt+p');
  check('Alt+P でプレビューを再表示できる', await article.isVisible());
  await ed.press('Alt+p');
  check('Alt+P でプレビューを隠せる', !(await article.isVisible()));
  await ed.type('extra');
  await page.locator('.mdr-toolbar .mdr-btn[title^="プレビューを表示"]').click();
  await page.waitForTimeout(100);
  check('再表示時にプレビューが最新になる', (await article.innerText()).includes('extra'));

  await page.locator('.mdr-toolbar .mdr-btn', { hasText: '📖' }).click();
  check('エディタを閉じられる', !(await ed.isVisible()));

  await page.locator('.mdr-toolbar .mdr-btn[title^="目次"]').click();
  await page.waitForTimeout(150);
  check('目次を非表示にできる', !(await page.locator('nav.mdr-toc').isVisible()));

  check('ページ内 JS エラーなし', errors.length === 0, errors.join(' | '));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const editorPage = await ctx.newPage();
  const editorErrors = [];
  editorPage.on('pageerror', (e) => editorErrors.push(String(e)));
  await editorPage.goto(`chrome-extension://${extId}/src/editor.html`);
  const sEd = editorPage.locator('textarea.mdr-editor');
  await sEd.waitFor({ timeout: 15000 });
  check('専用エディタ: ページが開きエディタが表示される', await sEd.isVisible());
  await sEd.fill('# 専用エディタ\n\n```python\ndef add(a, b):\n    return a + b\n```\n');
  await editorPage.waitForTimeout(400);
  check('専用エディタ: プレビューが描画される', (await editorPage.locator('article h1').innerText()).includes('専用エディタ'));
  check('専用エディタ: コードが色分けされる', (await editorPage.locator('.mdr-hl .hljs-title').count()) > 0);
  check('専用エディタ: 未保存がタイトルに表示される', (await editorPage.title()).startsWith('●'));
  check('専用エディタ: ステータスバーに行・列が出る', (await editorPage.locator('.mdr-edit-status').innerText()).includes('行 '));
  await editorPage.reload();
  await sEd.waitFor({ timeout: 15000 });
  await editorPage.waitForTimeout(200);
  check('専用エディタ: 再読込で下書きが復元される', (await sEd.inputValue()).startsWith('# 専用エディタ'));
  editorPage.on('dialog', (d) => d.accept());
  await editorPage.locator('.mdr-toolbar .mdr-btn', { hasText: '🆕' }).click();
  const picker = editorPage.locator('dialog.mdr-picker');
  check('専用エディタ: 新規作成でテンプレート選択が開く', await picker.isVisible());
  check('専用エディタ: 白紙と作業手順書を選べる', (await picker.locator('.mdr-picker-item').count()) >= 2);
  await picker.locator('.mdr-picker-item[data-template="work-procedure"]').click();
  await editorPage.waitForTimeout(300);
  check('専用エディタ: テンプレート選択後にダイアログが閉じる', !(await picker.isVisible()));
  check('専用エディタ: 作業手順書テンプレートが入る', (await sEd.inputValue()).startsWith('# 作業手順書'));
  check(
    '専用エディタ: テンプレートに今日の日付が入る',
    (await sEd.inputValue()).includes(await editorPage.evaluate(() => new Date().toLocaleDateString('sv-SE')))
  );
  check('専用エディタ: テンプレートがプレビューされる', (await editorPage.locator('article h2').count()) >= 9);
  await editorPage.locator('.mdr-toolbar .mdr-btn', { hasText: '🆕' }).click();
  await picker.locator('.mdr-picker-item[data-template="field-procedure"]').click();
  {
    const v = await sEd.inputValue();
    check(
      '専用エディタ: 現場向け手順書に必要な項目がある',
      ['管理番号', '作成日', '分類', '施設名', '特記事項', '必要工具・保護具', '文書作成者', '作業責任者', '承認者', '作業手順', '改訂履歴'].every((k) => v.includes(k))
    );
  }
  await editorPage.locator('.mdr-toolbar .mdr-btn', { hasText: '🆕' }).click();
  await picker.locator('.mdr-picker-item[data-template="office-procedure"]').click();
  {
    const v = await sEd.inputValue();
    check(
      '専用エディタ: 事務向け手順書に転記対応表と提出前チェックがある',
      v.startsWith('# 事務作業手順書') && v.includes('転記対応表') && v.includes('提出前チェックリスト')
    );
  }
  await editorPage.locator('.mdr-toolbar .mdr-btn', { hasText: '🆕' }).click();
  await picker.locator('.mdr-picker-item[data-template="blank"]').click();
  check('専用エディタ: 白紙で新規作成できる', (await sEd.inputValue()) === '');
  await editorPage.goto(`chrome-extension://${extId}/src/editor.html?new`);
  await sEd.waitFor({ timeout: 15000 });
  check('専用エディタ: ?new でテンプレート選択が開く', await picker.isVisible());
  check('専用エディタ: JS エラーなし', editorErrors.length === 0, editorErrors.join(' | '));

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

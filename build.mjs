import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const HLJS_THEMES = ['github', 'github-dark', 'a11y-light', 'a11y-dark', 'monokai', 'nord'];

async function bundle() {
  await build({
    entryPoints: {
      content: 'src/content.js',
      options: 'src/options.js',
      popup: 'src/popup.js',
      background: 'src/background.js'
    },
    bundle: true,
    format: 'iife',
    target: ['chrome111'],
    minify: true,
    legalComments: 'none',
    outdir: 'dist',
    logLevel: 'info'
  });
}

async function copyAssets() {
  await mkdir(path.join(root, 'css/hljs'), { recursive: true });
  await cp(
    'node_modules/github-markdown-css/github-markdown-light.css',
    'css/github-markdown-light.css'
  );
  await cp(
    'node_modules/github-markdown-css/github-markdown-dark.css',
    'css/github-markdown-dark.css'
  );
  for (const theme of HLJS_THEMES) {
    await cp(`node_modules/highlight.js/styles/${theme}.min.css`, `css/hljs/${theme}.min.css`);
  }
}

async function writeLicenses() {
  const pkgs = ['marked', 'dompurify', 'highlight.js', 'github-markdown-css'];
  const parts = [];
  for (const pkg of pkgs) {
    const dir = `node_modules/${pkg}`;
    const pj = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
    let text = '';
    for (const name of ['LICENSE', 'LICENSE.md', 'license', 'LICENSE.txt']) {
      try {
        text = await readFile(`${dir}/${name}`, 'utf8');
        break;
      } catch {
        /* 次の候補を試す */
      }
    }
    parts.push(`# ${pkg} ${pj.version} (${pj.license})\n\n${text.trim()}\n`);
  }
  await writeFile('THIRD_PARTY_LICENSES.md', parts.join('\n---\n\n'));
}

await rm('dist', { recursive: true, force: true });
await copyAssets();
await bundle();
await writeLicenses();
console.log('build done');

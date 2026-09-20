import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonValidity, validityHtml } from '../benchmarks/comparison-validity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs');
const output = join(root, 'dist');
const run = 'benchmarks/results/2026-09-20-main-ca1c0eb';
const review = `${run}/document-review`;
const repo = 'https://github.com/iwasa-kosui/tanteki/blob/main/';
const read = (path) => readFile(join(root, path), 'utf8');
const escape = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function build() {
  const manifest = JSON.parse(await read(`${run}/manifest.json`));
  if (comparisonValidity(manifest.fingerprint).status !== 'invalid') {
    throw new Error('The withdrawn-results page requires an invalidated run; review the page before selecting another dataset.');
  }
  const template = await read('docs/index.html');
  const placeholder = '<!-- COMPARISON_NOTICE -->';
  if (template.split(placeholder).length !== 2) throw new Error(`Expected one ${placeholder}`);
  const html = template.replace(placeholder, validityHtml(manifest.fingerprint));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.html'), html);
  for (const file of ['styles.css', 'site.js', 'favicon.svg']) await cp(join(source, file), join(output, file));
  await writeFile(join(output, '.nojekyll'), '');
  // Its styles, scripts, source and outputs are inline; point file links back to
  // their canonical repository location instead of shipping unrelated records.
  const report = (await read(`${review}/comparison.html`))
    .replace(/href="([^"#]+)"/g, (attribute, url) => /^[a-z]+:/i.test(url)
      ? attribute : `href="${escape(new URL(url, `${repo}${review}/`).href)}"`)
    .replace('<body>', '<body><nav style="padding:16px"><a href="./">← tanteki の紹介へ戻る</a></nav>');
  if (!report.includes('比較無効')) throw new Error('Regenerate the archived review with its invalidation notice before building.');
  await writeFile(join(output, 'evaluation.html'), report);
  const prose = html
    .replace(/<head>[\s\S]*?<\/head>/g, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, content) => `\n\n\`\`\`text\n${content.replace(/<[^>]*>/g, '')}\n\`\`\`\n\n`)
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(?:br|\/p|\/h[1-6]|\/div|\/li|\/dt|\/dd|\/caption|\/th|\/td|\/label|\/option|\/button|\/summary)[^>]*>/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(join(root, '.cache/site-copy.md'), `${prose}\n`);
  console.log('Built dist/: withdrawn comparison notice, archived evaluation, and site copy for textlint.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();

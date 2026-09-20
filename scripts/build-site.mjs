import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../benchmarks/readable-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs');
const output = join(root, 'dist');
const run = 'benchmarks/results/2026-09-20-main-ca1c0eb';
const review = `${run}/document-review`;
const repo = 'https://github.com/iwasa-kosui/tanteki/blob/main/';
const read = (path) => readFile(join(root, path), 'utf8');
const escape = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function build() {
  const examples = JSON.parse(await read('docs/examples.json'));
  const cases = JSON.parse(await read(`${run}/cases.json`));
  const summary = JSON.parse(await read(`${review}/summary.json`));
  const { summary: authoring } = JSON.parse(await read(`${run}/summary.json`));
  const panels = [];
  // Keep an inspectable Markdown version of the exact page prose for textlint.
  const exampleCopy = [];
  for (const example of examples) {
    const task = cases.find(({ id }) => id === example.id);
    if (!task) throw new Error(`Missing source case: ${example.id}`);
    const documents = [];
    for (const [arm, name, label] of [['without_skill', 'before', 'スキルなし'], ['with_skill', 'after', 'tanteki あり']]) {
      const path = `${review}/artifacts/${example.id}.1.${arm}.md`;
      const body = await read(path);
      let html = renderMarkdown(body);
      for (const [index, item] of example[name].highlight.entries()) {
        if (typeof item.text !== 'string' || !item.text) throw new Error(`Missing highlight text in ${example.id}.${name}[${index}]`);
        if (typeof item.note !== 'string' || !item.note) throw new Error(`Missing highlight note in ${example.id}.${name}[${index}]`);
        const needle = escape(item.text);
        const occurrences = html.split(needle).length - 1;
        if (occurrences === 0) throw new Error(`Missing highlight in ${path}: ${item.text}`);
        if (occurrences >= 2) throw new Error(`Ambiguous highlight in ${path}: "${item.text}" occurs ${occurrences} times, use a longer, unique string`);
        const label = '比較のポイント';
        html = html.replace(needle, `<mark>${needle}</mark><span class="change-note" role="note"><span class="change-note-label">${label}</span>${escape(item.note)}</span>`);
      }
      documents.push(`<div class="document ${name}"><p class="document-label" id="label-${example.id}-${name}"><b>${name.toUpperCase()}</b><span${name === 'after' ? ' class="badge"' : ''}>${label}</span><span class="full-text-label">全文</span></p><div class="document-scroll" role="region" aria-labelledby="label-${example.id}-${name}" tabindex="0"><blockquote cite="${repo}${path}">${html}</blockquote></div></div>`);
    }
    panels.push(`<section class="example-panel" id="example-${example.id}" aria-label="${escape(example.tab)}の比較">
      <div class="example-title"><h3>${escape(example.title)}</h3><span>${escape(example.scope)}</span></div>
      <div class="comparison">${documents.join('\n')}</div>
      <p class="comparison-insight"><strong>読み比べるポイント</strong><span>${escape(example.insight)}</span></p>
      <div class="example-source"><details><summary>この文書への依頼・原資料を読む</summary><p>${escape(task.prompt).replaceAll('\n', '<br>')}</p></details><a href="./evaluation.html#${example.id}.1">評価の詳細 ↗</a></div>
    </section>`);
    const notes = [...example.before.highlight, ...example.after.highlight].map(({ note }) => note);
    exampleCopy.push(`## ${example.tab}\n\n${example.title}\n\n${example.insight}\n\n${notes.join('\n\n')}\n`);
  }
  const tabs = `<div class="example-tabs" aria-label="比較する文書" hidden>${examples.map((example, index) => `<button type="button" id="tab-${example.id}" data-example-tab aria-controls="example-${example.id}"><span>0${index + 1}</span>${escape(example.tab)}</button>`).join('')}</div>`;
  const rows = [['usable', '用途を満たす'], ['revision_needed', '文書の修正が必要'], ['source_limited', '原資料の不足で利用に制限']].map(([status, name]) => `<tr><th scope="row">${name}</th><td>${summary.counts.without_skill[status]}</td><td>${summary.counts.with_skill[status]}</td></tr>`).join('');
  const metrics = [
    ['全5基準に合格', (arm) => `${arm.allCriteriaPass}/${arm.n}`],
    ['最終稿のlint合格', (arm) => `${arm.finalLintPass}/${arm.n}`],
    ['平均本文文字数', (arm) => (arm.finalCharacters / arm.n).toFixed(1)],
    ['生成呼び出し数', (arm) => arm.calls.toLocaleString('ja-JP')],
    ['入力トークン', (arm) => arm.inputTokens.toLocaleString('ja-JP')],
    ['出力トークン', (arm) => arm.outputTokens.toLocaleString('ja-JP')],
  ].map(([label, value]) => `<tr><th scope="row">${label}</th><td>${value(authoring.without_skill)}</td><td>${value(authoring.with_skill)}</td></tr>`).join('');
  const template = await read('docs/index.html');
  for (const placeholder of ['<!-- EXAMPLES -->', '<!-- EVALUATION_ROWS -->', '<!-- BENCHMARK_ROWS -->']) {
    if (template.split(placeholder).length !== 2) throw new Error(`Expected one ${placeholder}`);
  }
  const html = template.replace('<!-- EXAMPLES -->', tabs + panels.join('\n')).replace('<!-- EVALUATION_ROWS -->', rows).replace('<!-- BENCHMARK_ROWS -->', metrics);
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
  await writeFile(join(output, 'evaluation.html'), report);
  const prose = template
    .replace(/<head>[\s\S]*?<\/head>/g, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, content) => `\n\n\`\`\`text\n${content.replace(/<[^>]*>/g, '')}\n\`\`\`\n\n`)
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(?:br|\/p|\/h[1-6]|\/div|\/li|\/dt|\/dd|\/caption|\/th|\/td|\/label|\/option|\/button|\/summary)[^>]*>/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(join(root, '.cache/site-copy.md'), `${prose}\n\n${exampleCopy.join('\n')}`);
  console.log('Built dist/: showcase, original comparisons, and .cache/site-copy.md for textlint.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();

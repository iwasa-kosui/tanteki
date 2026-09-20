import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../benchmarks/readable-report.mjs';
import { readPublication } from '../benchmarks/isolated/publication.ts';
import { writeReport } from '../benchmarks/isolated/report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = './results/';
const escape = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export async function build(projectRoot = root) {
  const root = projectRoot;
  const source = join(root, 'docs');
  const output = join(root, 'dist');
  const read = (path) => readFile(join(root, path), 'utf8');
  const { run } = JSON.parse(await read('docs/benchmark.json'));
  if (!/^benchmarks\/results\/[a-z0-9-]+$/.test(run)) throw new Error('Invalid benchmark publication path');
  const data = await readPublication(join(root, run));
  const { cases, manifest, lock, evaluation, summary } = data;
  const examples = JSON.parse(await read('docs/examples.json'));
  const panels = [];
  // Keep an inspectable Markdown version of the exact page prose for textlint.
  const exampleCopy = [];
  for (const example of examples) {
    const task = cases.find(({ id }) => id === example.id);
    if (!task) throw new Error(`Missing source case: ${example.id}`);
    const documents = [];
    for (const [arm, name, label] of [['without_skill', 'before', 'スキルなし'], ['with_skill', 'after', 'tanteki あり']]) {
      const repeat = example.repeat ?? 1;
      const record = data.records.find((r) => r.id === `${example.id}.${repeat}.${arm}`);
      if (record?.status !== 'valid') throw new Error(`Invalid example: ${example.id}.${repeat}.${arm}`);
      const path = `${run}/documents/${record.id}.md`;
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
      documents.push(`<div class="document ${name}"><p class="document-label" id="label-${example.id}-${name}"><b>${name === 'before' ? 'WITHOUT' : 'WITH'}</b><span${name === 'after' ? ' class="badge"' : ''}>${label}</span><span class="full-text-label">全文</span></p><div class="document-scroll" role="region" aria-labelledby="label-${example.id}-${name}" tabindex="0"><blockquote cite="${repo}${path.slice(run.length + 1)}">${html}</blockquote></div></div>`);
    }
    panels.push(`<section class="example-panel" id="example-${example.id}" aria-label="${escape(example.tab)}の比較">
      <div class="example-title"><h3>${escape(example.title)}</h3><span>${escape(example.scope)}</span></div>
      <div class="comparison">${documents.join('\n')}</div>
      <p class="comparison-insight"><strong>読み比べるポイント</strong><span>${escape(example.insight)}</span></p>
      <div class="example-source"><details><summary>この文書への依頼・原資料を読む</summary><p>${escape(task.prompt).replaceAll('\n', '<br>')}</p></details><a href="./evaluation.html#${example.id}.${example.repeat ?? 1}">評価の詳細 ↗</a></div>
    </section>`);
    const notes = [...example.before.highlight, ...example.after.highlight].map(({ note }) => note);
    exampleCopy.push(`## ${example.tab}\n\n${example.title}\n\n${example.insight}\n\n${notes.join('\n\n')}\n`);
  }
  const tabs = `<div class="example-tabs" aria-label="比較する文書" hidden>${examples.map((example, index) => `<button type="button" id="tab-${example.id}" data-example-tab aria-controls="example-${example.id}"><span>0${index + 1}</span>${escape(example.tab)}</button>`).join('')}</div>`;
  const started = new Date(manifest.createdAt).toLocaleDateString('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  const comparisonContext = `「なし／あり」は同じ依頼から別々に生成した結果です。${started}（UTC）に開始したDocker分離方式の実測から、${examples.length}課題を紹介します。`;
  const context = `<p>同じ依頼を同じモデルに渡し、tanteki一式の導入だけを変えて文書を生成しました。${cases.length}課題を各${manifest.settings.repeats}回比較し、両条件で生成が成功した文書のうち、${summary.gradedPairs}組を採点しました。</p><p>作成者が選んだ課題による小規模な比較です。${cases.some((c) => c.type === "prd") ? "" : "PRDは含みません。"}ほかの課題やモデルでも同じ結果になるとは限りません。</p>`;
  const notesLink = (await readdir(join(root, run))).includes('run-notes.md')
    ? '<p><a class="text-link" href="./results/run-notes.md">本文と採点を照合した所見を読む ↗</a></p>' : '';
  const sources = `<p><a class="text-link" href="./evaluation.html">全${summary.plannedPairs}組の本文と評価を読む ↗</a></p>${notesLink}<details><summary>実行条件の詳細</summary><p>${escape(started)}（UTC）に生成を開始しました。各試行を新しいコンテナで実行し、生成後の採点結果は書き手に返していません。</p><p>生成は ${escape(manifest.settings.model)} / ${escape(manifest.settings.effort)}、採点は ${escape(evaluation.model)} / ${escape(evaluation.effort)} です。対象は <a href="https://github.com/iwasa-kosui/tanteki/tree/${escape(lock.sourceRevision)}">tanteki ${escape(lock.sourceRevision.slice(0, 7))}</a> です。</p><p><a href="./results/report.md">実行結果の集計を読む ↗</a></p></details>`;
  const rawTemplate = await read('docs/isolated.html');
  for (const marker of ['<!-- RUN_CONTEXT -->', '<!-- RUN_SOURCES -->', '<!-- COMPARISON_CONTEXT -->', '<!-- EXAMPLES -->']) {
    if (rawTemplate.split(marker).length !== 2) throw new Error(`Expected one ${marker}`);
  }
  const template = rawTemplate.replace('<!-- RUN_CONTEXT -->', context).replace('<!-- RUN_SOURCES -->', sources).replace('<!-- COMPARISON_CONTEXT -->', escape(comparisonContext));
  const html = template.replace('<!-- EXAMPLES -->', tabs + panels.join('\n'));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.html'), html);
  for (const file of ['styles.css', 'site.js', 'favicon.svg']) await cp(join(source, file), join(output, file));
  await writeFile(join(output, '.nojekyll'), '');
  // Ship the original outputs and evaluation records so preview links work too.
  await cp(join(root, run), join(output, 'results'), { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('calls') });
  await writeReport({ ...data, out: join(output, 'results') });
  const report = (await readFile(join(output, 'results/comparison.html'), 'utf8'))
    .replace('<h1>', '<nav style="padding:16px"><a href="./">← tanteki の紹介へ戻る</a></nav><h1>');
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

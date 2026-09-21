import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyMermaidAssets, addMermaidPreview } from './mermaid-assets.mjs';
import { renderMarkdown } from '../benchmarks/readable-report.mjs';
import { readPublication } from '../benchmarks/isolated/publication.ts';
import { writeReport } from '../benchmarks/isolated/report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  const publications = new Map([[run, { data, destination: 'results' }]]);
  const examples = JSON.parse(await read('docs/examples.json'));
  const panels = [];
  // Keep an inspectable Markdown version of the exact page prose for textlint.
  const exampleCopy = [];
  for (const example of examples) {
    const exampleRun = example.run ?? run;
    if (!/^benchmarks\/results\/[a-z0-9-]+$/.test(exampleRun)) throw new Error('Invalid example publication path');
    if (!publications.has(exampleRun)) {
      publications.set(exampleRun, {
        data: await readPublication(join(root, exampleRun)),
        destination: `examples/${basename(exampleRun)}`,
      });
    }
    const publication = publications.get(exampleRun);
    const task = publication.data.cases.find(({ id }) => id === example.id);
    if (!task) throw new Error(`Missing source case: ${example.id}`);
    const evaluationUrl = exampleRun === run ? './evaluation.html' : `./${publication.destination}/comparison.html`;
    const documents = [];
    for (const [arm, name, label] of [['without_skill', 'before', 'スキルなし'], ['with_skill', 'after', 'tanteki あり']]) {
      const repeat = example.repeat ?? 1;
      const record = publication.data.records.find((r) => r.id === `${example.id}.${repeat}.${arm}`);
      if (record?.status !== 'valid') throw new Error(`Invalid example: ${example.id}.${repeat}.${arm}`);
      const path = `${exampleRun}/documents/${record.id}.md`;
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
      documents.push(`<div class="document ${name}"><p class="document-label" id="label-${example.id}-${name}"><b>${name === 'before' ? 'WITHOUT' : 'WITH'}</b><span${name === 'after' ? ' class="badge"' : ''}>${label}</span><span class="full-text-label">全文</span></p><div class="document-scroll" role="region" aria-labelledby="label-${example.id}-${name}" tabindex="0"><blockquote cite="./${publication.destination}/documents/${record.id}.md">${html}</blockquote></div></div>`);
    }
    panels.push(`<section class="example-panel" id="example-${example.id}" aria-label="${escape(example.tab)}の比較">
      <div class="example-title"><h3>${escape(example.title)}</h3><span>${escape(example.scope)}</span></div>
      <div class="comparison">${documents.join('\n')}</div>
      <div class="example-source"><details><summary>この文書への依頼・原資料を読む</summary><p>${escape(task.prompt).replaceAll('\n', '<br>')}</p></details><a href="${evaluationUrl}#${example.id}.${example.repeat ?? 1}">評価の詳細 ↗</a></div>
    </section>`);
    const notes = [...example.before.highlight, ...example.after.highlight].map(({ note }) => note);
    exampleCopy.push(`## ${example.tab}\n\n${example.title}\n\n${notes.join('\n\n')}\n`);
  }
  const tabs = `<div class="example-tabs" aria-label="比較する文書" hidden>${examples.map((example, index) => `<button type="button" id="tab-${example.id}" data-example-tab aria-controls="example-${example.id}"><span>0${index + 1}</span>${escape(example.tab)}</button>`).join('')}</div>`;
  const started = new Date(manifest.createdAt).toLocaleDateString('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  const supplementalExamples = examples.filter((example) => example.run && example.run !== run);
  const additionalContext = (await Promise.all(supplementalExamples.map(async (example) => {
    const { data: extra, destination } = publications.get(example.run);
    const date = new Date(extra.manifest.createdAt).toLocaleDateString('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    const notes = (await readdir(join(root, example.run))).includes('run-notes.md')
      ? ` · <a href="./${destination}/run-notes.md">題材の見直しと本文の所見 ↗</a>` : '';
    return `<p>${escape(example.tab)}の例は${escape(date)}（UTC）に開始した追加実測です。基本の実測とは別に採点しています。生成は ${escape(extra.manifest.settings.model)} / ${escape(extra.manifest.settings.effort)}、採点は ${escape(extra.evaluation.model)} / ${escape(extra.evaluation.effort)} です。<a href="./${destination}/comparison.html">追加実測の本文と評価 ↗</a> · <a href="./${destination}/runtime-lock.json">実行環境の記録 ↗</a>${notes}</p>`;
  }))).join('');
  const context = `<p>同じ依頼を同じモデルに渡し、tanteki一式の導入だけを変えて文書を生成しました。${supplementalExamples.length ? "基本の実測では、" : ""}${cases.length}課題を各${manifest.settings.repeats}回比較し、両条件で生成が成功した文書のうち、${summary.gradedPairs}組を採点しました。</p>${supplementalExamples.map((example) => `<p>${escape(example.tab)}の例は追加実測から選び、この採点件数には含めていません。</p>`).join('')}<p>作成者が選んだ課題による小規模な比較です。${cases.some((c) => c.type === "prd") ? "" : "PRDは含みません。"}ほかの課題やモデルでも同じ結果になるとは限りません。</p>`;
  const notesLink = (await readdir(join(root, run))).includes('run-notes.md')
    ? '<p><a class="text-link" href="./results/run-notes.md">本文と採点を照合した所見を読む ↗</a></p>' : '';
  const sources = `<p><a class="text-link" href="./evaluation.html">全${summary.plannedPairs}組の本文と評価を読む ↗</a></p>${notesLink}<details><summary>実行条件の詳細</summary><p>${escape(started)}（UTC）に生成を開始しました。各試行を新しいコンテナで実行し、生成後の採点結果は書き手に返していません。</p><p>生成は ${escape(manifest.settings.model)} / ${escape(manifest.settings.effort)}、採点は ${escape(evaluation.model)} / ${escape(evaluation.effort)} です。対象は <a href="https://github.com/iwasa-kosui/tanteki/tree/${escape(lock.sourceRevision)}">tanteki ${escape(lock.sourceRevision.slice(0, 7))}</a> です。</p><p><a href="./results/report.md">実行結果の集計を読む ↗</a></p>${additionalContext}</details>`;
  const rawTemplate = await read('docs/isolated.html');
  for (const marker of ['<!-- RUN_CONTEXT -->', '<!-- RUN_SOURCES -->', '<!-- EXAMPLES -->']) {
    if (rawTemplate.split(marker).length !== 2) throw new Error(`Expected one ${marker}`);
  }
  const template = rawTemplate.replace('<!-- RUN_CONTEXT -->', context).replace('<!-- RUN_SOURCES -->', sources);
  const html = template.replace('<!-- EXAMPLES -->', tabs + panels.join('\n'));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.html'), html);
  for (const file of ['styles.css', 'site.js', 'favicon.svg', 'og-image.png']) await cp(join(source, file), join(output, file));
  await copyMermaidAssets(source, output);
  await writeFile(join(output, '.nojekyll'), '');
  // Ship the original outputs and evaluation records so preview links work too.
  for (const [publicationRun, { data: published, destination }] of publications) {
    const target = join(output, destination);
    await cp(join(root, publicationRun), target, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('calls') });
    await writeReport({ ...published, out: target });
    const comparisonPath = join(target, 'comparison.html');
    const base = publicationRun === run ? '../' : '../../';
    const original = await readFile(comparisonPath, 'utf8');
    const withPreview = (base) => addMermaidPreview(original, base)
      .replace('<h1>', `<nav style="padding:16px"><a href="${base}">← tanteki の紹介へ戻る</a></nav><h1>`);
    await writeFile(comparisonPath, withPreview(base));
    if (publicationRun === run) await writeFile(join(output, 'evaluation.html'), withPreview('./'));
  }
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

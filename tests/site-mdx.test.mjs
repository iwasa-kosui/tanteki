import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../scripts/site-mdx.mjs';

const source = fileURLToPath(new URL('../docs/', import.meta.url));
const fragments = {
  Examples: '<section class="example-panel"><blockquote>引用の原文 {notJavaScript} $&</blockquote></section>',
  RunContext: '<p>検証済みの比較条件。</p>',
  RunSources: '<a href="./evaluation.html">全件の評価</a>',
  EvaluationRows: '<tr><th scope="row">用途を満たす</th><td>1</td><td>2</td></tr>',
  BenchmarkRows: '<tr><th scope="row">入力トークン</th><td>3</td><td>4</td></tr>',
};

test('MDX renders static pages for both publication formats with accessible tables and existing controls', async () => {
  for (const format of ['isolated', 'legacy']) {
    const { html, prose } = await renderSite(source, format, fragments);
    assert.match(html, /^<!doctype html>\n<html lang="ja">/);
    assert.match(html, /id="hero-title">業務のための文書を<br\/>もっと端的に/);
    assert.match(html, /<th scope="row">PRD<\/th>/);
    assert.match(html, /<th scope="col">文書の種類<\/th>/);
    assert.match(html, /<caption>文書の種類ごとの規定<\/caption>/);
    assert.match(html, /id="install-command">gh skills install iwasa-kosui\/tanteki tanteki --scope user<\/code>/);
    assert.match(html, /data-copy="prompt"/);
    assert.match(html, /<label for="agent"/);
    assert.match(html, /src="\.\/mermaid-preview.js"/);
    assert.ok(html.includes(fragments.Examples));
    assert.doesNotMatch(html, /site-slot|react-dom|jsx-runtime/);
    const documentTypesHeading = html.match(/<h2 id="doc-types-title">([^<]+)<\/h2>/);
    assert.ok(documentTypesHeading, 'the document types section has a heading');
    assert.ok(prose.includes(documentTypesHeading[1]), 'lint copy includes the rendered section heading');
    assert.match(prose, /```text\ngh skills install/);
    assert.doesNotMatch(prose, /引用の原文|notJavaScript|og:image|<[^>]+>/);
    if (format === 'isolated') {
      assert.ok(html.includes(fragments.RunContext));
      assert.ok(html.includes(fragments.RunSources));
      assert.match(prose, /検証済みの比較条件/);
      assert.doesNotMatch(html, /最大1回修正|入力トークン/);
    } else {
      assert.ok(html.includes(fragments.EvaluationRows));
      assert.ok(html.includes(fragments.BenchmarkRows));
      assert.match(html, /最大1回修正/);
      assert.doesNotMatch(html, /検証済みの比較条件|部分評価です/);
    }
  }
});

test('editing Markdown and metadata changes the rendered page and lint copy without editing HTML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tanteki-mdx-edit-'));
  try {
    const original = await readFile(new URL('./fixtures/site-edit.mdx', import.meta.url), 'utf8');
    await writeFile(join(dir, 'index.mdx'), original);
    const before = await renderSite(dir, 'isolated', fragments);
    assert.match(before.html, /<title>元のページ名<\/title>/);
    assert.match(before.prose, /元の本文。/);
    await writeFile(join(dir, 'index.mdx'), original
      .replace("title: '元のページ名'", "title: '変更したページ名'")
      .replace('## 元の見出し', '## 使用例を読む')
      .replace('元の本文。', '**構成**を確認してから本文を書きます。 {1 + 1}件です。')
      .replace('| PRD | 元の要求 |', '| PRD | 要求と検証方法 |'));
    const { html, prose } = await renderSite(dir, 'isolated', fragments);
    assert.match(html, /<title>変更したページ名<\/title>/);
    assert.match(html, /property="og:title" content="変更したページ名"/);
    assert.match(html, /name="twitter:title" content="変更したページ名"/);
    assert.match(html, /id="examples-title">使用例を読む<\/h2>/);
    assert.match(html, /<strong>構成<\/strong>を確認してから本文を書きます。 2件です。/);
    assert.match(html, /<td>要求と検証方法<\/td>/);
    assert.match(prose, /構成を確認してから本文を書きます。 2件です。/);
    assert.match(prose, /要求と検証方法/);
    assert.doesNotMatch(html, /元のページ名|元の見出し|元の本文|元の要求/);
    assert.doesNotMatch(prose, /元の見出し|元の本文|元の要求/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid MDX and missing or repeated data components fail the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tanteki-mdx-invalid-'));
  try {
    const original = await readFile(join(source, 'index.mdx'), 'utf8');
    for (const replacement of ['', '<Examples /><Examples />']) {
      await writeFile(join(dir, 'index.mdx'), original.replace('<Examples />', replacement));
      await assert.rejects(renderSite(dir, 'isolated', fragments), /Expected one <Examples \/>/);
    }
    await writeFile(join(dir, 'index.mdx'), original + '\n<Unclosed>\n');
    await assert.rejects(renderSite(dir, 'isolated', fragments), /closing tag/);
    await cp(join(source, 'index.mdx'), join(dir, 'index.mdx'));
    await assert.rejects(renderSite(dir, 'isolated', { ...fragments, RunSources: undefined }), /Missing site fragment: RunSources/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

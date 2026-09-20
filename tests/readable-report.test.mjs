import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "../benchmarks/benchmark.mjs";
import { renderMarkdown } from "../benchmarks/readable-report.mjs";

test("reader renders Markdown structure while candidate HTML and unsafe links stay inert", () => {
  const html = renderMarkdown(`# 題名

**太字**と*強調*、~~削除~~、\`code <x>\`。

| 条件 | 動作 |
|---|---|
| 7%超 | 停止 |

3. 順番

- [x] 確認済み

[正本][ref]

[ref]: https://example.test/source

<script>alert(1)</script>
<img src="https://example.test/track" onerror="alert(2)">

[危険](javascript:alert%281%29)

![画像](https://example.test/tracking.png)

~~~js
const literal = "<iframe>";
~~~`);
  assert.match(html, /<h3>題名<\/h3>/);
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<em>強調<\/em>/);
  assert.match(html, /<del>削除<\/del>/);
  assert.match(html, /<th>条件<\/th>/);
  assert.match(html, /<td>7%超<\/td>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /☑/);
  assert.match(html, /href="https:\/\/example.test\/source"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<pre><code>const literal = &quot;&lt;iframe&gt;&quot;;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /!\[画像\]\(https:\/\/example.test\/tracking.png\)/);
});

test("offline reports preserve all evidence, exact draft bodies and swapped A/B judgments", async () => {
  const source = join(root, "benchmarks/results/2026-09-06-main-fb6fd0b");
  const temp = await mkdtemp(join(tmpdir(), "nihongo-readable-test-"));
  try {
    const evidenceFiles = (await readdir(source, { recursive: true })).filter((p) => p.endsWith(".json") && !p.startsWith("calls/"));
    const before = {};
    for (const p of evidenceFiles) {
      before[p] = await readFile(join(source, p), "utf8");
      await cp(join(source, p), join(temp, p), { recursive: true });
    }
    execFileSync(process.execPath, [join(root, "benchmarks/benchmark.mjs"), "report", "--out", temp], {
      env: { ...process.env, CODEX_BIN: "/does/not/exist" }, encoding: "utf8"
    });
    for (const p of evidenceFiles) assert.equal(await readFile(join(temp, p), "utf8"), before[p], `Evidence changed: ${p}`);
    const html = await readFile(join(temp, "comparison.html"), "utf8");
    assert.match(html, /比較無効/);
    assert.match(await readFile(join(temp, "report.md"), "utf8"), /^> \*\*比較無効/);
    const comparisons = await readdir(join(temp, "comparisons"));
    assert.equal(comparisons.length, 20);
    assert.equal((await readdir(join(temp, "documents"))).length, 48);
    assert.match(html, /初稿＝最終稿 · 修正なし/);
    assert.match(html, /初稿は意味の採点対象外/);
    assert.match(html, /default-src 'none'/);
    assert.equal((html.match(/<script>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=/i);
    for (const p of evidenceFiles.filter((p) => p.startsWith("records/"))) {
      const record = JSON.parse(before[p]);
      const comparison = await readFile(join(temp, "comparisons", `${record.caseId}.${record.repeat}.md`), "utf8");
      assert.match(comparison, /^> \*\*比較無効/);
      for (const [i, a] of record.attempts.entries()) {
        assert.equal(await readFile(join(temp, "documents", `${record.id}.${i + 1}.md`), "utf8"), a.response.body);
        assert.ok(html.includes(renderMarkdown(a.response.body)), `${record.id} draft ${i + 1} missing from HTML`);
        assert.ok(comparison.includes(a.response.body), `${record.id} draft ${i + 1} missing from Markdown`);
        if (a.response.notes) assert.ok(comparison.includes(a.response.notes));
        for (const m of a.metrics.lint) assert.ok(comparison.includes(m.message));
      }
    }
    for (const p of evidenceFiles.filter((p) => p.startsWith("judgments/"))) {
      const judgment = JSON.parse(before[p]);
      const pairId = `${judgment.caseId}.${judgment.repeat}`;
      const comparison = await readFile(join(temp, "comparisons", `${pairId}.md`), "utf8");
      for (const label of ["A", "B"]) for (const v of Object.values(judgment.result.response[label])) {
        const name = judgment.mapping[label] === "with_skill" ? "スキルあり" : "スキルなし";
        assert.ok(comparison.includes(`**${name}: ${v.pass ? "合格" : "不合格"}**\n\n${v.evidence}`), `Incorrect A/B mapping: ${pairId}`);
      }
      for (const match of comparison.matchAll(/\]\(([^)]+)\)/g)) {
        const [path] = match[1].split("#");
        // The parent findings page belongs to the repo, not this isolated copy.
        if (!path.startsWith("../") || path.includes("findings.md")) continue;
        await readFile(join(temp, "comparisons", path));
      }
    }
    const report = await readFile(join(temp, "report.md"), "utf8");
    assert.doesNotMatch(report, /\]\([^)]*\.json\)/);
    execFileSync(process.execPath, [join(root, "benchmarks/benchmark.mjs"), "report", "--out", temp], {
      env: { ...process.env, CODEX_BIN: "/does/not/exist" }, encoding: "utf8"
    });
    assert.equal(await readFile(join(temp, "comparison.html"), "utf8"), html, "Offline rendering must be deterministic");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { root, hash } from "../benchmarks/benchmark.mjs";
import { buildReviewPlan, reviewPrompt, validateReview } from "../benchmarks/document-review.mjs";
import { renderDocumentReviews } from "../benchmarks/document-review-report.mjs";

const schema = JSON.parse(await readFile(join(root, "benchmarks/document-review.schema.json"), "utf8"));
const cases = [{ id: "example", title: "課題", prompt: "原依頼", criteria: "OLD-RUBRIC", expectedBody: "EXPECTED-ANSWER" }];
const profiles = { example: { document_kind: "ADR", review_perspective: "保守者の判断に役立つか" } };
const record = (arm, repeat, body = "本文") => ({ id: `example.${repeat}.${arm}`, caseId: "example", arm, repeat, attempts: [{ response: { body, notes: "SKILL-NOTES" }, metrics: { lint: "OLD-LINT" } }] });
const good = () => ({ intended_use: "原依頼の用途", status: "usable", summary: "本文は用途を果たす。", strengths: [], findings: [], source_gaps: [] });

test("role review deduplicates identical requests/bodies and never exposes grading metadata", () => {
  const plan = buildReviewPlan(cases, [record("with_skill", 1), record("without_skill", 1, "本文\n"), record("with_skill", 2, "本文\r\n"), record("without_skill", 2, "別の本文")], profiles);
  assert.equal(plan.entries.length, 4);
  assert.equal(plan.inputs.length, 2);
  assert.equal(plan.entries[0].reviewId, plan.entries[1].reviewId);
  assert.equal(plan.entries[0].reviewId, plan.entries[2].reviewId);
  const prompt = reviewPrompt({ ...plan.inputs[0], notes: "SKILL-NOTES", criteria: "OLD-RUBRIC", arm: "with_skill", score: "OLD-SCORE" });
  for (const hidden of ["SKILL-NOTES", "OLD-RUBRIC", "EXPECTED-ANSWER", "OLD-LINT", "OLD-SCORE", "with_skill", "without_skill", "reviewId"]) assert.ok(!prompt.includes(hidden), hidden);
  assert.ok(prompt.includes("保守者の判断に役立つか"));
  assert.throws(() => buildReviewPlan(cases, [record("with_skill", 1), record("with_skill", 1)], profiles), /Duplicate/);
});

test("role review rejects fabricated quotations and contradictory readiness labels", () => {
  const input = { request: "再試行上限は未決定。", body: "再試行は3回まで。" };
  const issue = { severity: "major", kind: "claim", basis: "source", excerpt: "再試行は3回まで。", source_excerpt: "再試行上限は未決定。", finding: "上限の創作", impact: "未承認の仕様として実装される", suggested_change: "未決定として記載する" };
  validateReview(good(), input, schema);
  const review = { ...good(), status: "revision_needed", findings: [issue] };
  validateReview(review, input, schema);
  assert.throws(() => validateReview({ ...review, status: "usable" }, input, schema), /revision_needed/);
  assert.throws(() => validateReview({ ...review, findings: [{ ...issue, excerpt: "再試行は5回まで。" }] }, input, schema), /exact substring/);
  assert.throws(() => validateReview({ ...review, findings: [{ ...issue, source_excerpt: "" }] }, input, schema), /required/);
  assert.throws(() => validateReview({ ...review, findings: [{ ...issue, severity: "blocker" }] }, input, schema), /enum/);
  assert.throws(() => validateReview({ ...good(), score: 5 }, input, schema), /unknown property/);
});

test("honestly disclosed source gaps are distinct from author defects", () => {
  const input = { request: "コマンドは未定。", body: "コマンドが未定なので実行できない。" };
  const review = { ...good(), status: "source_limited", source_gaps: [{ missing_information: "再起動コマンド", blocks_use: true, handled_appropriately: true, excerpt: "コマンドが未定なので実行できない。", consequence: "確定まで実行できない" }] };
  validateReview(review, input, schema);
  assert.throws(() => validateReview({ ...review, status: "usable" }, input, schema), /source_limited/);
  assert.throws(() => validateReview({ ...review, source_gaps: [{ ...review.source_gaps[0], handled_appropriately: false }] }, input, schema), /inadequately handled/);
});

test("review dry-run needs no old judgments, CLI or writable output directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nihongo-role-review-test-"));
  try {
    await mkdir(join(dir, "records"));
    const r = { ...record("without_skill", 1), id: "surgical-edit.1.without_skill", caseId: "surgical-edit" };
    const c = { ...cases[0], id: "surgical-edit" };
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ plan: [r], fingerprint: "original", skillRevision: "pinned" }));
    await writeFile(join(dir, "cases.json"), JSON.stringify([c]));
    await writeFile(join(dir, "records", `${r.id}.json`), JSON.stringify(r));
    const result = execFileSync(process.execPath, [join(root, "benchmarks/document-review.mjs"), "run", "--source", dir, "--out", "/does/not/exist", "--model", "test-model", "--dry-run"], { encoding: "utf8", env: { ...process.env, CODEX_BIN: "/does/not/exist" } });
    assert.equal(JSON.parse(result).uniqueInputs, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("offline review report shows full evidence, shares identical reviews and preserves frozen inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nihongo-review-report-test-"));
  try {
    for (const name of ["inputs", "reviews", "artifacts"]) await mkdir(join(dir, name));
    const body = "本文\n\n<script>bad()</script>\n\n![画像](https://example.com/image.png)\n";
    const plan = buildReviewPlan(cases, arms.map((arm) => record(arm, 1, body)), profiles);
    const input = plan.inputs[0];
    const review = { ...good(), status: "revision_needed", strengths: ["良い点を保持"], findings: [{ severity: "major", kind: "claim", basis: "source", excerpt: "本文", source_excerpt: "原依頼", finding: "要修正の記述", impact: "判断を誤る影響", suggested_change: "具体的な修正案" }], source_gaps: [{ missing_information: "原資料の不足", blocks_use: true, handled_appropriately: true, excerpt: "本文", consequence: "後続の実装は待つ" }] };
    const manifest = { fingerprint: "fixture", model: "offline", effort: "high", sourceEvaluation: { skillRevision: "pinned", fingerprint: "fb12f9804152845fe34867c7aeeb75008ed1d00688d5f3e9e97882e07917cd6f" }, entries: plan.entries, inputHashes: [{ reviewId: input.reviewId, inputHash: input.inputHash }] };
    const frozen = new Map();
    async function freeze(path, value) { const text = typeof value === "string" ? value : JSON.stringify(value); await writeFile(join(dir, path), text); frozen.set(path, hash(text)); }
    await freeze("manifest.json", manifest);
    await freeze("schema.json", schema);
    await freeze(`inputs/${input.reviewId}.json`, input);
    await freeze(`reviews/${input.reviewId}.json`, { reviewId: input.reviewId, inputHash: input.inputHash, attempts: [{ response: review, validationErrors: null, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 }, elapsedMs: 500 }] });
    for (const e of plan.entries) await freeze(`artifacts/${e.recordId}.md`, body);
    const summary = await renderDocumentReviews(dir);
    assert.equal(summary.uniqueReviews, 1);
    assert.equal(summary.outputs, 2);
    assert.equal(summary.calls, 1);
    assert.equal(summary.usage.input_tokens, 100);
    const html = await readFile(join(dir, "comparison.html"), "utf8");
    assert.match(html, /比較無効/);
    assert.match(await readFile(join(dir, "report.md"), "utf8"), /^> \*\*比較無効/);
    assert.match(await readFile(join(dir, "comparisons/example.1.md"), "utf8"), /^> \*\*比較無効/);
    const md = await readFile(join(dir, "comparisons/example.1.md"), "utf8");
    for (const text of ["良い点を保持", "要修正の記述", "判断を誤る影響", "具体的な修正案", "原資料の不足", "後続の実装は待つ", "原依頼"]) {
      assert.ok(html.includes(text), text);
      assert.ok(md.includes(text), text);
    }
    assert.ok(md.includes(body));
    assert.ok(html.includes("同じレビューを使用"));
    assert.ok(!html.includes("<script>bad()"));
    assert.ok(!html.includes('<img src="https://example.com'));
    assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;"));
    const before = hash(html);
    await renderDocumentReviews(dir);
    assert.equal(hash(await readFile(join(dir, "comparison.html"), "utf8")), before);
    for (const [path, digest] of frozen) assert.equal(hash(await readFile(join(dir, path), "utf8")), digest, path);
    await writeFile(join(dir, `artifacts/${plan.entries[0].recordId}.md`), "changed");
    await assert.rejects(renderDocumentReviews(dir), /Artifact hash/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const arms = ["without_skill", "with_skill"];

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./benchmark.mjs";
import { reviewPrompt, validateReview } from "./document-review.mjs";
import { renderMarkdown } from "./readable-report.mjs";
import { validityMarkdown, validityHtml } from "./comparison-validity.mjs";

const arms = ["without_skill", "with_skill"];
const armNames = { without_skill: "スキルなし", with_skill: "スキルあり" };
const statusNames = { usable: "用途を満たす", revision_needed: "文書の修正が必要", source_limited: "原資料の不足で利用に制限" };
const severityNames = { critical: "重大", major: "要修正", minor: "改善提案" };
const basisNames = { source: "原資料との整合性", document_purpose: "文書の用途" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const quote = (s) => s.split("\n").map((line) => `> ${line}`).join("\n");
const read = (p) => readFile(p, "utf8");
const json = async (p) => JSON.parse(await read(p));
const caveat = "これは単一モデルによる文書レビューで、正解ラベルではありません。引用の完全一致は機械検証しますが、指摘の解釈や重大度が正しいことは保証しません。原資料の不足と執筆上の欠陥を分け、見出し・表・短さだけでは判定しません。";

function reviewMarkdown(review) {
  const lines = [`**${statusNames[review.status]}**`, "", review.summary, "", `想定用途: ${review.intended_use}`, "", "#### 良い点", "", ...(review.strengths.length ? review.strengths.map((s) => `- ${s}`) : ["記載なし。"]), "", "#### 指摘", ""];
  for (const [i, f] of review.findings.entries()) {
    lines.push(`**${i + 1}. ${severityNames[f.severity]} — ${f.finding}**`, "", `根拠: ${basisNames[f.basis]}`, "", "本文の該当箇所:", "", f.excerpt ? quote(f.excerpt) : "記載の欠落についての指摘。", "", "原資料の該当箇所:", "", f.source_excerpt ? quote(f.source_excerpt) : "文書の用途に基づく指摘。", "", `読み手への影響: ${f.impact}`, "", `修正案: ${f.suggested_change}`, "");
  }
  if (!review.findings.length) lines.push("指摘なし。", "");
  lines.push("#### 原資料に足りない情報", "");
  for (const g of review.source_gaps) lines.push(`**${g.missing_information}**`, "", `用途の達成を妨げる: ${g.blocks_use ? "はい" : "いいえ"} · 本文で適切に扱う: ${g.handled_appropriately ? "はい" : "いいえ"}`, "", g.excerpt ? quote(g.excerpt) : "本文に対応する記載なし。", "", g.consequence, "");
  if (!review.source_gaps.length) lines.push("記載なし。", "");
  return lines.join("\n");
}

function reviewHtml(review) {
  return `<div class="review"><p>${escape(review.summary)}</p><p class="intended">想定用途: ${escape(review.intended_use)}</p><details><summary>良い点 (${review.strengths.length})</summary><ul>${review.strengths.map((s) => `<li>${escape(s)}</li>`).join("")}</ul></details><h4>指摘 (${review.findings.length})</h4>${review.findings.length ? review.findings.map((f, i) => `<section class="finding ${f.severity}"><h5>${i + 1}. <span>${severityNames[f.severity]}</span> ${escape(f.finding)}</h5><p class="basis">根拠: ${basisNames[f.basis]}</p><p class="quote-label">本文</p>${f.excerpt ? `<blockquote class="exact">${escape(f.excerpt)}</blockquote>` : "<p>記載の欠落についての指摘。</p>"}${f.source_excerpt ? `<p class="quote-label">原資料</p><blockquote class="exact">${escape(f.source_excerpt)}</blockquote>` : ""}<p><strong>読み手への影響</strong><br>${escape(f.impact)}</p><p><strong>修正案</strong><br>${escape(f.suggested_change)}</p></section>`).join("") : "<p>指摘なし。</p>"}<h4>原資料に足りない情報 (${review.source_gaps.length})</h4>${review.source_gaps.map((g) => `<section class="source-gap"><h5>${escape(g.missing_information)}</h5><p>用途の達成を妨げる: ${g.blocks_use ? "はい" : "いいえ"}<br>本文で適切に扱う: ${g.handled_appropriately ? "はい" : "いいえ"}</p>${g.excerpt ? `<blockquote class="exact">${escape(g.excerpt)}</blockquote>` : "<p>本文に対応する記載なし。</p>"}<p>${escape(g.consequence)}</p></section>`).join("") || "<p>記載なし。</p>"}</div>`;
}

export async function renderDocumentReviews(out) {
  const manifest = await json(join(out, "manifest.json")), schema = await json(join(out, "schema.json"));
  const hasNotes = await read(join(out, "review-notes.md")).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; });
  if (!manifest.entries?.length || !manifest.inputHashes?.length) throw new Error("Empty review manifest");
  const inputs = new Map(), reviews = new Map(), savedReviews = new Map(), rows = [];
  for (const { reviewId, inputHash } of manifest.inputHashes) {
    if (!/^r-[a-f0-9]{64}$/.test(reviewId) || inputs.has(reviewId)) throw new Error("Invalid/duplicate review ID");
    const input = await json(join(out, "inputs", `${reviewId}.json`));
    if (input.reviewId !== reviewId || input.inputHash !== inputHash || hash(reviewPrompt(input)) !== inputHash) throw new Error("Review input hash mismatch");
    const saved = await json(join(out, "reviews", `${reviewId}.json`));
    if (saved.reviewId !== reviewId || saved.inputHash !== inputHash || !saved.attempts?.length || saved.attempts.at(-1).validationErrors !== null) throw new Error("Review identity/completion mismatch");
    inputs.set(reviewId, input);
    reviews.set(reviewId, validateReview(saved.attempts.at(-1).response, input, schema));
    savedReviews.set(reviewId, saved);
  }
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!/^[a-z0-9-]+$/.test(entry.caseId) || !Number.isInteger(entry.repeat) || entry.repeat < 1 || !arms.includes(entry.arm) || entry.recordId !== `${entry.caseId}.${entry.repeat}.${entry.arm}` || seen.has(entry.recordId)) throw new Error("Invalid/duplicate record entry");
    seen.add(entry.recordId);
    const body = await read(join(out, "artifacts", `${entry.recordId}.md`));
    const input = inputs.get(entry.reviewId);
    if (!input || hash(body) !== entry.bodyHash || body.replace(/\r\n/g, "\n").replace(/\n+$/, "") !== input.body) throw new Error("Artifact hash/input mismatch");
    rows.push({ ...entry, body, input, review: reviews.get(entry.reviewId) });
  }
  const pairs = [...new Set(rows.map((r) => `${r.caseId}.${r.repeat}`))].sort().map((id) => {
    const pair = arms.map((arm) => rows.find((r) => `${r.caseId}.${r.repeat}` === id && r.arm === arm));
    if (pair.some((r) => !r)) throw new Error(`Missing comparison: ${id}`);
    return { id, title: pair[0].title, caseId: pair[0].caseId, repeat: pair[0].repeat, pair };
  });
  const counts = Object.fromEntries(arms.map((arm) => [arm, Object.fromEntries(Object.keys(statusNames).map((s) => [s, rows.filter((r) => r.arm === arm && r.review.status === s).length]))]));
  const attempts = [...savedReviews.values()].flatMap((r) => r.attempts);
  const summary = { fingerprint: manifest.fingerprint, model: manifest.model, effort: manifest.effort, outputs: rows.length, uniqueReviews: reviews.size, calls: attempts.length, counts, usage: Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens"].map((k) => [k, attempts.reduce((n, a) => n + a.usage[k], 0)])), elapsedMsSum: attempts.reduce((n, a) => n + a.elapsedMs, 0), rows: rows.map((r) => ({ recordId: r.recordId, reviewId: r.reviewId, status: r.review.status, findings: Object.fromEntries(Object.keys(severityNames).map((s) => [s, r.review.findings.filter((f) => f.severity === s).length])) })) };
  const table = ["| 文書レビューの判定 | スキルなし | スキルあり |", "|---|---:|---:|", ...Object.entries(statusNames).map(([s, label]) => `| ${label} | ${counts.without_skill[s]} | ${counts.with_skill[s]} |`)].join("\n");
  const method = `${manifest.model} / ${manifest.effort}で、${rows.length}出力をレビュー。同じ依頼・同じ本文は1回だけ評価し、${reviews.size}件のレビューを共有する。条件名、スキル本文、本文外の注記、旧採点基準・点数、相手の候補は渡していない。これは既存出力に対する事後評価であり、旧採点からレビュー方式・モデル・推論量を変えている。結果の差を方式だけの効果とは扱えない。出力数を独立した試行数や有意差の根拠にしない。`;
  await mkdir(join(out, "comparisons"), { recursive: true });
  const sections = [];
  for (const { id, title, caseId, repeat, pair } of pairs) {
    const lines = [`# ${title} — ${repeat}回目の文書レビュー`, "", `[一覧](../report.md) · [左右比較](../comparison.html#${id})`, "", caveat, "", "## 原依頼・原資料", "", pair[0].input.request, "", `文書種別: ${pair[0].input.document_kind}`, "", `読み手の視点: ${pair[0].input.review_perspective}`, ""];
    for (const r of pair) lines.push(`## ${armNames[r.arm]}`, "", "### レビュー", "", reviewMarkdown(r.review), "", "### 成果物の全文", "", `[本文だけのMarkdown](../artifacts/${r.recordId}.md)`, "", "---", "", r.body, "", "---", "");
    await writeFile(join(out, "comparisons", `${id}.md`), validityMarkdown(manifest.sourceEvaluation.fingerprint) + lines.join("\n"));
    const same = pair[0].reviewId === pair[1].reviewId;
    sections.push(`<section class="pair" id="${id}" data-case="${caseId}" data-repeat="${repeat}"><div class="pair-heading"><h2>${escape(title)} <small>${repeat}回目</small></h2><a href="comparisons/${id}.md">比較Markdown</a></div><p class="perspective">${escape(pair[0].input.document_kind)} · ${escape(pair[0].input.review_perspective)}</p>${same ? '<p class="shared">依頼・本文が同一のため、両条件で同じレビューを使用しています。</p>' : ""}<details class="prompt"><summary>原依頼・原資料</summary><div>${renderMarkdown(pair[0].input.request)}</div></details><div class="columns">${pair.map((r) => `<article class="candidate ${r.arm}"><header class="candidate-header"><div><h3>${armNames[r.arm]}</h3><strong class="status ${r.review.status}">${statusNames[r.review.status]}</strong></div></header><details class="artifact"><summary>成果物の全文を読む</summary><div class="document">${renderMarkdown(r.body)}<p><a href="artifacts/${r.recordId}.md">本文Markdown</a></p></div></details>${reviewHtml(r.review)}</article>`).join("")}</div></section>`);
  }
  const report = [`# 文書としての批判的レビュー`, "", "[ブラウザで左右比較](comparison.html) · [旧採点と生成結果](../report.md)", "", caveat, "", table, "", "「用途を満たす」は重大・要修正の指摘がなく、用途を妨げる資料不足もない状態。「文書の修正が必要」は重大または要修正の指摘がある状態。「原資料の不足で利用に制限」は、不足を本文で適切に扱っているが、その用途には不足が解消される必要がある状態。最後の区分は執筆の失敗ではない。", "", "## 課題ごとの本文と指摘", "", "| 課題 | 反復 | スキルなし | スキルあり |", "|---|---:|---|---|", ...pairs.map(({ id, title, repeat, pair }) => `| [${title}](comparisons/${id}.md) | ${repeat} | ${statusNames[pair[0].review.status]} | ${statusNames[pair[1].review.status]} |`), "", "## 方法と限界", "", method, "", "既存課題にはPRDがないため、PRDの品質は評価していない。文書を作らない回答や部分修正は、依頼された範囲の用途として評価する。一般的な文書の全項目を一律に要求しない。", "", `対象スキル: ${manifest.sourceEvaluation.skillRevision}。CLI: ${manifest.runtime?.codexVersion ?? "未記録"}。Node: ${manifest.runtime?.nodeVersion ?? "未記録"}。`, "", `保存レビューの呼び出し数: ${summary.calls}（構造・引用検証の修正を含む）。入力 ${summary.usage.input_tokens}、キャッシュ入力 ${summary.usage.cached_input_tokens}、出力 ${summary.usage.output_tokens}トークン。各呼び出しの経過時間の合計 ${summary.elapsedMsSum}ms。並行実行のため所要時間ではない。失敗して保存に至らなかった呼び出しの利用量は含まない。`, "", "生成本文と旧採点は変更していない。レビューの全応答・検証修正履歴は機械可読で保存し、その最終応答をこのMarkdownとHTMLへ表示する。引用の完全一致とステータスの整合性を検査し、レビューそのものの正しさは原資料と本文から確認する。", ""];
  if (hasNotes) report[2] += " · [レビューの検討メモ](review-notes.md)";
  const css = await read(new URL("./comparison.css", import.meta.url)) + "\n" + await read(new URL("./document-review.css", import.meta.url));
  const script = await read(new URL("./document-review.js", import.meta.url));
  const digest = (s) => createHash("sha256").update(s).digest("base64");
  const caseOptions = [...new Map(pairs.map((p) => [p.caseId, p.title]))].map(([id, title]) => `<option value="${id}">${escape(title)}</option>`).join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(css)}'; base-uri 'none'; form-action 'none'"><title>文書としての批判的レビュー</title><style>${css}</style></head><body><div class="shell">${validityHtml(manifest.sourceEvaluation.fingerprint)}<header class="page-header"><p class="eyebrow">NIHONGO-DE-OK / DOCUMENT REVIEW</p><h1>この文書は、用途を果たせるか</h1><p>文書種別と読者の視点で、成果物を批判的にレビューしました。</p><p class="provenance">${escape(manifest.model)} / ${escape(manifest.effort)} · ${rows.length}出力 / ${reviews.size}件の固有レビュー · 最終稿のみ</p><nav><a href="report.md">集計Markdown</a>${hasNotes ? '<a href="review-notes.md">レビューの検討メモ</a>' : ""}<a href="../comparison.html">旧採点と本文</a></nav><details class="method"><summary>判定の意味・方法・限界</summary><p>${escape(caveat)}</p>${renderMarkdown(table)}<p>「原資料の不足で利用に制限」は、資料の不足を本文で適切に扱っている場合です。執筆の失敗には数えません。「文書の修正が必要」は重大または要修正の指摘がある場合です。</p><p>${escape(method)}</p><p>PRDの課題は含みません。</p></details></header><div class="controls" hidden><label class="case-control">課題<select id="case-select">${caseOptions}</select></label><label>反復<select id="repeat-select"></select></label></div><div class="pagination" hidden><div><button id="previous">← 前の比較</button><button id="next">次の比較 →</button></div><span id="position" aria-live="polite"></span><a id="permalink" href="#">この比較へのリンク</a></div><main>${sections.join("\n")}</main><footer class="page-footer">本文とレビューは保存済みの応答を表示しています。レビューの指摘自体も、原資料と本文に照らして確認してください。</footer></div><script>${script}</script></body></html>\n`;
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(out, "report.md"), validityMarkdown(manifest.sourceEvaluation.fingerprint) + report.join("\n"));
  await writeFile(join(out, "comparison.html"), html);
  return summary;
}

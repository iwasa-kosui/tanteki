import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import MarkdownPlugin from "@textlint/textlint-plugin-markdown";
import { validityMarkdown, validityHtml } from "./comparison-validity.mjs";

const plugin = MarkdownPlugin.default ?? MarkdownPlugin;
const parse = new plugin.Processor().processor(".md").preProcess;
const arms = ["without_skill", "with_skill"];
const armNames = { without_skill: "スキルなし", with_skill: "スキルあり" };
export const criteriaNames = { facts: "事実の保持", grounding: "根拠のない補完を避ける", role: "文書の役割", clarity: "説明の明確さ", economy: "簡潔さ" };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const score = (verdict) => Object.values(verdict).filter((v) => v.pass).length;
const documentPath = (record, index) => `documents/${record.id}.${index + 1}.md`;

// Use the same Markdown parser as lint. Render an explicit set of elements;
// candidate HTML is text, images never fetch, and unknown syntax stays visible.
export function renderMarkdown(source) {
  const ast = parse(source);
  const definitions = new Map();
  const key = (id) => String(id).trim().replace(/\s+/g, " ").toLowerCase();
  function collect(node) {
    if (node.type === "Definition") definitions.set(key(node.identifier), node);
    node.children?.forEach(collect);
  }
  collect(ast);
  const link = (url, body) => /^(https?:\/\/|mailto:)/i.test(url ?? "") && !/[\u0000-\u0020]/.test(url)
    ? `<a href="${escape(url)}" rel="noreferrer noopener">${body}</a>`
    : `<span>${body}${url ? ` (${escape(url)})` : ""}</span>`;
  function render(node) {
    const content = () => (node.children ?? []).map(render).join("");
    const wrapped = (tag) => `<${tag}>${content()}</${tag}>`;
    switch (node.type) {
      case "Document": return content();
      case "Str": return escape(node.value);
      case "Paragraph": return wrapped("p");
      case "Header": return wrapped(`h${Math.min(6, Math.max(1, node.depth) + 2)}`);
      case "Strong": return wrapped("strong");
      case "Emphasis": return wrapped("em");
      case "Delete": return wrapped("del");
      case "BlockQuote": return wrapped("blockquote");
      case "Code": return `<code>${escape(node.value)}</code>`;
      case "CodeBlock": return `<pre><code>${escape(node.value)}</code></pre>`;
      case "HorizontalRule": return "<hr>";
      case "Break": return "<br>";
      case "List": return node.ordered ? `<ol start="${Number.isInteger(node.start) ? node.start : 1}">${content()}</ol>` : wrapped("ul");
      case "ListItem": return `<li>${typeof node.checked === "boolean" ? (node.checked ? "☑ " : "☐ ") : ""}${content()}</li>`;
      case "Link": return link(node.url, content());
      case "LinkReference": return link(definitions.get(key(node.identifier))?.url, content());
      case "Definition": return "";
      case "Table": return `<div class="table-scroll"><table>${node.children.map((row, i) => `<${i ? "tbody" : "thead"}><tr>${row.children.map((cell) => `<${i ? "td" : "th"}>${cell.children.map(render).join("")}</${i ? "td" : "th"}>`).join("")}</tr></${i ? "tbody" : "thead"}>`).join("")}</table></div>`;
      default: return `<span class="literal">${escape(node.raw ?? node.value ?? "")}</span>`;
    }
  }
  return render(ast);
}

function lintDetails(attempt) {
  const messages = attempt.metrics.lint;
  return `<details class="lint"><summary>lint: ${messages.length ? `${messages.length}件の指摘` : "合格"}</summary>${messages.length ? messages.map((m) => `<div class="lint-message"><strong>${escape(m.ruleId)} · ${m.line}行 ${m.column}列</strong><pre>${escape(m.message)}</pre></div>`).join("") : "<p>指摘はありません。</p>"}</details>`;
}

function candidateHtml(record, stage, verdict) {
  const index = stage === "initial" ? 0 : record.attempts.length - 1;
  const attempt = record.attempts[index];
  const revision = record.attempts.length === 1 ? "初稿＝最終稿 · 修正なし" : stage === "initial" ? "初稿 · lint修正前" : "最終稿 · lint修正後";
  return `<article class="candidate ${record.arm}">
    <header class="candidate-header"><div><h3>${armNames[record.arm]}</h3><span>${revision}</span></div><div class="metrics">${attempt.metrics.characters}字 · ${attempt.metrics.headings}見出し<br>${stage === "final" ? `最終稿の採点 ${score(verdict)}/5` : "初稿は意味の採点対象外"}</div></header>
    <div class="document">${renderMarkdown(attempt.response.body)}</div>
    <footer class="candidate-footer"><a href="${documentPath(record, index)}">この本文をMarkdownで開く</a>
      <details class="notes"><summary>本文外の注記${attempt.response.notes ? "" : "（なし）"}</summary>${attempt.response.notes ? renderMarkdown(attempt.response.notes) : "<p>注記はありません。</p>"}</details>
      ${lintDetails(attempt)}${attempt.metrics.exactEdit === null ? "" : `<p>部分修正の完全一致: ${attempt.metrics.exactEdit ? "一致" : "不一致"}</p>`}
      <details><summary>この稿の生成量・時間</summary><p>入力 ${attempt.usage.input_tokens.toLocaleString("en-US")}トークン（内cache ${attempt.usage.cached_input_tokens.toLocaleString("en-US")}）／出力 ${attempt.usage.output_tokens.toLocaleString("en-US")}トークン／${(attempt.elapsedMs / 1000).toFixed(1)}秒</p></details>
    </footer>
  </article>`;
}

function judgmentHtml(c, records, verdicts, notesPath) {
  return `<details class="judgments"><summary>採点基準と理由を読み比べる（最終稿のみ）</summary><p class="caveat">単一LLMによる判定です。本文外の注記による減点など、採点の誤りを含みます。元の判定をそのまま表示しています。<a href="${notesPath}">採点の照合メモ</a></p>${Object.entries(criteriaNames).map(([d, title]) => `<section class="criterion"><h3>${title} <small>${d}</small></h3><p class="criterion-source">${escape(c.criteria[d])}</p><div class="columns">${records.map((r) => {
    const v = verdicts[r.id][d];
    return `<div class="judgment"><strong>${armNames[r.arm]} <span class="${v.pass ? "pass" : "fail"}">${v.pass ? "合格" : "不合格"}</span></strong><p>${escape(v.evidence)}</p></div>`;
  }).join("")}</div></section>`).join("")}</details>`;
}

function comparisonMarkdown(c, repeat, records, verdicts, notesPath) {
  const lines = [`# ${c.title} — ${repeat}回目`, "", `[一覧へ](../report.md) · [ブラウザで左右比較](../comparison.html#${c.id}.${repeat}.final)`, "", "[原依頼](#prompt) · [スキルなし](#without-skill) · [スキルあり](#with-skill) · [採点理由](#judgments) · [初稿とlint指摘](#initial)", "", '<a id="prompt"></a>', "", "## 原依頼", "", c.prompt, "", "## 最終稿", "", "以下は保存された本文の全文。本文外の注記と採点は本文の後に分けて表示する。", ""];
  for (const r of records) {
    const a = r.attempts.at(-1);
    lines.push(`<a id="${r.arm.replaceAll("_", "-")}"></a>`, "", `### ${armNames[r.arm]}`, "", `${score(verdicts[r.id])}/5基準合格 · ${a.metrics.characters}字 · lint指摘${a.metrics.lint.length}件 · ${r.attempts.length === 1 ? "初稿＝最終稿（修正なし）" : "lintによる修正1回"}`, "", `[本文だけのMarkdown](../${documentPath(r, r.attempts.length - 1)})`, "", "---", "", a.response.body, "", "---", "", "**本文外の注記**", "", a.response.notes || "なし。", "");
  }
  lines.push('<a id="judgments"></a>', "", "## 採点基準と理由（最終稿のみ）", "", `単一LLMの元判定で、採点の誤りを含む。[採点の照合メモ](../${notesPath})も参照。`, "");
  for (const [d, title] of Object.entries(criteriaNames)) {
    lines.push(`### ${title}（${d}）`, "", `基準: ${c.criteria[d]}`, "");
    for (const r of records) {
      const v = verdicts[r.id][d];
      lines.push(`**${armNames[r.arm]}: ${v.pass ? "合格" : "不合格"}**`, "", v.evidence, "");
    }
  }
  lines.push('<a id="initial"></a>', "", "## 初稿とlint指摘", "", "初稿は意味の採点対象外。修正なしの場合、本文は上の最終稿と同一。行・列番号はリンク先の本文Markdownに対応する。", "");
  for (const r of records) {
    lines.push(`### ${armNames[r.arm]}`, "");
    for (const [i, a] of r.attempts.entries()) {
      lines.push(`#### ${i === 0 ? "初稿" : "最終稿"}${r.attempts.length === 1 ? "＝最終稿（修正なし）" : ""}`, "", `[本文Markdown](../${documentPath(r, i)}) · ${a.metrics.characters}字 · lint指摘${a.metrics.lint.length}件`, "");
      if (i === 0 && r.attempts.length > 1) lines.push(a.response.body, "", "**本文外の注記**", "", a.response.notes || "なし。", "");
      for (const m of a.metrics.lint) lines.push(`**${m.ruleId} — ${m.line}行 ${m.column}列**`, "", m.message, "");
    }
  }
  return lines.join("\n");
}

export async function writeReadableReports({ out, manifest, cases, records, verdicts }) {
  const hasNotes = await access(join(out, "run-notes.md")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
  const notesPath = hasNotes ? "run-notes.md" : "../../findings.md";
  const byId = new Map(records.map((r) => [r.id, r]));
  await mkdir(join(out, "documents"), { recursive: true });
  await mkdir(join(out, "comparisons"), { recursive: true });
  for (const r of records) for (const [i, a] of r.attempts.entries()) {
    // No header, normalization or added newline: these files are the exact body.
    await writeFile(join(out, documentPath(r, i)), a.response.body);
  }
  const sections = [];
  for (const c of cases) for (let repeat = 1; repeat <= manifest.settings.repeats; repeat++) {
    const pair = arms.map((arm) => {
      const r = byId.get(`${c.id}.${repeat}.${arm}`);
      if (!r || !verdicts[r.id]) throw new Error(`Missing comparison: ${c.id}.${repeat}.${arm}`);
      return r;
    });
    await writeFile(join(out, "comparisons", `${c.id}.${repeat}.md`), validityMarkdown(manifest.fingerprint) + comparisonMarkdown(c, repeat, pair, verdicts, notesPath));
    sections.push(`<section class="pair" id="${c.id}.${repeat}" data-case="${c.id}" data-repeat="${repeat}"><div class="pair-heading"><h2>${escape(c.title)} <small>${repeat}回目</small></h2><a href="comparisons/${c.id}.${repeat}.md">GitHub用の比較Markdown</a></div><details class="prompt"><summary>原依頼・資料を読む</summary><div>${renderMarkdown(c.prompt)}</div></details>${["final", "initial"].map((stage) => `<div class="draft" data-stage="${stage}"><p class="stage-label">${stage === "final" ? "最終稿" : "初稿（意味の採点対象外）"}</p><div class="columns">${pair.map((r) => candidateHtml(r, stage, verdicts[r.id])).join("")}</div></div>`).join("")}${judgmentHtml(c, pair, verdicts, notesPath)}</section>`);
  }
  const css = await readFile(new URL("./comparison.css", import.meta.url), "utf8");
  const script = await readFile(new URL("./comparison.js", import.meta.url), "utf8");
  const digest = (s) => createHash("sha256").update(s).digest("base64");
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(css)}'; base-uri 'none'; form-action 'none'"><title>スキルあり／なしを読み比べる</title><style>${css}</style></head>
<body><div class="shell">${validityHtml(manifest.fingerprint)}<header class="page-header"><p class="eyebrow">NIHONGO-DE-OK / BENCHMARK</p><h1>スキルあり／なしを読み比べる</h1><p>左がスキルなし、右がスキルあり。同じ依頼から生成された本文を、全文表示します。</p><p class="provenance">評価対象 ${escape(manifest.sourceRef ?? "skill")} @ ${escape(manifest.skillRevision.slice(0, 7))} · ${escape(manifest.settings.model)} · ${cases.length}課題 × ${manifest.settings.repeats}回</p><nav><a href="report.md">集計</a><a href="${notesPath}">評価の要点・採点の照合メモ</a></nav></header>
<div class="controls" hidden><label class="case-control">課題<select id="case-select">${cases.map((c, i) => `<option value="${c.id}">${String(i + 1).padStart(2, "0")} · ${escape(c.title)}</option>`).join("")}</select></label><label>反復<select id="repeat-select">${Array.from({ length: manifest.settings.repeats }, (_, i) => `<option value="${i + 1}">${i + 1}回目</option>`).join("")}</select></label><div class="stage-control"><span>表示する稿</span><div class="segmented" role="group" aria-label="表示する稿"><button data-stage="final" aria-pressed="true">最終稿</button><button data-stage="initial" aria-pressed="false">初稿</button></div></div></div>
<div class="pagination" hidden><div><button id="previous">← 前の比較</button><button id="next">次の比較 →</button></div><span id="position" aria-live="polite"></span><a id="permalink" href="#">この比較へのリンク</a></div>
<main>${sections.join("\n")}</main><footer class="page-footer">保存済みの本文・注記・判定から生成。JSONを開かずに内容を確認できます。意味の採点は最終稿のみです。</footer></div><script>${script}</script></body></html>\n`;
  await writeFile(join(out, "comparison.html"), html);
}

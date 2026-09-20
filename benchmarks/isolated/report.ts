import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderMarkdown } from "../readable-report.mjs";
import { pairedRecords, invariant } from "./protocol.ts";

import { arms, type Arm, type BenchmarkCase } from "./benchmark-case.ts";
import type { Manifest } from "./manifest.ts";
import type { Execution } from "./execution.ts";
import type { Evaluation } from "./evaluation.ts";

type ArmSummary = { planned: number; valid: number; invalid_environment: number; execution_failed: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; modelCalls: number; elapsedMs: number; skillTextSeen: number; lintCommandSeen: number; assessed: number; rubricPasses: number; rubricTotal: number; lintPasses: number };
type Summary = { protocol: string; plannedPairs: number; validPairs: number; gradedPairs: number; pairedScoreDifferences: Array<{caseId:string;repeat:number;difference:number}>; arms: Record<Arm,ArmSummary> };
const names = { without_skill: "スキルなし", with_skill: "スキルあり" };
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function summarize(manifest: Pick<Manifest, "protocol" | "plan">, records: readonly Execution[], evaluation: Evaluation | null): Summary {
  const pairs = pairedRecords(manifest, records);
  function summarizeArm(arm: Arm): ArmSummary {
    const rows = records.filter((r) => r.arm === arm);
    const summary = { planned: rows.length, valid: 0, invalid_environment: 0, execution_failed: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, modelCalls: 0, elapsedMs: 0, skillTextSeen: 0, lintCommandSeen: 0, assessed: 0, rubricPasses: 0, rubricTotal: 0, lintPasses: 0 };
    for (const r of rows) {
      summary[r.status]++;
      summary.inputTokens += r.usage.input_tokens;
      summary.outputTokens += r.usage.output_tokens;
      summary.cachedInputTokens += r.usage.cached_input_tokens;
      summary.modelCalls += r.modelCalls;
      summary.elapsedMs += r.elapsedMs;
      summary.skillTextSeen += Number(r.observations.skillTextSeen);
      summary.lintCommandSeen += Number(r.observations.lintCommandSeen);
    }
    return summary;
  }
  const result: Summary = { protocol: manifest.protocol, plannedPairs: manifest.plan.length / 2, validPairs: pairs.length, gradedPairs: 0, pairedScoreDifferences: [], arms: { without_skill: summarizeArm("without_skill"), with_skill: summarizeArm("with_skill") } };
  if (evaluation) for (const pair of pairs) {
    const id = `${pair[0].caseId}.${pair[0].repeat}`;
    const judgment = evaluation.pairs[id];
    if (judgment?.status !== "valid") continue;
    const scores: Record<Arm,number> = { without_skill: 0, with_skill: 0 };
    for (const r of pair) {
      const label = judgment.mapping.A === r.arm ? "A" : "B";
      invariant(label && judgment.response[label], "Incomplete judgment");
      const values = Object.values(judgment.response[label]);
      const s = result.arms[r.arm];
      s.assessed++;
      s.rubricTotal += values.length;
      scores[r.arm] = values.filter((v) => v.pass).length;
      s.rubricPasses += scores[r.arm];
      s.lintPasses += Number(evaluation.lint[r.id].lint.length === 0);
    }
    result.gradedPairs++;
    result.pairedScoreDifferences.push({ caseId: pair[0].caseId, repeat: pair[0].repeat, difference: scores.with_skill - scores.without_skill });
  }
  return result;
}

export async function writeReport({ out, manifest, cases, records, evaluation = null }: { out: string; manifest: Manifest; cases: readonly BenchmarkCase[]; records: readonly Execution[]; evaluation?: Evaluation | null }) {
  const summary = summarize(manifest, records, evaluation);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const byId = new Map(records.map((r) => [r.id, r]));
  const rows: ReadonlyArray<readonly [string, keyof ArmSummary]> = [
    ["計画した実行", "planned"], ["環境検証済み", "valid"], ["環境無効", "invalid_environment"], ["実行失敗", "execution_failed"],
    ["本文取得をログで観測", "skillTextSeen"], ["lintコマンドをログで観測", "lintCommandSeen"], ["採点対象", "assessed"], ["採点用lint合格", "lintPasses"],
    ["モデル呼び出し（失敗含む）", "modelCalls"], ["入力トークン（報告された全実行分）", "inputTokens"], ["出力トークン（報告された全実行分）", "outputTokens"]
  ];
  const tableRows = rows.map(([label, key]) => [label, ...arms.map((arm) => summary.arms[arm][key])]);
  tableRows.push(["意味基準合格", ...arms.map((arm) => `${summary.arms[arm].rubricPasses}/${summary.arms[arm].rubricTotal}`)]);
  const explanation = "同じユーザー入力でtanteki一式の導入効果を比較する。生成中にスキルが行った検査・改稿は含む。採点のtextlint結果は生成へ返さない。未発火も集計に残し、品質は両側が有効なペアで評価する。取得・コマンドの観測はログからの推定であり、スキルの遵守や全ファイルアクセスの証明ではない。失敗時にプロバイダーが利用量を返さなかった呼び出しのトークン数は不明。";
  const markdown = ["# 分離スキルベンチマーク", "", "[本文と実行状態の左右比較](comparison.html)", "", explanation, "", `状態: ${evaluation ? "採点済み" : "生成のみ・未採点"}。有効ペア ${summary.validPairs}/${summary.plannedPairs}、採点済みペア ${summary.gradedPairs}。`, "", "| 指標 | スキルなし | スキルあり |", "|---|---:|---:|", ...tableRows.map((r) => `| ${r.join(" | ")} |`), "", "品質の差はケースと反復ごとのペアで読む。モデル出力の決定性や一般的な優位は保証しない。", ""];
  for (const r of records.filter((r) => r.status !== "valid")) markdown.push(`- ${r.id}: ${r.status} — ${r.error}`, "");
  if (evaluation) for (const [id, r] of Object.entries(evaluation.pairs)) if (r.status !== "valid") markdown.push(`- 採点 ${id}: ${r.status} — ${r.error}`, "");
  await writeFile(join(out, "report.md"), markdown.join("\n"));
  const sections = [];
  for (const c of cases) for (let repeat = 1; repeat <= manifest.settings.repeats; repeat++) {
    const id = `${c.id}.${repeat}`;
    const pair = evaluation?.pairs[id];
    sections.push(`<section id="${escape(id)}"><h2>${escape(c.title)} · ${repeat}回目</h2><details><summary>共通の原依頼</summary><pre>${escape(c.prompt)}</pre></details><div class="columns">${arms.map((arm) => {
      const r = byId.get(`${id}.${arm}`);
      invariant(r, "Missing planned result");
      const lint = evaluation?.lint[r.id];
      const verdict = pair?.status === "valid" ? pair.response[pair.mapping.A === arm ? "A" : "B"] : null;
      return `<article class="candidate ${arm}"><header class="candidate-header"><h3>${names[arm]}</h3><strong>${escape(r.status)}</strong></header>${r.status === "valid" ? `<div class="document">${renderMarkdown(r.response.body)}</div><details><summary>本文外の注記</summary>${renderMarkdown(r.response.notes)}</details>` : `<pre>${escape(r.error)}</pre>`}<p>生成中の観測: スキル本文 ${r.observations.skillTextSeen ? "あり" : "なし"}／lintコマンド ${r.observations.lintCommandSeen ? "あり" : "なし"}</p><p>完了後の採点用lint: ${lint ? `${lint.lint.length}件` : "未採点"}</p>${lint ? `<details><summary>採点用lintの指摘</summary><pre>${escape(JSON.stringify(lint.lint, null, 2))}</pre></details>` : ""}${verdict ? `<details><summary>意味の採点と根拠</summary>${Object.entries(verdict).map(([key, v]) => `<p><strong>${escape(key)}: ${v.pass ? "合格" : "不合格"}</strong> ${escape(v.evidence)}</p>`).join("")}</details>` : ""}</article>`;
    }).join("")}</div></section>`);
  }
  const css = await readFile(new URL("../comparison.css", import.meta.url), "utf8");
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分離スキルベンチマーク</title><style>${css}\nbody{max-width:1440px;margin:auto;padding:24px}section{margin:32px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{min-width:0}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #aaa}@media(max-width:760px){.columns{display:block}}</style><h1>分離スキルベンチマーク</h1><p>${explanation}</p><p>有効ペア ${summary.validPairs}/${summary.plannedPairs}、採点済みペア ${summary.gradedPairs}</p><table><thead><tr><th>指標</th><th>スキルなし</th><th>スキルあり</th></tr></thead><tbody>${tableRows.map((r) => `<tr>${r.map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>${sections.join("")}</html>`;
  await writeFile(join(out, "comparison.html"), html);
  return summary;
}

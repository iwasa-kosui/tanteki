import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lintFiles } from "../scripts/lint.mjs";
import { writeReadableReports } from "./readable-report.mjs";
import { validityMarkdown } from "./comparison-validity.mjs";
import { auditInput, readSessionRollout } from "./input-audit.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const dimensions = ["facts", "grounding", "role", "clarity", "economy"];
export const arms = ["without_skill", "with_skill"];
const bench = join(root, "benchmarks");
const text = (path) => readFile(path, "utf8");
const json = async (path) => JSON.parse(await text(path));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function verifySourceSnapshot(sourceHashes, readSource) {
  for (const [name, expected] of Object.entries(sourceHashes)) {
    if (name.startsWith("benchmarks/")) continue;
    if (hash(readSource(name)) !== expected) throw new Error(`Source revision does not match working tree: ${name}`);
  }
}

async function ruleFiles(directory = "rules") {
  const names = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) names.push(...await ruleFiles(name));
    else if (entry.name.endsWith(".mjs")) names.push(name);
  }
  return names.sort();
}

async function typeFiles() {
  return (await readdir(join(root, "references/types"))).filter((name) => name.endsWith(".md")).sort().map((name) => `references/types/${name}`);
}

export function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("No cases");
  const ids = new Set();
  for (const c of cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) throw new Error("Invalid/duplicate case ID");
    ids.add(c.id);
    if (!c.prompt || !c.documentType || !["prd", "design-doc", "adr", "rfc", "stock", "flow", "record"].includes(c.type)) throw new Error(`Invalid case ${c.id}`);
    if (Object.keys(c.criteria).sort().join() !== [...dimensions].sort().join() || dimensions.some((d) => !c.criteria[d])) throw new Error(`Invalid rubric ${c.id}`);
  }
}

export function makePlan(cases, repeats, seed) {
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const ordered = [...cases].sort((a, b) => hash(`${seed}:${repeat}:${a.id}`).localeCompare(hash(`${seed}:${repeat}:${b.id}`)));
    for (const [i, c] of ordered.entries()) {
      const order = (i + repeat) % 2 ? arms : [...arms].reverse();
      for (const arm of order) plan.push({ id: `${c.id}.${repeat}.${arm}`, caseId: c.id, repeat, arm });
    }
  }
  return plan;
}

export function skillContext(c, files) {
  const classification = files["references/document-types.md"].split("\n");
  const headerLine = "| 種別 | 主な読者 | 目的 | 目的ではないこと | 最小内容 | 区分 |";
  let row;
  for (const name of Object.keys(files).filter((name) => name.startsWith("references/types/")).sort()) {
    const lines = files[name].split("\n");
    const headerIndex = lines.indexOf(headerLine);
    if (headerIndex === -1) continue;
    // Skip the separator row; only the classification table (not later "答える問い" tables) is in scope.
    for (let i = headerIndex + 2; i < lines.length && lines[i].trim() !== ""; i++) {
      if (lines[i].startsWith(`| ${c.documentType} |`)) { row = lines[i]; break; }
    }
    if (row) break;
  }
  if (!row) throw new Error(`Missing document classification: ${c.documentType}`);
  const parts = [
    ["SKILL.md", files["SKILL.md"]],
    ["references/delegation.md", files["references/delegation.md"]],
    ["references/japanese.md", files["references/japanese.md"]],
    ["references/structure.md", files["references/structure.md"]],
    ["references/document-types.md (区分と該当行)", [...classification.slice(0, 11), headerLine, row].join("\n")]
  ];
  if (c.shapes) for (const name of Object.keys(files).filter((name) => name.startsWith("references/types/")).sort()) parts.push([name, files[name]]);
  return parts.map(([name, content]) => `--- ${name} ---\n${content}`).join("\n\n");
}

export function authorPrompt(c, arm, context, previous, feedback) {
  if (!arms.includes(arm)) throw new Error("Unknown arm");
  if (arm === "without_skill" && (previous !== undefined || feedback !== undefined)) throw new Error("Baseline must not receive skill lint feedback");
  let prompt = "以下の依頼に応じて日本語で回答してください。bodyは成果物本文、notesは本文外の注記です。\n\n";
  if (arm === "with_skill") prompt += `以下の執筆スキルを適用してください。委譲・ファイル操作はこの実行環境では使えません。執筆者自身が代替し、検査は外部の実行系が担当します。\n\n${context}\n\n`;
  prompt += `依頼と原資料:\n${c.prompt}\n`;
  if (previous) prompt += `\n前稿:\n${JSON.stringify(previous)}\n\n外部textlintの指摘:\n${JSON.stringify(feedback)}\n指摘箇所を修正し、原資料の意味を保って改稿してください。検査自体は実行系が行います。返答の形式は同じです。`;
  return prompt;
}

export function judgeSchema() {
  const criterion = { type: "object", additionalProperties: false, properties: { pass: { type: "boolean" }, evidence: { type: "string" } }, required: ["pass", "evidence"] };
  const candidate = { type: "object", additionalProperties: false, properties: Object.fromEntries(dimensions.map((d) => [d, criterion])), required: dimensions };
  return { type: "object", additionalProperties: false, properties: { A: candidate, B: candidate }, required: ["A", "B"] };
}

export function validateAuthor(value) {
  if (!value || typeof value.body !== "string" || !value.body.trim() || typeof value.notes !== "string" || Object.keys(value).sort().join() !== "body,notes") throw new Error("Invalid/empty author response");
  return value;
}

export function validateJudge(value) {
  if (!value || Object.keys(value).sort().join() !== "A,B") throw new Error("Missing judge candidate");
  for (const label of ["A", "B"]) {
    if (Object.keys(value[label]).sort().join() !== [...dimensions].sort().join()) throw new Error("Missing judge dimension");
    for (const d of dimensions) if (typeof value[label][d]?.pass !== "boolean" || !value[label][d]?.evidence?.trim()) throw new Error("Invalid judge verdict");
  }
  return value;
}

export function parseEvents(stdout) {
  const events = stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const completed = events.filter((e) => e.type === "turn.completed");
  if (completed.length !== 1 || events.some((e) => e.type === "turn.failed" || e.type === "error")) throw new Error("Incomplete/failed Codex turn");
  const items = events.filter((e) => e.type === "item.completed" || e.type === "item.started").map((e) => e.item);
  if (items.some((item) => !["agent_message", "reasoning"].includes(item.type))) throw new Error("Tool activity invalidates isolated run");
  const usage = completed[0].usage;
  if (!["input_tokens", "cached_input_tokens", "output_tokens"].every((key) => Number.isFinite(usage?.[key]))) throw new Error("Missing token usage");
  return usage;
}

export async function disabledSkills() {
  const found = new Set();
  const visited = new Set();
  async function walk(path) {
    let canonical;
    try { canonical = await realpath(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(canonical, { withFileTypes: true });
    if (entries.some((e) => e.name === "SKILL.md")) {
      // CLI versions differ in whether overrides identify the folder or SKILL.md.
      for (const p of [path, canonical]) { found.add(p); found.add(join(p, "SKILL.md")); }
    }
    for (const e of entries) if ((e.isDirectory() || e.isSymbolicLink()) && !["node_modules", ".git"].includes(e.name)) await walk(join(path, e.name));
  }
  for (const path of [join(homedir(), ".agents/skills"), join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"), "/etc/codex/skills"]) await walk(path);
  return [...found].sort();
}

const disabledFeatures = ["shell_tool", "unified_exec", "multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "memories", "skill_search", "shell_snapshot", "browser_use", "computer_use", "image_generation", "view_image", "goals"];
export function codexArgs({ model, effort, workspace, instructions, schema, output, skills = [] }) {
  return ["exec", "--ignore-user-config", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "-m", model,
    "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", `model_instructions_file=${JSON.stringify(instructions)}`,
    "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", 'personality="none"',
    "-c", `skills.config=[${skills.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`,
    ...disabledFeatures.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "--output-schema", schema, "--output-last-message", output, "--json", "-"];
}

export async function callModel({ model, effort, prompt, schema, instructionFile, prefix, timeout, skills }) {
  // Request a fresh workspace; CLI flags are not proof of the effective model input.
  const workspace = await mkdtemp(join(tmpdir(), "nihongo-benchmark-"));
  const output = join(workspace, "response.json");
  const schemaFile = join(workspace, "schema.json");
  await save(schemaFile, schema);
  await writeFile(`${prefix}.prompt.txt`, prompt);
  const args = codexArgs({ model, effort, workspace, instructions: instructionFile, schema: schemaFile, output, skills });
  const started = performance.now();
  try {
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.env.CODEX_BIN || "codex", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout * 1000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    await writeFile(`${prefix}.events.jsonl`, result.stdout);
    await writeFile(`${prefix}.stderr.txt`, result.stderr);
    if (result.code !== 0 || result.timedOut) throw new Error(`Codex failed (${result.timedOut ? "timeout" : result.code}); see ${prefix}.stderr.txt`);
    const usage = parseEvents(result.stdout);
    const sessionId = result.stdout.split("\n").filter(Boolean).map(JSON.parse).find((event) => event.type === "thread.started")?.thread_id;
    const rollout = await readSessionRollout(sessionId);
    await writeFile(`${prefix}.rollout.jsonl`, rollout);
    const input = auditInput(rollout, { prompt, instructions: await text(instructionFile), model, effort, workspace });
    const inputPath = join(dirname(prefix), "..", "call-inputs", `${prefix.split(/[\\/]/).at(-1)}.json`);
    await mkdir(dirname(inputPath), { recursive: true });
    await save(inputPath, input);
    return { response: await json(output), usage, elapsedMs: Math.round(performance.now() - started), inputAudit: { verified: true, file: `call-inputs/${prefix.split(/[\\/]/).at(-1)}.json`, sha256: hash(await text(inputPath)), contextHash: input.contextHash, promptHash: input.promptHash, sessionId } };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function measure(c, response, path) {
  await writeFile(path, response.body);
  const [{ messages }] = await lintFiles(c.type, [path]);
  return {
    characters: [...response.body].length,
    headings: (response.body.match(/^#{1,6}\s/gm) || []).length,
    lint: messages.map(({ ruleId, line, column, message }) => ({ ruleId, line, column, message })),
    exactEdit: c.expectedBody === undefined ? null : response.body.trimEnd() === c.expectedBody.trimEnd()
  };
}

async function exists(path) { try { await readFile(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
export async function pool(items, jobs, task) {
  let next = 0, failed;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await task(item); } catch (error) { failed = error; }
    }
  }));
  if (failed) throw failed;
}

export function aggregate(records, verdicts) {
  const result = {};
  for (const arm of arms) {
    const selected = records.filter((r) => r.arm === arm);
    if (!selected.length) throw new Error(`Missing arm ${arm}`);
    const sum = (fn) => selected.reduce((n, r) => n + fn(r), 0);
    const criterionPasses = Object.fromEntries(dimensions.map((d) => [d, sum((r) => Number(verdicts[r.id][d].pass))]));
    result[arm] = {
      n: selected.length, criterionPasses,
      rubricPasses: Object.values(criterionPasses).reduce((a, b) => a + b, 0), rubricTotal: selected.length * dimensions.length,
      allCriteriaPass: sum((r) => Number(dimensions.every((d) => verdicts[r.id][d].pass))),
      initialLintPass: sum((r) => Number(r.attempts[0].metrics.lint.length === 0)),
      finalLintPass: sum((r) => Number(r.attempts.at(-1).metrics.lint.length === 0)),
      finalLintMessages: sum((r) => r.attempts.at(-1).metrics.lint.length),
      finalCharacters: sum((r) => r.attempts.at(-1).metrics.characters),
      calls: sum((r) => r.attempts.length),
      inputTokens: sum((r) => r.attempts.reduce((n, a) => n + a.usage.input_tokens, 0)),
      cachedInputTokens: sum((r) => r.attempts.reduce((n, a) => n + a.usage.cached_input_tokens, 0)),
      outputTokens: sum((r) => r.attempts.reduce((n, a) => n + a.usage.output_tokens, 0)),
      elapsedMs: sum((r) => r.attempts.reduce((n, a) => n + a.elapsedMs, 0))
    };
  }
  return result;
}

export async function report(out) {
  const manifest = await json(join(out, "manifest.json"));
  const cases = await json(join(out, "cases.json"));
  validateCases(cases);
  const records = [], verdicts = {}, pairs = [];
  for (const planned of manifest.plan) {
    const r = await json(join(out, "records", `${planned.id}.json`));
    if (r.id !== planned.id || !r.attempts.length) throw new Error("Invalid record");
    records.push(r);
  }
  for (let repeat = 1; repeat <= manifest.settings.repeats; repeat++) for (const c of cases) {
    const pair = await json(join(out, "judgments", `${c.id}.${repeat}.json`));
    validateJudge(pair.result.response);
    for (const label of ["A", "B"]) verdicts[`${c.id}.${repeat}.${pair.mapping[label]}`] = pair.result.response[label];
    pairs.push(pair);
  }
  const summary = aggregate(records, verdicts);
  const perCase = cases.map((c) => {
    const row = { id: c.id, title: c.title };
    for (const arm of arms) row[arm] = records.filter((r) => r.caseId === c.id && r.arm === arm).map((r) => ({ id: r.id, score: dimensions.filter((d) => verdicts[r.id][d].pass).length, failures: dimensions.filter((d) => !verdicts[r.id][d].pass), exactEdit: r.attempts.at(-1).metrics.exactEdit }));
    return row;
  });
  const judgeUsage = pairs.reduce((acc, pair) => {
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens"]) acc[field] += pair.result.usage[field];
    return acc;
  }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
  await save(join(out, "summary.json"), { summary, perCase, judgeUsage });
  const a = summary.without_skill, b = summary.with_skill;
  const lines = ["# 執筆指示ベンチマーク", "", "**[本文を左右に並べて読む（HTML）](comparison.html)**。HTMLはダウンロードしてブラウザで開く。GitHub上では下の課題別リンクから、全文・初稿・採点理由をMarkdownで読める。", "", `実行開始: ${manifest.createdAt}。対象: ${manifest.sourceRef ? `${manifest.sourceRef} / ` : ""}${manifest.skillRevision}。`, "", `生成: ${manifest.settings.model} / ${manifest.settings.effort}、評価: ${manifest.settings.judgeModel} / low。${cases.length}課題 × ${manifest.settings.repeats}反復 × 2条件。`, "", "| 指標 | スキルなし | スキルあり |", "|---|---:|---:|",
    `| 評価基準の合格数 | ${a.rubricPasses}/${a.rubricTotal} | ${b.rubricPasses}/${b.rubricTotal} |`,
    `| 全5基準合格の出力 | ${a.allCriteriaPass}/${a.n} | ${b.allCriteriaPass}/${b.n} |`,
    ...dimensions.map((d) => `| ${d} | ${a.criterionPasses[d]}/${a.n} | ${b.criterionPasses[d]}/${b.n} |`),
    `| 初稿lint合格 | ${a.initialLintPass}/${a.n} | ${b.initialLintPass}/${b.n} |`,
    `| 最終稿lint合格 | ${a.finalLintPass}/${a.n} | ${b.finalLintPass}/${b.n} |`,
    `| 最終稿lint指摘数 | ${a.finalLintMessages} | ${b.finalLintMessages} |`,
    `| 平均本文文字数 | ${(a.finalCharacters/a.n).toFixed(1)} | ${(b.finalCharacters/b.n).toFixed(1)} |`,
    `| 生成呼び出し数（修正含む） | ${a.calls} | ${b.calls} |`,
    `| 入力トークン（cache込み） | ${a.inputTokens} | ${b.inputTokens} |`,
    `| 内cache入力トークン | ${a.cachedInputTokens} | ${b.cachedInputTokens} |`,
    `| 出力トークン | ${a.outputTokens} | ${b.outputTokens} |`,
    `| 平均生成時間・秒（修正含む） | ${(a.elapsedMs/a.n/1000).toFixed(1)} | ${(b.elapsedMs/b.n/1000).toFixed(1)} |`, "", "## 課題別", "", "各セルは反復ごとの合格基準数（5点満点）。", "", "| 課題 | なし | あり |", "|---|---|---|",
    ...perCase.map((c) => `| ${c.title} | ${c.without_skill.map((r) => r.score).join(", ")} | ${c.with_skill.map((r) => r.score).join(", ")} |`),
    "", "## 本文・初稿・採点理由を読む", "", "各比較には、原依頼、両条件の最終稿全文、注記、5基準の判定理由、修正前の初稿とlint指摘を収めている。本文だけのMarkdownにも移動できる。", "", ...perCase.map((c) => `- ${c.title}: ${Array.from({length: manifest.settings.repeats}, (_, i) => `[${i + 1}回目](comparisons/${c.id}.${i + 1}.md)`).join("、")}。`),
    "", "## 解釈の範囲", "", "これはSKILL.mdと関連資料を明示的に付与する比較であり、スキルの自動発火、親子エージェントの委譲、意味確認からの修正、モデル昇格は測っていない。lint修正の条件は実行時のmanifest.jsonを参照する。旧実行は両条件に指摘を返したため、スキルの有無による比較として扱わない。新しい実行系はスキルなし側に指摘を返さないが、モデル入力の分離は別途検証が必要である。意味基準は最終稿だけを採点する。", "", "判定は条件名を伏せ、A/Bの位置を均衡化した単一LLMによるもの。人間の盲検評価ではなく、採点の誤りと同系モデルの傾向が残る。課題は作成者がPRの狙いから選んだ10種で、うちADR・進捗・不足手順・部分修正は既存の動作確認を別の題材にした。独立したホールドアウトや40種全体の代表標本ではない。反復数は課題ごとの揺れを観測するもので、基準数を独立標本として扱わない。有意差・一般的な優位・金額の削減率は主張しない。", "", "文字数だけでは品質を判定しない。トークンはCLI報告の実測値で、入力はcacheを含む。時間は並列実行・接続・cacheの影響を含む。評価モデルの利用量はsummary.jsonのjudgeUsageに別計上する。", ""];
  await writeFile(join(out, "report.md"), validityMarkdown(manifest.fingerprint) + lines.join("\n"));
  await writeReadableReports({ out, manifest, cases, records, verdicts });
  return summary;
}

function options(argv) {
  const [command, ...args] = argv;
  const o = { command, repeats: 2, seed: "20260906", jobs: 2, timeout: 180, effort: "low", resume: false, dryRun: false };
  const names = { "--out": "out", "--model": "model", "--judge-model": "judgeModel", "--repeats": "repeats", "--seed": "seed", "--jobs": "jobs", "--timeout": "timeout", "--effort": "effort", "--cases": "caseIds", "--source-ref": "sourceRef" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") o.resume = true;
    else if (args[i] === "--dry-run") o.dryRun = true;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) o[names[args[i]]] = args[++i];
    else throw new Error(`Unknown/missing option: ${args[i]}`);
  }
  if (!["run", "report"].includes(command) || !o.out) throw new Error("Usage: node benchmarks/benchmark.mjs run --out DIR --model MODEL --judge-model MODEL [--repeats 2 --seed 20260906 --jobs 2 --resume --dry-run] | report --out DIR");
  for (const field of ["repeats", "jobs", "timeout"]) { o[field] = Number(o[field]); if (!Number.isInteger(o[field]) || o[field] < 1) throw new Error(`Invalid ${field}`); }
  if (o.jobs > 8) throw new Error("Maximum jobs is 8");
  if (command === "run" && (!o.model || !o.judgeModel)) throw new Error("Both model IDs must be explicit");
  o.out = resolve(o.out);
  return o;
}

async function run(o) {
  const allCases = await json(join(bench, "cases.json"));
  validateCases(allCases);
  const cases = o.caseIds ? o.caseIds.split(",").map((id) => {
    const c = allCases.find((c) => c.id === id); if (!c) throw new Error(`Unknown case ${id}`); return c;
  }) : allCases;
  validateCases(cases);
  const files = {};
  for (const name of ["SKILL.md", "references/delegation.md", "references/japanese.md", "references/structure.md", "references/document-types.md", ...await typeFiles()]) files[name] = await text(join(root, name));
  const sourceHashes = {};
  for (const name of [...Object.keys(files), "package-lock.json", ".textlintrc.json", "scripts/lint.mjs", "benchmarks/benchmark.mjs", "benchmarks/input-audit.mjs", "benchmarks/runtime-context.json", "benchmarks/readable-report.mjs", "benchmarks/comparison.css", "benchmarks/comparison.js", "benchmarks/cases.json", "benchmarks/author-instructions.txt", "benchmarks/judge-instructions.txt", "benchmarks/author.schema.json", ...await ruleFiles()]) sourceHashes[name] = hash(await text(join(root, name)));
  const settings = { model: o.model, judgeModel: o.judgeModel, effort: o.effort, repeats: o.repeats, seed: o.seed, jobs: o.jobs, timeout: o.timeout, maxLintRevisions: { without_skill: 0, with_skill: 1 } };
  const plan = makePlan(cases, o.repeats, o.seed);
  const contexts = Object.fromEntries(cases.map((c) => [c.id, skillContext(c, files)]));
  let sourceRevision = null;
  if (o.sourceRef) {
    sourceRevision = execFileSync("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", `${o.sourceRef}^{commit}`], { encoding: "utf8" }).trim();
    verifySourceSnapshot(sourceHashes, (name) => execFileSync("git", ["-C", root, "show", `${sourceRevision}:${name}`]));
  }
  const specification = { settings, sourceHashes, sourceRef: o.sourceRef ?? null, sourceRevision, caseIds: cases.map((c) => c.id), plan };
  if (o.dryRun) { console.log(JSON.stringify(specification, null, 2)); return; }
  const skills = await disabledSkills();
  const fingerprint = hash(JSON.stringify(specification));
  const manifestPath = join(o.out, "manifest.json");
  if (o.resume) {
    const old = await json(manifestPath);
    if (old.fingerprint !== fingerprint) throw new Error("Resume rejected: inputs, harness, or settings changed; use a new output directory");
  } else {
    await mkdir(dirname(o.out), { recursive: true });
    await mkdir(o.out); // Refuse overwrite, even for a partially initialized run.
    await save(manifestPath, {
      createdAt: new Date().toISOString(), fingerprint, ...specification,
      skillRevision: sourceRevision ?? execFileSync("git", ["-C", root, "log", "-1", "--format=%H", "--", "SKILL.md", "references", "rules", "scripts/lint.mjs", ".textlintrc.json", "package-lock.json"], { encoding: "utf8" }).trim(),
      checkoutRevision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      skillWorktreeDirty: Boolean(execFileSync("git", ["-C", root, "status", "--porcelain", "--", "SKILL.md", "references", "rules", "scripts/lint.mjs", ".textlintrc.json", "package-lock.json"], { encoding: "utf8" }).trim()),
      codexVersion: execFileSync(process.env.CODEX_BIN || "codex", ["--version"], { encoding: "utf8" }).trim(),
      nodeVersion: process.version, disabledSkillPaths: skills.length,
      isolation: { verification: "per-response saved-session input audit", requested: { userConfig: false, projectInstructions: "fixed shared AGENTS instructions pinned in runtime-context.json", nativeSkills: false, plugins: false, tools: false, history: "new saved session per call; never resume model conversations", builtInInstructions: "replaced by checked-in instruction file" }, evidence: "Every accepted response has a saved-session input audit in call-inputs; unexpected context or prompt fails the run" }
    });
    await save(join(o.out, "cases.json"), cases);
    await save(join(o.out, "skill-snapshot.json"), files);
  }
  for (const directory of ["records", "calls", "judgments"]) await mkdir(join(o.out, directory), { recursive: true });
  const authorSchema = await json(join(bench, "author.schema.json"));
  await pool(plan, o.jobs, async (p) => {
    const recordPath = join(o.out, "records", `${p.id}.json`);
    if (await exists(recordPath)) return;
    const c = cases.find((c) => c.id === p.caseId);
    const attempts = [];
    for (let attempt = 0; attempt <= settings.maxLintRevisions[p.arm]; attempt++) {
      const previous = attempts.at(-1);
      const prompt = authorPrompt(c, p.arm, contexts[c.id], previous?.response, previous?.metrics.lint);
      const prefix = join(o.out, "calls", `${p.id}.${attempt}`);
      const result = await callModel({ model: o.model, effort: o.effort, prompt, schema: authorSchema, instructionFile: join(bench, "author-instructions.txt"), prefix, timeout: o.timeout, skills });
      validateAuthor(result.response);
      const metrics = await measure(c, result.response, `${prefix}.md`);
      attempts.push({ ...result, metrics, promptHash: hash(prompt) });
      if (!metrics.lint.length) break;
    }
    await save(recordPath, { ...p, attempts });
    console.log(`generated ${p.id}: ${attempts.length} call(s), ${attempts.at(-1).metrics.lint.length} lint message(s)`);
  });
  const pairPlan = [];
  for (let repeat = 1; repeat <= o.repeats; repeat++) for (const [i, c] of cases.entries()) pairPlan.push({ c, repeat, swap: (i + repeat) % 2 === 0 });
  await pool(pairPlan, o.jobs, async ({ c, repeat, swap }) => {
    const pairId = `${c.id}.${repeat}`, dest = join(o.out, "judgments", `${pairId}.json`);
    if (await exists(dest)) return;
    const mapping = { A: arms[Number(swap)], B: arms[Number(!swap)] };
    const candidates = {};
    for (const label of ["A", "B"]) candidates[label] = (await json(join(o.out, "records", `${pairId}.${mapping[label]}.json`))).attempts.at(-1).response;
    const prompt = `原依頼と資料:\n${c.prompt}\n\n判定基準（各基準は全条件を満たした場合だけpass=true）:\n${JSON.stringify(c.criteria)}\n\n候補（本文bodyと本文外notes）:\n${JSON.stringify(candidates)}`;
    const result = await callModel({ model: o.judgeModel, effort: "low", prompt, schema: judgeSchema(), instructionFile: join(bench, "judge-instructions.txt"), prefix: join(o.out, "calls", `${pairId}.judge`), timeout: o.timeout, skills });
    validateJudge(result.response);
    await save(dest, { caseId: c.id, repeat, mapping, result, promptHash: hash(prompt) });
    console.log(`judged ${pairId}`);
  });
  console.log(JSON.stringify(await report(o.out), null, 2));
}

export async function main(argv) {
  const o = options(argv);
  if (o.command === "report") console.log(JSON.stringify(await report(o.out), null, 2));
  else await run(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

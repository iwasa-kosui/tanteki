import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, hash, authorPrompt, skillContext } from './benchmark.mjs';
import { reviewPrompt } from './document-review.mjs';
const read = (path) => readFile(path, 'utf8');
const json = async (path) => JSON.parse(await read(path));

// Publication gate: match every accepted call to its archived effective input,
// then independently reconstruct the requested prompt from frozen source data.
export async function verifyRunInputs(out) {
  const manifest = await json(join(out, 'manifest.json'));
  const cases = await json(join(out, 'cases.json'));
  const snapshot = await json(join(out, 'skill-snapshot.json'));
  const expectedContexts = await json(join(root, 'benchmarks/runtime-context.json'));
  const contextHashes = Object.fromEntries(Object.entries(expectedContexts).map(([model, context]) => [model, context.hash]));
  const sessions = new Set();
  let authorCalls = 0, judgeCalls = 0, reviewCalls = 0;
  async function check(directory, attempt, prompt, model, effort, instructions) {
    const expectedContext = expectedContexts[model]?.messages;
    const contextHash = contextHashes[model];
    const audit = attempt.inputAudit;
    if (!audit?.verified || !/^call-inputs\/[a-zA-Z0-9_.-]+\.json$/.test(audit.file)) throw new Error('Missing saved-session input audit');
    const body = await read(join(directory, audit.file));
    const exported = await json(join(directory, 'input-export.json')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    const mapping = exported?.files[audit.file];
    const expectedHash = mapping?.originalSha256 === audit.sha256 ? mapping.exportedSha256 : audit.sha256;
    if (hash(body) !== expectedHash) throw new Error('Input evidence hash mismatch');
    const input = JSON.parse(body);
    if (input.prompt !== prompt || input.promptHash !== hash(prompt) || audit.promptHash !== hash(prompt)) throw new Error('Archived input differs from expected prompt');
    if (input.model !== model || input.effort !== effort || input.baseInstructions !== instructions.trimEnd()) throw new Error('Archived model/instructions mismatch');
    if (JSON.stringify(input.context) !== JSON.stringify(expectedContext) || input.contextHash !== contextHash || audit.contextHash !== contextHash) throw new Error('Unexpected shared input context');
    if (!input.sessionId || sessions.has(input.sessionId) || input.sessionId !== audit.sessionId) throw new Error('Reused/mismatched model session');
    sessions.add(input.sessionId);
  }
  const authorInstructions = await read(join(root, 'benchmarks/author-instructions.txt'));
  const judgeInstructions = await read(join(root, 'benchmarks/judge-instructions.txt'));
  const records = new Map();
  if (JSON.stringify(manifest.settings.maxLintRevisions) !== JSON.stringify({ without_skill: 0, with_skill: 1 })) throw new Error('Contaminated/unknown baseline revision policy');
  for (const item of manifest.plan) {
    const record = await json(join(out, 'records', `${item.id}.json`));
    const task = cases.find((c) => c.id === item.caseId);
    if (!task || record.id !== item.id || record.arm !== item.arm || record.attempts.length < 1 || record.attempts.length > (item.arm === 'without_skill' ? 1 : 2)) throw new Error('Invalid baseline/treatment record');
    for (const [index, attempt] of record.attempts.entries()) {
      const previous = record.attempts[index - 1];
      const prompt = authorPrompt(task, item.arm, skillContext(task, snapshot), previous?.response, previous?.metrics.lint);
      await check(out, attempt, prompt, manifest.settings.model, manifest.settings.effort, authorInstructions);
      authorCalls++;
    }
    records.set(item.id, record);
  }
  for (let repeat = 1; repeat <= manifest.settings.repeats; repeat++) for (const task of cases) {
    const pairId = `${task.id}.${repeat}`;
    const pair = await json(join(out, 'judgments', `${pairId}.json`));
    const candidates = {};
    for (const label of ['A', 'B']) candidates[label] = records.get(`${pairId}.${pair.mapping[label]}`).attempts.at(-1).response;
    const prompt = `原依頼と資料:\n${task.prompt}\n\n判定基準（各基準は全条件を満たした場合だけpass=true）:\n${JSON.stringify(task.criteria)}\n\n候補（本文bodyと本文外notes）:\n${JSON.stringify(candidates)}`;
    await check(out, pair.result, prompt, manifest.settings.judgeModel, 'low', judgeInstructions);
    judgeCalls++;
  }
  const review = join(out, 'document-review');
  const reviewManifest = await json(join(review, 'manifest.json'));
  if (reviewManifest.sourceEvaluation.fingerprint !== manifest.fingerprint) throw new Error('Review belongs to another run');
  for (const entry of reviewManifest.entries) {
    const record = records.get(entry.recordId);
    const original = record?.attempts.at(-1).response.body;
    const artifact = await read(join(review, 'artifacts', `${entry.recordId}.md`));
    const input = await json(join(review, 'inputs', `${entry.reviewId}.json`));
    const task = cases.find((c) => c.id === record?.caseId);
    if (original !== artifact || hash(artifact) !== entry.bodyHash || input.body !== original.replace(/\r\n/g, '\n').replace(/\n+$/, '') || input.request !== task?.prompt) throw new Error('Published/reviewed text differs from original generation');
  }
  const reviewInstructions = await read(join(review, 'instructions.txt'));
  for (const { reviewId } of reviewManifest.inputHashes) {
    const input = await json(join(review, 'inputs', `${reviewId}.json`));
    const saved = await json(join(review, 'reviews', `${reviewId}.json`));
    let correction = '';
    for (const attempt of saved.attempts) {
      await check(review, attempt, reviewPrompt(input) + correction, reviewManifest.model, reviewManifest.effort, reviewInstructions);
      reviewCalls++;
      correction = `\n\n前回のレビューは、引用の完全一致または出力構造の検証に失敗しました。次のエラーだけを修正し、内容の評価を点数や他候補へ合わせないでください。原文に根拠がない指摘は撤回してください。\n${attempt.validationErrors}\n前回の出力:\n${JSON.stringify(attempt.response)}`;
    }
  }
  return { outputs: records.size, authorCalls, judgeCalls, reviewCalls, uniqueSessions: sessions.size, contextHashes };
}

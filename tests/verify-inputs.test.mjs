import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from '../benchmarks/benchmark.mjs';
import { verifyRunInputs } from '../benchmarks/verify-inputs.mjs';
const source = join(root, 'benchmarks/results/2026-09-20-isolated-ca1c0eb');
test('publication verifies every generation, judgment and review input from the corrected run', async () => {
  const checked = await verifyRunInputs(source);
  assert.equal(checked.outputs, 40);
  assert.equal(checked.judgeCalls, 20);
  assert.equal(checked.uniqueSessions, checked.authorCalls + checked.judgeCalls + checked.reviewCalls);
});
test('publication rejects the old baseline that received skill feedback', async () => {
  await assert.rejects(verifyRunInputs(join(root, 'benchmarks/results/2026-09-20-main-ca1c0eb')), /baseline revision policy/);
});
test('publication rejects edited original bodies and altered archived prompts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tanteki-publication-test-'));
  try {
    await cp(source, temp, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('calls') });
    const artifact = join(temp, 'document-review/artifacts/adr-boundary.1.without_skill.md');
    const original = await readFile(artifact, 'utf8');
    await writeFile(artifact, original + '\nUnaudited edit');
    await assert.rejects(verifyRunInputs(temp), /differs from original generation/);
    await writeFile(artifact, original);
    const prompt = join(temp, 'call-inputs/adr-boundary.1.without_skill.0.json');
    await writeFile(prompt, (await readFile(prompt, 'utf8')).replace('依頼と原資料', '追加したスキル指示'));
    await assert.rejects(verifyRunInputs(temp), /hash mismatch/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

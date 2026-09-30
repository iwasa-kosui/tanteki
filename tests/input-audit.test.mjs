import test from 'node:test';
import assert from 'node:assert/strict';
import { auditInput, contextFingerprint } from '../benchmarks/input-audit.mjs';
const context = [
  { role: 'developer', content: [{ type: 'input_text', text: 'Fixed runtime permissions.' }] },
  { role: 'user', content: [{ type: 'input_text', text: '<cwd><WORKSPACE></cwd><current_date><DATE></current_date>' }] },
];
const profiles = { 'gpt-5.6-luna': contextFingerprint(context) };
const options = { prompt: '依頼と原資料だけ', instructions: 'common instructions\n', model: 'gpt-5.6-luna', effort: 'low', workspace: '/tmp/test-workspace' };
const fixture = () => [
  { type: 'session_meta', payload: { id: 'test-session', cwd: options.workspace, base_instructions: { text: options.instructions.trimEnd() } } },
  { type: 'turn_context', payload: { cwd: options.workspace, model: options.model, effort: options.effort } },
  ...context.map((m) => ({ type: 'response_item', payload: { type: 'message', role: m.role, content: m.content.map((c) => ({ ...c, text: c.text.replaceAll('<WORKSPACE>', options.workspace).replaceAll('<DATE>', '2026-09-21') })) } })),
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: options.prompt }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '本文' }] } },
];
const serialize = (rows) => rows.map(JSON.stringify).join('\n');
test('saved input audit accepts only the pinned shared context and exact requested prompt', () => {
  const result = auditInput(serialize(fixture()), options, profiles);
  assert.equal(result.prompt, options.prompt);
  assert.deepEqual(result.context, profiles[options.model].messages);
  assert.equal(result.baseInstructions, options.instructions.trimEnd());
});
test('saved input audit rejects skills, altered instructions, other prompts, history and tools', () => {
  for (const mutate of [
    (r) => { r[2].payload.content[0].text += '\n<skills_instructions>tanteki</skills_instructions>'; },
    (r) => { r[0].payload.base_instructions.text += '\nWrite concisely'; },
    (r) => { r.at(-2).payload.content[0].text += '\nlint: remove tracking'; },
    (r) => { r.push({ type: 'turn_context', payload: {} }); },
    (r) => { r.splice(2, 0, { type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'extra system context' }] } }); },
    (r) => { r.push({ type: 'response_item', payload: { type: 'function_call', name: 'read_skill' } }); },
    (r) => { r[1].payload.model = 'substituted-model'; },
  ]) {
    const rows = fixture(); mutate(rows);
    assert.throws(() => auditInput(serialize(rows), options, profiles), /Input audit/);
  }
});

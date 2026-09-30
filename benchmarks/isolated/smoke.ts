/** Real Docker + Codex, scripted Responses API. No credentials or paid model calls. */
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { generate, grade, report, loadLock, readRun } from "./cli.ts";
import { decode } from "./validation.ts";
import { options } from "./options.ts";
import { docker, runModel, exportBundle, type Transport } from "./docker.ts";
import { publicJob } from "./protocol.ts";
import { AuthorResponse } from "./job.ts";

const [lockPath, directory] = process.argv.slice(2);
assert.ok(lockPath && directory, "Usage: tsx benchmarks/isolated/smoke.ts LOCK OUT");
const out = resolve(directory);
const lock = await loadLock(lockPath);
let sequence = 0;
process.env.ISOLATED_SMOKE_CANARY = "host-only-test-value";

function replyItems(items: Record<string, unknown>[]): Response {
  const id = `resp_mock_${++sequence}`;
  const response = { id, object: "response", status: "completed", output: items, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: 0 }, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...items.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]),
    { type: "response.completed", response }
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function reply(value: unknown): Response {
  return replyItems([{ id: `msg_${sequence + 1}`, type: "message", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }]);
}
const requestSchema = z.looseObject({ input: z.array(z.record(z.string(), z.unknown())) });
const body = "# 動作検証\n\n担当者は、公開前に資料の事実を確認します。\n";
const author: Transport = async (bytes) => {
  const request = decode(requestSchema, JSON.parse(bytes.toString()));
  const toolResults = request.input.filter((item) => item.type === "function_call_output");
  const withSkill = bytes.includes(Buffer.from("<skills_instructions>"));
  if (!toolResults.length) {
    const script = [
      "const fs=require('node:fs'),assert=require('node:assert/strict');",
      "assert.equal(process.getuid(),1000);",
      "assert.equal(process.env.ISOLATED_SMOKE_CANARY,undefined);",
      "assert.equal(process.env.OPENAI_API_KEY,undefined);",
      "assert.ok(Object.values(require('node:os').networkInterfaces()).flat().every(i=>i.internal));",
      "assert.throws(()=>fs.writeFileSync('/input/job.json','modified'),{code:'EROFS'});",
      withSkill
        ? "console.log(fs.readFileSync('/home/agent/.agents/skills/tanteki/SKILL.md','utf8'));fs.writeFileSync('/workspace/document.md','担当者は公開前に資料を確認します。');"
        : "assert.ok(!fs.existsSync('/opt/skill'));assert.ok(!fs.existsSync('/home/agent/.agents/skills/tanteki'));assert.throws(()=>require.resolve('textlint'));",
      "console.log('SMOKE_VERIFIED');"
    ].join("");
    const quoted = "'" + script.replaceAll("'", "'\\''") + "'";
    return replyItems([{ type: "function_call", id: `fc_${sequence + 1}`, call_id: `call_${sequence + 1}`, name: "exec_command", arguments: JSON.stringify({ cmd: `node -e ${quoted}`, max_output_tokens: 20000, yield_time_ms: 10000 }), status: "completed" }]);
  }
  assert.ok(JSON.stringify(toolResults).includes("SMOKE_VERIFIED"), JSON.stringify(toolResults));
  if (withSkill && toolResults.length === 1) return replyItems([{ type: "function_call", id: `fc_${sequence + 1}`, call_id: `call_${sequence + 1}`, name: "exec_command", arguments: JSON.stringify({ cmd: "node /home/agent/.agents/skills/tanteki/scripts/lint.mjs --type stock /workspace/document.md", yield_time_ms: 10000 }), status: "completed" }]);
  return reply({ body, notes: "Scripted integration test, not a quality measurement." });
};
const generateOptions = options(["generate", "--lock", lockPath, "--out", join(out, "generation"), "--model", "gpt-5.4", "--cases", "design-doc", "--repeats", "1", "--timeout", "60"]);
assert.equal(generateOptions.action, "generate");
if (generateOptions.action !== "generate") throw new Error("Unexpected options");
// Resolve a real case id rather than depending on a particular suite's naming convention.
const cases = decode(z.array(z.object({ id: z.string() })).min(1), JSON.parse(await readFile(new URL("../cases.json", import.meta.url), "utf8")));
const result = await generate({ ...generateOptions, caseIds: cases[0].id }, author);
assert.ok("records" in result);
if (!("records" in result)) throw new Error("Unexpected dry run");
for (const record of result.records) assert.equal(record.status, "valid", JSON.stringify(record));
for (const record of result.records) {
  assert.equal(record.modelCalls, record.arm === "with_skill" ? 3 : 2);
  assert.equal(record.observations.skillTextSeen, record.arm === "with_skill");
  assert.equal(record.observations.lintCommandSeen, record.arm === "with_skill");
}
assert.equal(new Set(result.records.map((r) => r.containerId)).size, 2);
assert.equal(new Set(result.records.map((r) => r.jobHash)).size, 1);
assert.equal(new Set(result.records.map((r) => r.environmentHash)).size, 1);
assert.equal((await readRun(join(out, "generation"))).pairs.length, 1);

const candidate = Object.fromEntries(["facts", "grounding", "role", "clarity", "economy"].map((key) => [key, { pass: true, evidence: "Mock judge." }]));
const judge: Transport = async (bytes) => {
  const raw = bytes.toString();
  assert.ok(raw.includes("Scripted integration test"), "Notes required by the rubric were dropped");
  assert.ok(!raw.includes("without_skill") && !raw.includes("with_skill"), "Condition labels leaked to judge");
  return reply({ A: candidate, B: candidate });
};
const evaluation = await grade({ action: "grade", run: join(out, "generation"), out: join(out, "grade"), model: "gpt-5.4", effort: "low", timeout: 60 }, judge);
assert.ok(evaluation.sealed);
assert.equal(Object.keys(evaluation.lint).length, 2);
for (const pair of Object.values(evaluation.pairs)) assert.equal(pair.status, "valid", JSON.stringify(pair));
await report({ action: "report", run: join(out, "generation"), evaluation: join(out, "grade"), out: join(out, "report") });

const failed = await runModel({ image: lock.runtimeImage, bundle: null, bundlePath: null, job: publicJob({ prompt: "テスト" }, { model: "gpt-5.4", effort: "low" }), directory: join(out, "provider-failure"), timeout: 30, maxCalls: 1, transport: async () => new Response("Provider deliberately unavailable", { status: 503 }), responseSchema: AuthorResponse.schema });
assert.equal(failed.status, "execution_failed", JSON.stringify(failed));
assert.ok(!await docker(["ps", "-aq", "--filter", `id=${failed.containerId}`]), "Failed container leaked");
// Deliberately contaminate the baseline: preflight must reject it before the API.
const bundle = await exportBundle(lock.bundleImage, lock.bundleInventory);
try {
  let calls = 0;
  const contaminated = await runModel({ image: lock.runtimeImage, bundle: null, bundlePath: bundle.path, job: publicJob({ prompt: "テスト" }, { model: "gpt-5.4", effort: "low" }), directory: join(out, "contaminated-baseline"), timeout: 30, maxCalls: 1, transport: async () => { calls++; return reply({ body, notes: "" }); }, responseSchema: AuthorResponse.schema });
  assert.equal(contaminated.status, "invalid_environment", JSON.stringify(contaminated));
  assert.equal(calls, 0, "Contaminated baseline reached the model");
  assert.ok(!await docker(["ps", "-aq", "--filter", `id=${contaminated.containerId}`]), "Contaminated container leaked");
} finally { await rm(bundle.directory, { recursive: true, force: true }); }
// Frozen generation must reject even a one-byte change, including after grading.
const target = join(out, "generation", "records", `${result.records[0].id}.json`);
const original = await readFile(target, "utf8");
await writeFile(target, original + "\n");
await assert.rejects(readRun(join(out, "generation")), /Frozen records changed/);
await writeFile(target, original);
console.log("Docker/Codex integration smoke passed (scripted provider; no quality claims).");

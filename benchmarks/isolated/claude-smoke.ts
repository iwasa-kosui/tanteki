/** Real Docker + Claude Code, scripted Anthropic Messages API. No credentials or paid model calls. */
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generate, grade, report, loadLock, readRun } from "./cli.ts";
import { decode } from "./validation.ts";
import { options } from "./options.ts";
import { command, docker, runModel, exportBundle, type Transport } from "./docker.ts";
import { publicJob } from "./protocol.ts";
import { AuthorResponse } from "./job.ts";
import { readPublication } from "./publication.ts";

const [lockPath, directory] = process.argv.slice(2);
assert.ok(lockPath && directory, "Usage: tsx benchmarks/isolated/claude-smoke.ts LOCK OUT");
const out = resolve(directory);
const lock = await loadLock(lockPath);
assert.equal(lock.protocol, "tanteki-isolated-claude-v1", "The lock must come from build --provider claude");
const claudeVersion = lock.claudeVersion;
const model = "claude-sonnet-5-5";
let sequence = 0;
process.env.ISOLATED_SMOKE_CANARY = "host-only-test-value";
process.env.ANTHROPIC_API_KEY = "sk-ant-host-only-canary";

function stream(content: Record<string, unknown>[], stopReason: string): Response {
  const id = `msg_mock_${++sequence}`;
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    ...content.flatMap((block, index): Record<string, unknown>[] => block.type === "tool_use"
      ? [{ type: "content_block_start", index, content_block: { ...block, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }, { type: "content_block_stop", index }]
      : [{ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }, { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" }
  ];
  return new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const toolUse = (name: string, input: unknown) => stream([{ type: "tool_use", id: `toolu_mock_${sequence + 1}`, name, input }], "tool_use");

const block = z.looseObject({ type: z.string(), name: z.string().optional(), content: z.unknown().optional() });
const requestSchema = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(block)]) })), tools: z.array(z.looseObject({ name: z.string() })) });
const blocks = (request: z.infer<typeof requestSchema>, role: string) => request.messages.filter((m) => m.role === role).flatMap((m) => typeof m.content === "string" ? [] : m.content);

const body = "# 動作検証\n\n担当者は、公開前に資料の事実を確認します。\n";
const notes = "Scripted integration test, not a quality measurement.";
const verification = (withSkill: boolean) => [
  "const fs=require('node:fs'),assert=require('node:assert/strict');",
  "assert.equal(process.getuid(),1000);",
  "assert.equal(process.env.ISOLATED_SMOKE_CANARY,undefined);",
  "assert.equal(process.env.OPENAI_API_KEY,undefined);",
  // The dummy relay key may be present; the host's real key never is.
  "assert.ok(['sk-ant-local-relay-only',undefined].includes(process.env.ANTHROPIC_API_KEY),'real API key visible');",
  "assert.ok(Object.values(require('node:os').networkInterfaces()).flat().every(i=>i.internal));",
  "assert.throws(()=>fs.writeFileSync('/input/job.json','modified'),{code:'EROFS'});",
  withSkill
    ? "assert.ok(fs.existsSync('/home/agent/.claude/skills/tanteki/SKILL.md'));"
    : "assert.ok(!fs.existsSync('/opt/skill'));assert.ok(!fs.existsSync('/home/agent/.claude/skills/tanteki'));assert.throws(()=>require.resolve('textlint'));",
  "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(()=>{throw new Error('external network reachable')},()=>console.log('SMOKE_VERIFIED'));"
].join("");
const quote = (script: string) => "'" + script.replaceAll("'", "'\\''") + "'";
const lintCommand = "node /home/agent/.claude/skills/tanteki/scripts/lint.mjs --type stock /workspace/document.md";
const resultText = (results: z.infer<typeof block>[]) => JSON.stringify(results.map((r) => r.content));

const author: Transport = async (bytes) => {
  const request = decode(requestSchema, JSON.parse(bytes.toString()));
  const withSkill = bytes.includes(Buffer.from("- tanteki: "));
  const used = blocks(request, "assistant").filter((b) => b.type === "tool_use").map((b) => b.name);
  const results = blocks(request, "user").filter((b) => b.type === "tool_result");
  const skillTool = request.tools.find((tool) => tool.name === "Skill") as { input_schema?: { properties?: Record<string, unknown> } } | undefined;
  if (!used.length) return toolUse("Bash", { command: `node -e ${quote(verification(withSkill))}`, description: "verify isolation" });
  if (used.length === 1) assert.ok(resultText(results).includes("SMOKE_VERIFIED"), resultText(results));
  const final = () => toolUse("StructuredOutput", { body, notes });
  if (!withSkill) return final();
  switch (used.length) {
    case 1: return toolUse("Skill", { [Object.keys(skillTool?.input_schema?.properties ?? { skill: 0 })[0]]: "tanteki" });
    case 2: return toolUse("Write", { file_path: "/workspace/document.md", content: "担当者は公開前に資料を確認します。" });
    case 3: return toolUse("Bash", { command: lintCommand, description: "lint the draft" });
    default: return final();
  }
};

const generateOptions = options(["generate", "--lock", lockPath, "--out", join(out, "generation"), "--model", model, "--provider", "claude", "--cases", "design-doc", "--repeats", "1", "--timeout", "120"]);
assert.equal(generateOptions.action, "generate");
if (generateOptions.action !== "generate") throw new Error("Unexpected options");
const cases = decode(z.array(z.object({ id: z.string() })).min(1), JSON.parse(await readFile(new URL("../cases.json", import.meta.url), "utf8")));
const result = await generate({ ...generateOptions, caseIds: cases[0].id }, author);
assert.ok("records" in result);
if (!("records" in result)) throw new Error("Unexpected dry run");
for (const record of result.records) assert.equal(record.status, "valid", JSON.stringify(record));
for (const record of result.records) {
  assert.equal(record.modelCalls, record.arm === "with_skill" ? 5 : 2, JSON.stringify(record));
  assert.equal(record.observations.skillTextSeen, record.arm === "with_skill", `skillTextSeen ${record.arm}`);
  assert.equal(record.observations.lintCommandSeen, record.arm === "with_skill", `lintCommandSeen ${record.arm}`);
}
assert.equal(new Set(result.records.map((r) => r.containerId)).size, 2);
assert.equal(new Set(result.records.map((r) => r.jobHash)).size, 1);
assert.equal(new Set(result.records.map((r) => r.environmentHash)).size, 1, "Normalized requests differ between arms");
assert.equal(result.manifest.protocol, "tanteki-isolated-claude-v1");
assert.equal(result.manifest.provider, "claude");
assert.equal((await readRun(join(out, "generation"))).pairs.length, 1);

const candidate = Object.fromEntries(["facts", "grounding", "role", "clarity", "economy"].map((key) => [key, { pass: true, evidence: "Mock judge." }]));
const judge: Transport = async (bytes) => {
  const raw = bytes.toString();
  assert.ok(raw.includes("Scripted integration test"), "Notes required by the rubric were dropped");
  assert.ok(!raw.includes("without_skill") && !raw.includes("with_skill"), "Condition labels leaked to judge");
  return toolUse("StructuredOutput", { A: candidate, B: candidate });
};
const evaluation = await grade({ action: "grade", run: join(out, "generation"), out: join(out, "grade"), model, effort: "low", timeout: 120, provider: "claude" }, judge);
assert.ok(evaluation.sealed);
assert.equal(evaluation.protocol, "tanteki-isolated-claude-v1");
assert.equal(Object.keys(evaluation.lint).length, 2);
for (const pair of Object.values(evaluation.pairs)) assert.equal(pair.status, "valid", JSON.stringify(pair));
await report({ action: "report", run: join(out, "generation"), evaluation: join(out, "grade"), out: join(out, "report") });

// The publication verifier must accept what the harness produced, using the same normalization.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const published = join(out, "publication");
await command(process.execPath, ["--import", "tsx", join(root, "scripts/publish-benchmark.ts"), "--run", join(out, "generation"), "--evaluation", join(out, "grade"), "--out", published], { timeout: 120000 });
assert.equal((await readPublication(published)).manifest.protocol, "tanteki-isolated-claude-v1");

const claudeRun = { image: lock.runtimeImage, provider: "claude", claudeVersion, timeout: 60, maxCalls: 1, responseSchema: AuthorResponse.schema } as const;
const job = publicJob({ prompt: "テスト" }, { model, effort: "low" }, "claude");
// A generous budget proves the single call comes from stopping at the first failure, not from the call limit.
let unavailableCalls = 0;
const failed = await runModel({ ...claudeRun, maxCalls: 8, bundle: null, bundlePath: null, job, directory: join(out, "provider-failure"), transport: async () => { unavailableCalls++; return new Response("Provider deliberately unavailable", { status: 503 }); } });
assert.equal(failed.status, "execution_failed", JSON.stringify(failed));
assert.equal(unavailableCalls, 1, "A failed provider response must not be followed by more API requests");
assert.ok(!await docker(["ps", "-aq", "--filter", `id=${failed.containerId}`]), "Failed container leaked");
// Deliberately contaminate the baseline: preflight must reject it before the API.
const bundle = await exportBundle(lock.bundleImage, lock.bundleInventory);
try {
  let calls = 0;
  const contaminated = await runModel({ ...claudeRun, bundle: null, bundlePath: bundle.path, job, directory: join(out, "contaminated-baseline"), transport: async () => { calls++; return toolUse("StructuredOutput", { body, notes: "" }); } });
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
console.log("Docker/Claude Code integration smoke passed (scripted provider; no quality claims).");

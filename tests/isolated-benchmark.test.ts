import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest, publicJob, checkCatalog, skillPath, checkContainer, checkRequest, comparableRequest, inventory, pairedRecords } from "../benchmarks/isolated/protocol.ts";
import { containerArgs, SSEUsage, decodeRequest, paceTransport } from "../benchmarks/isolated/docker.ts";
import { summarize } from "../benchmarks/isolated/report.ts";
import type { SkillCatalog } from "../benchmarks/isolated/native-evidence.ts";
import type { Arm } from "../benchmarks/isolated/benchmark-case.ts";
import type { Execution } from "../benchmarks/isolated/execution.ts";
import type { Settings } from "../benchmarks/isolated/manifest.ts";
import { options } from "../benchmarks/isolated/cli.ts";
import { sawLintCommand } from "../benchmarks/isolated/observations.ts";
import { BenchmarkCase } from "../benchmarks/isolated/benchmark-case.ts";
import { makePlan } from "../benchmarks/isolated/plan.ts";

test("public jobs retain exact prompt bytes and never carry private rubrics or condition names", () => {
  const c = { id: "one", prompt: "依頼\r\n資料\n", criteria: { facts: "PRIVATE-RUBRIC" }, expectedBody: "PRIVATE-ANSWER" };
  const settings = { model: "fixed-model", effort: "low" } as const satisfies Pick<Settings, "model" | "effort">;
  const first = { ...c, arm: "without_skill" };
  const second = { ...c, arm: "with_skill" };
  const a = publicJob(first, settings);
  const b = publicJob(second, settings);
  assert.equal(canonical(a), canonical(b));
  assert.equal(a.prompt, c.prompt);
  assert.ok(!canonical(a).includes("PRIVATE"));
  assert.ok(!canonical(a).includes("with_skill"));
  assert.notEqual(digest(a), digest(publicJob({ ...c, prompt: c.prompt.trim() }, settings)));
});

test("native catalog must prove baseline absence and the exact treatment installation", () => {
  const system = { name: "bundled", path: "/home/agent/.codex/skills/.system/bundled/SKILL.md", scope: "system", enabled: false };
  const skill = { name: "tanteki", path: `${skillPath}/SKILL.md`, scope: "user", enabled: true };
  const catalog = (skills: SkillCatalog["data"][number]["skills"], errors: unknown[] = []) => ({ data: [{ cwd: "/workspace", skills, errors }] });
  checkCatalog(catalog([system]), false);
  checkCatalog(catalog([system, skill]), true);
  assert.throws(() => checkCatalog(catalog([system, skill]), false), /enabled/);
  assert.throws(() => checkCatalog(catalog([system]), true), /enabled/);
  assert.throws(() => checkCatalog(catalog([{ ...system, scope: "admin" }]), false), /Unexpected skill/);
  assert.throws(() => checkCatalog(catalog([{ ...system, enabled: true }]), false), /enabled/);
  assert.throws(() => checkCatalog(catalog([], [{ message: "broken SKILL.md" }]), false), /discovery/);
  assert.throws(() => checkCatalog(catalog([{ ...skill, path: "/wrong/SKILL.md" }]), true), /Wrong treatment/);
});

function inspectedContainer() {
  return { Image: "sha256:runtime", Config: { Hostname: "benchmark", WorkingDir: "/workspace", Env: ["LANG=C.UTF-8"] }, Mounts: [{ Type: "bind", Source: "/temporary/input", Destination: "/input", RW: false }], HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, SecurityOpt: ["no-new-privileges"], CapDrop: ["ALL"], CapAdd: ["SETUID", "SETGID"], PidMode: "", IpcMode: "private", Memory: 2147483648, NanoCpus: 2000000000, PidsLimit: 256, Tmpfs: { "/home/agent": "", "/tmp": "", "/workspace": "" } } };
}

test("container audit rejects host homes, writable inputs, sockets, networking and shared namespaces", () => {
  const expected = [{ source: "/temporary/input", target: "/input" }];
  checkContainer(inspectedContainer(), "sha256:runtime", expected);
  for (const mutate of [
    (i: ReturnType<typeof inspectedContainer>) => { i.HostConfig.NetworkMode = "bridge"; },
    (i: ReturnType<typeof inspectedContainer>) => { i.Mounts[0].Source = "/Users/person/.codex"; },
    (i: ReturnType<typeof inspectedContainer>) => { i.Mounts[0].RW = true; },
    (i: ReturnType<typeof inspectedContainer>) => { i.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false }); },
    (i: ReturnType<typeof inspectedContainer>) => { i.HostConfig.PidMode = "host"; },
    (i: ReturnType<typeof inspectedContainer>) => { i.HostConfig.Privileged = true; },
    (i: ReturnType<typeof inspectedContainer>) => { i.HostConfig.CapAdd.push("SYS_ADMIN"); },
    (i: ReturnType<typeof inspectedContainer>) => { i.Image = "sha256:changed"; },
    (i: ReturnType<typeof inspectedContainer>) => { Object.assign(i.HostConfig.Tmpfs, { "/shared-cache": "" }); }
  ]) {
    const info = inspectedContainer(); mutate(info);
    assert.throws(() => checkContainer(info, "sha256:runtime", expected));
  }
  const args = containerArgs("sha256:runtime", expected, { name: "opaque-id" });
  assert.ok(!args.some((a) => a.includes("OPENAI_API_KEY")));
  assert.equal(args[args.indexOf("--network") + 1], "none");
});

test("model transport rejects substitutions, missing persistence controls, and conversation reuse", () => {
  const job = { model: "fixed", effort: "low" } as const;
  const body = { model: "fixed", store: false, reasoning: { effort: "low" }, input: [] };
  checkRequest(body, job);
  for (const patch of [{ model: "other" }, { store: true }, { store: undefined }, { previous_response_id: "other-run" }, { conversation: "other-run" }, { reasoning: { effort: "high" } }]) assert.throws(() => checkRequest({ ...body, ...patch }, job));
  const message = { data: Buffer.from(JSON.stringify(body)).toString("base64"), encoding: "identity" };
  assert.deepEqual(JSON.parse(decodeRequest(message).toString("utf8")), body);
  assert.throws(() => decodeRequest({ ...message, encoding: "unknown" }), /encoding/);
});

test("inventory detects modified bytes and rejects references outside the sealed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "isolated-inventory-"));
  try {
    await mkdir(join(directory, "input"));
    await writeFile(join(directory, "private.txt"), "PRIVATE");
    const path = join(directory, "input");
    await writeFile(join(path, "prompt.txt"), "one\n");
    const first = await inventory(path);
    await writeFile(join(path, "prompt.txt"), "two\n");
    assert.notEqual((await inventory(path)).digest, first.digest);
    await symlink("../private.txt", join(path, "escape"));
    await assert.rejects(inventory(path), /Symlink/);
    await assert.rejects(inventory(path, { allowLinks: true }), /Escaping/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function record(arm: Arm, status: Execution["status"] = "valid", repeat = 1): Execution {
  const common = { id: `one.${repeat}.${arm}`, caseId: "one", repeat, arm, promptHash: "same", jobHash: "same", environmentHash: "same", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }, modelCalls: 1, providerResponses: 1, elapsedMs: 10, observations: { skillTextSeen: false, lintCommandSeen: false } };
  return status === "valid" ? { ...common, status, response: { body: "本文", notes: "" }, responseHash: "frozen" } : { ...common, status, error: "failure" };
}

test("failed counterparts cannot enter paired quality scores; failures and non-activation stay visible", () => {
  const records = [record("without_skill"), record("with_skill"), record("without_skill", "execution_failed", 2), record("with_skill", "valid", 2)];
  const manifest = { protocol: "tanteki-isolated-v1" as const, plan: records.map(({ id, caseId, repeat, arm }) => ({ id, caseId, repeat, arm })) };
  assert.equal(pairedRecords(manifest, records).length, 1);
  const summary = summarize(manifest, records, null);
  assert.equal(summary.plannedPairs, 2);
  assert.equal(summary.validPairs, 1);
  assert.equal(summary.arms.without_skill.execution_failed, 1);
  assert.equal(summary.arms.with_skill.valid, 2);
  assert.equal(summary.arms.with_skill.skillTextSeen, 0);
  assert.equal(summary.arms.without_skill.inputTokens, 20);
  assert.throws(() => pairedRecords(manifest, records.slice(0, 3)), /Missing/);
  assert.throws(() => pairedRecords(manifest, records.map((r, i) => i === 1 ? { ...r, jobHash: "changed" } : r)), /inputs differ/);
});

test("provider token accounting handles split stream events and records missing completion", () => {
  const parser = new SSEUsage();
  const event = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5,"input_tokens_details":{"cached_tokens":3}}}}\n\n';
  parser.push(event.slice(0, 20)); parser.push(event.slice(20));
  assert.equal(parser.completed, 1);
  assert.deepEqual(parser.usage, { input_tokens: 12, output_tokens: 5, cached_input_tokens: 3 });
  const incomplete = new SSEUsage(); incomplete.push('data: {"type":"response.created"}\n\n');
  assert.equal(incomplete.completed, 0);
});

test("default CLI cannot accidentally invoke the legacy lint-feedback experiment", () => {
  assert.throws(() => options(["run", "--out", "/tmp/x", "--model", "m"]), /legacy/);
  assert.throws(() => options(["generate", "--lock", "x", "--out", "y"]), /model/);
  assert.throws(() => options(["generate", "--lock", "x", "--out", "y", "--model", "m", "--resume"]), /Unknown/);
  const parsed = options(["generate", "--lock", "x", "--model", "m", "--dry-run"]);
  assert.ok(parsed.action === "generate");
  assert.equal(parsed.dryRun, true);
});

test("initial comparison permits only native skill discovery and fresh session identifiers", () => {
  const job = publicJob({ prompt: "依頼" }, { model: "fixed", effort: "low" });
  const common = { model: "fixed", store: false, reasoning: { effort: "low" }, text: { format: "fixed" }, tools: [], input: [{ type: "message", id: "message-1", role: "user", content: [{ type: "input_text", text: "依頼" }] }] };
  const baseline = { ...common, input: [{ type: "message", id: "d1", role: "developer", content: [{ type: "input_text", text: "common instructions" }] }, ...common.input], prompt_cache_key: "session-1", client_metadata: { session_id: "session-1" } };
  const treatment = { ...common, input: [{ type: "message", id: "d2", role: "developer", content: [{ type: "input_text", text: "common instructions" }, { type: "input_text", text: "<skills_instructions>\n- tanteki: native catalog\n</skills_instructions>" }] }, ...common.input], prompt_cache_key: "session-2", client_metadata: { session_id: "session-2" } };
  const expected = comparableRequest(baseline, job, false);
  assert.deepEqual(comparableRequest(treatment, job, true), expected);
  assert.throws(() => comparableRequest(treatment, job, false), /Unexpected native skill/);
  assert.throws(() => comparableRequest(baseline, job, true), /catalog missing/);
  assert.notEqual(digest(comparableRequest({ ...baseline, text: { format: "changed" } }, job, false)), digest(expected));
  const changed = { ...baseline, input: [...baseline.input, { type: "message", role: "user", content: [{ type: "input_text", text: "different date or environment" }] }] };
  assert.notEqual(digest(comparableRequest(changed, job, false)), digest(expected));
});

test("code-mode tool definitions are compared in full while fresh item IDs may differ", () => {
  const job = publicJob({ prompt: "依頼" }, { model: "fixed", effort: "low" });
  const tools = [{ type: "function", name: "exec_command", description: "Run a command" }];
  const request = (id: string, definitions: unknown[] = tools) => ({ model: "fixed", store: false, reasoning: { effort: "low" }, input: [{ type: "additional_tools", id, role: "developer", tools: definitions }] });
  const expected = comparableRequest(request("first"), job, false);
  assert.deepEqual(comparableRequest(request("second"), job, false), expected);
  assert.notEqual(digest(comparableRequest(request("first", []), job, false)), digest(expected));
  assert.notEqual(digest(comparableRequest(request("first", [{ ...tools[0], description: "Different instruction" }]), job, false)), digest(expected));
  assert.throws(() => comparableRequest({ ...request("first"), input: [{ type: "function_call", name: "exec_command", arguments: "{}" }] }, job, false));
  assert.throws(() => comparableRequest({ ...request("first"), input: [{ type: "additional_tools", role: "user", tools }] }, job, false));
});

test("checking whether textlint exists is not counted as executing lint", () => {
  const event = (command: string, exitCode = 0) => ({ method: "item/completed", params: { item: { type: "commandExecution", exitCode, commandActions: [{ type: "unknown", command }] } } });
  for (const command of ["node -e \"require.resolve('textlint')\"", "cat /skill/scripts/lint.mjs", "rg textlint package.json", "echo textlint"]) assert.equal(sawLintCommand(event(command)), false);
  for (const command of ["node /skill/scripts/lint.mjs --type stock doc.md", "npx --no-install textlint doc.md", "./node_modules/.bin/textlint doc.md"]) assert.equal(sawLintCommand(event(command)), true);
  assert.equal(sawLintCommand(event("textlint doc.md", 127)), false);
  assert.equal(sawLintCommand(event("textlint doc.md", 1)), true);
});

test("seeded plans contain every pair and alternate the first condition for each case", async () => {
  const cases = BenchmarkCase.suiteSchema.parse(JSON.parse(await readFile(new URL("../benchmarks/cases.json", import.meta.url), "utf8")));
  const plan = makePlan(cases, 4, "fixed-seed");
  assert.deepEqual(plan, makePlan(cases, 4, "fixed-seed"));
  assert.notDeepEqual(plan, makePlan(cases, 4, "other-seed"));
  assert.equal(plan.length, cases.length * 4 * 2);
  assert.equal(new Set(plan.map((entry) => entry.id)).size, plan.length);
  for (const c of cases) {
    const first = [];
    for (let repeat = 1; repeat <= 4; repeat++) {
      const pair = plan.filter((entry) => entry.caseId === c.id && entry.repeat === repeat);
      assert.deepEqual(pair.map((entry) => entry.arm).sort(), ["with_skill", "without_skill"]);
      first.push(pair[0].arm);
    }
    assert.equal(first.filter((arm) => arm === "with_skill").length, 2);
  }
});


test("transport spaces concurrent requests and cancels queued calls without retries", async () => {
  const starts: number[] = [];
  const response = new Response("ok");
  const transport = paceTransport(async () => { starts.push(Date.now()); return response; }, 40);
  const active = new AbortController();
  const cancelled = new AbortController();
  const first = transport(Buffer.from("first"), active.signal);
  const skipped = transport(Buffer.from("cancelled"), cancelled.signal);
  const rejected = assert.rejects(skipped, /abort/i);
  cancelled.abort();
  const last = transport(Buffer.from("last"), active.signal);
  await Promise.all([first, last, rejected]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 35);
});

test("streamed provider failures retain their code without claiming token usage", () => {
  const parser = new SSEUsage();
  parser.push('data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"private diagnostic"}}}\n\n');
  assert.equal(parser.failureCode, "rate_limit_exceeded");
  assert.equal(parser.completed, 0);
  assert.equal(parser.usage.output_tokens, 0);
});

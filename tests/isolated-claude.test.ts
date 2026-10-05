import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AnthropicSSEUsage, anthropicTransport } from "../benchmarks/isolated/docker.ts";
import { claudeObserver } from "../benchmarks/isolated/observations.ts";
import { options } from "../benchmarks/isolated/options.ts";
import { readPublication } from "../benchmarks/isolated/publication.ts";
import { protocolOf, providerOf } from "../benchmarks/isolated/provider.ts";
import { ModelRelay } from "../benchmarks/isolated/model-relay.ts";
import { checkAnthropicRequest, claudeArguments, claudeCommandHash, comparableAnthropicRequest, expectedTools, validateClaudePreflight } from "../benchmarks/isolated/claude-config.ts";
import { WorkerMessage, type WorkerMessage as Message } from "../benchmarks/isolated/worker-message.ts";
import { publicJob, sha256 } from "../benchmarks/isolated/protocol.ts";

const job = publicJob({ prompt: "資料から書く" }, { model: "fixed", effort: "low" });

test("Anthropic usage counts one response per message_stop and the whole prompt as input", () => {
  const parser = new AnthropicSSEUsage();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 1 } } },
    { type: "ping" },
    { type: "message_delta", delta: {}, usage: { output_tokens: 7 } },
    { type: "message_stop" }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  parser.push(events.slice(0, 40)); parser.push(events.slice(40));
  assert.equal(parser.completed, 1);
  assert.deepEqual(parser.usage, { input_tokens: 45, cached_input_tokens: 30, output_tokens: 7 });
  const failed = new AnthropicSSEUsage(); failed.push('data: {"type":"error","error":{"type":"overloaded_error"}}\n\n');
  assert.equal(failed.failureCode, "overloaded_error");
  assert.equal(failed.completed, 0);
  assert.throws(() => new AnthropicSSEUsage().push('data: {"type":"message_stop"}\n'), /before message_start/);
});

test("Anthropic transport only reaches the Messages endpoint", async () => {
  // Each transport paces its first call immediately; the path check runs before any network access.
  for (const path of ["//example.com/v1/messages", "/v1/messages/count_tokens", "@example.com/v1/messages", undefined]) {
    await assert.rejects(anthropicTransport("test-key")(Buffer.from("{}"), AbortSignal.timeout(1000), { path }), /Unapproved Anthropic path/);
  }
  assert.throws(() => anthropicTransport(undefined), /ANTHROPIC_API_KEY/);
});

test("Claude arguments are identical across arms and keep the prompt out of argv", () => {
  const args = claudeArguments(job);
  assert.ok(!args.includes(job.prompt));
  assert.ok(args.includes("--strict-mcp-config") && !args.includes("--bare"));
  assert.equal(args[args.indexOf("--model") + 1], "fixed");
  assert.ok(!JSON.parse(args[args.indexOf("--json-schema") + 1]).$schema);
  assert.deepEqual(claudeArguments({ ...job, kind: "judge" }).slice(-2), ["--tools", ""]);
});

test("Claude relay answers probes locally, holds model requests until enabled and forwards no credentials", async () => {
  const input = new PassThrough();
  const emitted: Message[] = [];
  const relay = ModelRelay.create({ input, emit: (message) => emitted.push(message), provider: "claude" });
  await relay.listen();
  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: 19876, method, path, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); res.on("error", reject); });
    req.on("error", reject);
    req.end(body);
  });
  try {
    assert.equal(await send("HEAD", "/api/hello"), 200);
    assert.equal(await send("POST", "/v1/messages/count_tokens", {}, "{}"), 404);
    assert.deepEqual(emitted.filter((message) => message.type === "violation"), []);
    assert.equal(await send("GET", "/v1/models"), 403);
    assert.equal(emitted.filter((message) => message.type === "violation").length, 1);
    const pending = send("POST", "/v1/messages?beta=true", { "x-api-key": "secret", "anthropic-version": "2023-06-01", "anthropic-beta": "b", "x-claude-code-session-id": "s", "content-type": "application/json", authorization: "Bearer x" }, "{}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!emitted.some((message) => message.type === "request"), "request must wait for the init verification");
    relay.enable();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const forwarded = emitted.find((message) => message.type === "request");
    assert.ok(forwarded && forwarded.type === "request");
    assert.equal(forwarded.path, "/v1/messages?beta=true");
    assert.deepEqual(Object.keys(forwarded.headers ?? {}).sort(), ["anthropic-beta", "anthropic-version", "content-type", "x-claude-code-session-id"]);
    assert.ok(WorkerMessage.fromJSON(JSON.stringify(forwarded)).isOk());
    input.write(JSON.stringify({ type: "response", id: forwarded.id, status: 200, contentType: "text/event-stream" }) + "\n" + JSON.stringify({ type: "end", id: forwarded.id }) + "\n");
    assert.equal(await pending, 200);
  } finally { relay.close(); input.destroy(); }
});

// Fixtures mirror what Claude Code 2.1.285 actually sent in the integration smoke.
const claudeJob = { ...job, protocol: "tanteki-isolated-claude-v1" as const, model: "claude-sonnet-5-5" };
const judgeJob = { ...claudeJob, kind: "judge" as const };
const listing = "The following skills are available for use with the Skill tool:\n\n- tanteki: 日本語の文書を書く。";
const environmentText = (withSkill: boolean, os = "Linux 6.8.0", date = "2026-10-05") =>
  `# Environment\n - Primary working directory: /workspace\n - OS Version: ${os}\n\nYou are powered by the model named Sonnet 5.5.${withSkill ? `\n\n${listing}` : ""}\n\n<total_tokens>15000000 tokens left</total_tokens>\n\nToday's date is ${date}.`;
const requestFor = (j: typeof claudeJob | typeof judgeJob, withSkill: boolean, extra: Record<string, unknown> = {}, environment = environmentText(withSkill)) => ({
  model: j.model, stream: true, output_config: { effort: j.effort }, max_tokens: 128000,
  metadata: { user_id: `{"device_id":"${Math.random()}"}` },
  tools: expectedTools(j).map((name) => ({ name })),
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.285.170;" }, { type: "text", text: "You are a Claude agent." }, { type: "text", text: j.instructions }],
  messages: [{ role: "user", content: j.prompt }, { role: "system", content: [{ type: "text", text: environment }] }],
  ...extra
});
const initFor = (j: typeof claudeJob | typeof judgeJob, withSkill: boolean, extra: Record<string, unknown> = {}) => ({
  type: "system", subtype: "init", claude_code_version: "2.1.285", mcp_servers: [], model: j.model, permissionMode: "dontAsk", cwd: "/workspace", apiKeySource: "ANTHROPIC_API_KEY",
  tools: [...expectedTools(j)].reverse(), skills: withSkill ? ["tanteki", "doctor"] : ["doctor"], plugins: [{ name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" }], ...extra
});
const bundle = { digest: "bundle-digest", files: {} };
const evidenceFor = (j: typeof claudeJob | typeof judgeJob, withSkill: boolean, init: Record<string, unknown>) => ({
  protocol: "tanteki-isolated-claude-v1", promptHash: sha256(j.prompt), configTextHash: claudeCommandHash(j), privateHomeEmpty: true, workspaceEmpty: true, skillDigest: withSkill ? bundle.digest : null, init
});

test("Claude preflight accepts the measured init event and rejects every deviation", () => {
  for (const [j, withSkill] of [[claudeJob, true], [claudeJob, false], [judgeJob, false]] as const) {
    assert.ok(validateClaudePreflight(evidenceFor(j, withSkill, initFor(j, withSkill)), j, withSkill ? bundle : null, "2.1.285"));
  }
  const reject = (extra: Record<string, unknown>, pattern: RegExp, withSkill = true) =>
    assert.throws(() => validateClaudePreflight(evidenceFor(claudeJob, withSkill, initFor(claudeJob, withSkill, extra)), claudeJob, withSkill ? bundle : null, "2.1.285"), pattern);
  reject({ skills: ["tanteki", "doctor", "dataviz"] }, /Unexpected skills/);
  reject({ skills: ["doctor"] }, /Unexpected skills/);
  reject({ skills: ["tanteki", "doctor"] }, /Unexpected skills/, false);
  reject({ tools: ["Bash", "Edit", "Read", "StructuredOutput", "Write"] }, /Unexpected tools/);
  reject({ tools: [...expectedTools(claudeJob), "WebFetch"] }, /Unexpected tools/);
  reject({ mcp_servers: [{ name: "x" }] }, /MCP/);
  reject({ plugins: [{ name: "cc-plugin-agents-md", path: "/home/agent/.claude/plugins/x" }] }, /plugin/);
  reject({ plugins: [{ name: "other", path: "builtin" }] }, /plugin/);
  reject({ apiKeySource: "none" }, /API key source/);
  reject({ claude_code_version: "2.1.286" }, /version/);
  reject({ model: "other" }, /model/);
  reject({ permissionMode: "default" }, /permission/);
  reject({ cwd: "/tmp" }, /working directory/);
  assert.throws(() => validateClaudePreflight(evidenceFor(judgeJob, false, initFor(judgeJob, false, { tools: ["Bash", "StructuredOutput"] })), judgeJob, null, "2.1.285"), /Unexpected tools/);
  assert.throws(() => validateClaudePreflight({ ...evidenceFor(claudeJob, true, initFor(claudeJob, true)), skillDigest: null }, claudeJob, bundle, "2.1.285"), /Skill bundle/);
  assert.throws(() => validateClaudePreflight({ ...evidenceFor(claudeJob, true, initFor(claudeJob, true)), configTextHash: "x" }, claudeJob, bundle, "2.1.285"), /command line/);
});

test("Claude request check pins model, streaming, effort, tools, instructions, prompt and reminders", () => {
  const ok = (raw: unknown, first = true, j = claudeJob) => checkAnthropicRequest(raw, j, { first });
  assert.ok(ok(requestFor(claudeJob, true)));
  assert.ok(ok(requestFor(judgeJob, false), true, judgeJob));
  assert.throws(() => ok(requestFor(claudeJob, true, { model: "other" })), /Model substitution/);
  assert.throws(() => ok(requestFor(claudeJob, true, { stream: false })), /stream/);
  assert.throws(() => ok(requestFor(claudeJob, true, { output_config: { effort: "high" } })), /effort/);
  assert.throws(() => ok(requestFor(claudeJob, true, { tools: [{ name: "Bash" }] })), /tool set/);
  assert.throws(() => ok(requestFor(claudeJob, true, { mcp_servers: [] })), /MCP/);
  assert.throws(() => ok(requestFor(claudeJob, true, { system: [{ type: "text", text: "other instructions" }] })), /System instructions/);
  assert.throws(() => ok(requestFor(claudeJob, true, { messages: [{ role: "user", content: "別の依頼" }] })), /Prompt missing/);
  assert.throws(() => ok(requestFor(claudeJob, true, { messages: [{ role: "user", content: [{ type: "text", text: claudeJob.prompt }, { type: "text", text: "追記" }] }] })), /Prompt missing/);
  // Only the opening request is held to the exact prompt; later turns append tool traffic.
  assert.ok(ok(requestFor(claudeJob, true, { messages: [{ role: "user", content: [{ type: "text", text: "<total_tokens>1</total_tokens>" }] }] }), false));
  const reminder = [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nAttribution</system-reminder>" }, { type: "text", text: claudeJob.prompt }] }];
  assert.throws(() => ok(requestFor(claudeJob, true, { messages: reminder })), /system-reminder/);
  assert.throws(() => ok(requestFor(claudeJob, true, { system: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: claudeJob.instructions }] })), /system-reminder/);
});

test("comparable Claude requests differ only by session ids, date, OS and the tanteki catalog line", () => {
  const withSkill = requestFor(claudeJob, true, {}, environmentText(true, "Linux 6.8.0", "2026-10-05"));
  const withoutSkill = requestFor(claudeJob, false, {}, environmentText(false, "Linux 7.0.1", "2026-11-01"));
  assert.deepEqual(comparableAnthropicRequest(withSkill, claudeJob, true), comparableAnthropicRequest(withoutSkill, claudeJob, false));
  assert.throws(() => comparableAnthropicRequest(withSkill, claudeJob, false), /Unexpected native skill catalog/);
  assert.throws(() => comparableAnthropicRequest(withoutSkill, claudeJob, true), /catalog missing/);
  const extraSkill = requestFor(claudeJob, true, {}, environmentText(true).replace("- tanteki: 日本語の文書を書く。", "- tanteki: 日本語の文書を書く。\n- dataviz: charts"));
  assert.throws(() => comparableAnthropicRequest(extraSkill, claudeJob, true), /catalog missing or unexpected/);
  const changed = requestFor(claudeJob, false, { max_tokens: 1 }, environmentText(false));
  assert.notDeepEqual(comparableAnthropicRequest(changed, claudeJob, false), comparableAnthropicRequest(withoutSkill, claudeJob, false));
  const instructionsChanged = requestFor(claudeJob, false, { system: [{ type: "text", text: "other" }] });
  assert.throws(() => comparableAnthropicRequest(instructionsChanged, claudeJob, false), /System instructions/);
});

test("Claude observations need a completed lint run and are not fooled by mentions or failures", () => {
  const use = (id: string, command: string, name = "Bash") => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command } }] } });
  const result = (id: string, extra: Record<string, unknown>) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] } });
  const lint = "node /home/agent/.claude/skills/tanteki/scripts/lint.mjs --type stock /workspace/document.md";
  const seen = (events: Array<{ type: string }>) => { const observer = claudeObserver(); return events.map((event) => observer.lintCommandSeen(event)).some(Boolean); };
  assert.equal(seen([use("a", lint), result("a", { content: "ok", is_error: false })]), true);
  assert.equal(seen([use("a", lint), result("a", { content: "Exit code 1\n3 problems", is_error: true })]), true);
  assert.equal(seen([use("a", lint), result("a", { content: "Exit code 2\nboom", is_error: true })]), false);
  assert.equal(seen([use("a", lint)]), false);
  assert.equal(seen([use("a", `cat ${lint}`), result("a", { content: "x", is_error: false })]), false);
  assert.equal(seen([use("a", lint, "Read"), result("a", { content: "x", is_error: false })]), false);
  assert.equal(seen([use("a", lint), result("b", { content: "x", is_error: false })]), false);
});

test("CLI options choose the provider's effort range and keep Codex defaults", () => {
  assert.equal(options(["generate", "--lock", "x", "--model", "m", "--dry-run"]).action, "generate");
  const claude = options(["generate", "--lock", "x", "--model", "claude-sonnet-5-5", "--provider", "claude", "--effort", "max", "--dry-run"]);
  assert.ok(claude.action === "generate" && claude.provider === "claude" && claude.effort === "max");
  assert.throws(() => options(["generate", "--lock", "x", "--model", "m", "--provider", "claude", "--effort", "minimal", "--dry-run"]), /not valid for claude/);
  assert.throws(() => options(["grade", "--run", "x", "--out", "y", "--model", "m", "--provider", "codex", "--effort", "max"]), /not valid for codex/);
  assert.throws(() => options(["generate", "--lock", "x", "--provider", "claude", "--dry-run"]), /model/);
  assert.throws(() => options(["generate", "--lock", "x", "--model", "m", "--provider", "other", "--dry-run"]));
  const build = options(["build", "--out", "x", "--provider", "claude"]);
  assert.ok(build.action === "build" && build.provider === "claude" && build.claudeVersion === "2.1.285");
  const codex = options(["build", "--out", "x"]);
  assert.ok(codex.action === "build" && codex.provider === "codex" && codex.codexVersion === "0.155.1");
});

test("archived Codex publications still verify and protocol identifiers map to providers", async () => {
  const results = new URL("../benchmarks/results/", import.meta.url);
  const archives = (await readdir(results)).filter((name) => existsSync(new URL(`${name}/evidence-inventory.json`, results)));
  assert.ok(archives.length >= 4);
  for (const name of archives) {
    const verified = await readPublication(fileURLToPath(new URL(name, results)));
    assert.equal(providerOf(verified.manifest.protocol), "codex", name);
  }
  assert.equal(providerOf(protocolOf("claude")), "claude");
  assert.equal(protocolOf("codex"), "tanteki-isolated-v1");
});

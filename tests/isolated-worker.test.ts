import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ok, err } from "neverthrow";
import { TurnState } from "../benchmarks/isolated/turn-state.ts";
import { TurnEvent } from "../benchmarks/isolated/turn-event.ts";
import { runWorker } from "../benchmarks/isolated/worker.ts";
import { connectCodex } from "../benchmarks/isolated/codex-client.ts";
import { parseRelayReply } from "../benchmarks/isolated/model-relay.ts";
import { publicJob, protocol } from "../benchmarks/isolated/protocol.ts";
import type { EnvironmentEvidence } from "../benchmarks/isolated/native-evidence.ts";

const job = publicJob({ prompt: "資料から書く" }, { model: "fixed", effort: "low" });
const evidence: EnvironmentEvidence = { protocol, promptHash: "hash", configTextHash: "hash", privateHomeEmpty: true, workspaceEmpty: true, skillDigest: null };

test("turn requires its own final JSON response and completion; failures stay terminal", () => {
  const start = TurnState.start("own");
  assert.deepEqual(TurnState.receive(start, { kind: "FinalMessage", threadId: "other", text: "{}" }), start);
  const incomplete = TurnState.receive(start, { kind: "TurnFinished", threadId: "own", status: "completed" });
  assert.equal(incomplete.kind, "ExecutionFailed");
  const received = TurnState.receive(start, { kind: "FinalMessage", threadId: "own", text: '{"body":"  本文\\n","notes":""}' });
  assert.equal(received.kind, "ResponseReceived");
  const done = TurnState.receive(received, { kind: "TurnFinished", threadId: "own", status: "completed" });
  assert.equal(done.kind, "Completed");
  if (done.kind === "Completed") assert.equal(done.response.body, "  本文\n");
  const failed = TurnState.receive(received, { kind: "TurnFinished", threadId: "own", status: "failed" });
  assert.equal(failed.kind, "ExecutionFailed");
  assert.deepEqual(TurnState.receive(failed, { kind: "TurnFinished", threadId: "own", status: "completed" }), failed);
  const malformed = TurnState.receive(start, { kind: "FinalMessage", threadId: "own", text: "not json" });
  assert.equal(TurnState.receive(malformed, { kind: "TurnFinished", threadId: "own", status: "completed" }).kind, "ExecutionFailed");
  assert.deepEqual(TurnEvent.fromNotification({ method: "item/completed", params: { threadId: "own", item: { type: "agentMessage", phase: "commentary", text: "{}" } } })._unsafeUnwrap(), { kind: "Ignored" });
  assert.ok(TurnEvent.fromNotification({ method: "turn/completed", params: {} }).isErr());
});

test("failed preflight never enables model traffic and closes both adapters", async () => {
  const calls: string[] = [];
  const result = await runWorker(job, {
    environment: { prepare: async () => ok(evidence), startCodex: () => { throw new Error("not used"); }, stopCodex: () => {} },
    relay: { listen: async () => { calls.push("listen"); }, enable: () => { calls.push("enable"); }, close: () => { calls.push("relay.close"); } },
    session: { prepare: async () => err({ kind: "InvalidEnvironment", message: "Unexpected skill" }), execute: async () => { calls.push("execute"); return ok({}); }, close: () => { calls.push("session.close"); } },
    emit: () => { calls.push("emit"); }
  });
  assert.ok(result.isErr());
  assert.deepEqual(calls, ["listen", "session.close", "relay.close"]);
});

test("Codex transport failure rejects pending RPCs and subscribers promptly", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.once('data',()=>{process.stdout.write('not json\\n')});setTimeout(()=>{},10000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const failures: Error[] = [];
  const client = connectCodex(child, { emit: () => {}, stop: (process) => { process.kill(); } });
  client.subscribe(() => {}, (error) => failures.push(error));
  try {
    await assert.rejects(client.call("initialize", {}));
    await assert.rejects(client.call("thread/start", {}));
    assert.equal(failures.length, 1);
  } finally { client.close(); }
});

test("relay validates frame types, HTTP headers and identifiers at the boundary", () => {
  assert.ok(parseRelayReply('{"type":"response","id":1,"status":200,"contentType":"text/event-stream"}').isOk());
  for (const frame of [null, { type: "chunk", id: 1, data: "not base64!" }, { type: "end", id: -1 }, { type: "response", id: 1, status: 200, contentType: "text/event-stream\r\nInjected: true" }]) assert.ok(parseRelayReply(JSON.stringify(frame)).isErr());
});

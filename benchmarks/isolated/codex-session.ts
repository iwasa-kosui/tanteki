import { ok, err, type Result } from "neverthrow";
import { checkCatalog, invariant, skillPath } from "./protocol.ts";
import { connectCodex, type CodexClient } from "./codex-client.ts";
import { TurnState, type ExecutionError } from "./turn-state.ts";
import { TurnEvent } from "./turn-event.ts";
import { NativeEvidence, type EnvironmentEvidence } from "./native-evidence.ts";
import { decode, messageOf } from "./validation.ts";
import type { WorkerEnvironment, EnvironmentError } from "./worker-environment.ts";
import type { Job } from "./job.ts";
import type { WorkerEmit } from "./worker-message.ts";

type ReadySession = Readonly<{ threadId: string; evidence: NativeEvidence }>;
export type CodexSession = Readonly<{
  prepare: (job: Job, evidence: EnvironmentEvidence) => Promise<Result<ReadySession, EnvironmentError>>;
  execute: (job: Job, threadId: string) => Promise<Result<Record<string, unknown>, ExecutionError>>;
  close: () => void;
}>;

async function inspectSkills(client: CodexClient, withSkill: boolean) {
  const request = { cwds: ["/workspace"], forceReload: true };
  const discovered = decode(NativeEvidence.catalogSchema, await client.call("skills/list", request));
  invariant(discovered.data.length === 1 && discovered.data[0].errors.length === 0, "Native skill discovery failed");
  const others = discovered.data[0].skills.filter((skill) => !(withSkill && skill.path === `${skillPath}/SKILL.md`));
  invariant(others.every((skill) => skill.scope === "system"), "Unexpected preinstalled skill");
  // Writes are ordered because they update the same config file.
  for (const skill of others) await client.call("skills/config/write", { path: skill.path, enabled: false });
  const catalog = decode(NativeEvidence.catalogSchema, await client.call("skills/list", request));
  checkCatalog(catalog, withSkill);
  return catalog;
}

async function prepareSession(client: CodexClient, job: Job, evidence: EnvironmentEvidence): Promise<Result<ReadySession, EnvironmentError>> {
  try {
    const initialized = await client.call("initialize", { clientInfo: { name: "tanteki_benchmark", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized");
    const catalog = await inspectSkills(client, evidence.skillDigest !== null);
    const config = decode(NativeEvidence.configSchema, await client.call("config/read", { cwd: "/workspace", includeLayers: true }));
    const thread = decode(NativeEvidence.threadSchema, await client.call("thread/start", {
      model: job.model, modelProvider: "benchmark", cwd: "/workspace", approvalPolicy: "never", sandbox: "danger-full-access",
      ephemeral: true, developerInstructions: job.instructions, personality: "none", allowProviderModelFallback: false
    }));
    invariant(thread.model === job.model && thread.modelProvider === "benchmark" && thread.instructionSources.length === 0, "Unexpected thread configuration");
    return ok({ threadId: thread.thread.id, evidence: { ...evidence, initialized, catalog, config, thread } });
  } catch (error) { return err({ kind: "InvalidEnvironment", message: messageOf(error) }); }
}

async function executeTurn(client: CodexClient, job: Job, threadId: string, emit: WorkerEmit): Promise<Result<Record<string, unknown>, ExecutionError>> {
  let state: TurnState = TurnState.start(threadId);
  const completed = Promise.withResolvers<Result<Record<string, unknown>, ExecutionError>>();
  const unsubscribe = client.subscribe(
    (notification) => {
      const event = TurnEvent.fromNotification(notification);
      if (event.isErr()) { completed.resolve(err(TurnState.fail(event.error.message))); return; }
      state = TurnState.receive(state, event.value);
      if (state.kind === "Completed") completed.resolve(ok(state.response));
      if (state.kind === "ExecutionFailed") completed.resolve(err(state));
    },
    (error) => completed.resolve(err(TurnState.fail(error.message)))
  );
  try {
    const input: Array<{ type: "text"; text: string; text_elements: unknown[] }> = [{ type: "text", text: job.prompt, text_elements: [] }];
    emit({ type: "turnInput", input: [...input] });
    await client.call("turn/start", { threadId, input, model: job.model, effort: job.effort, outputSchema: job.schema });
    return await completed.promise;
  } catch (error) { return err(TurnState.fail(messageOf(error))); }
  finally { unsubscribe(); }
}

export const CodexSession = {
  create: ({ environment, emit }: { environment: WorkerEnvironment; emit: WorkerEmit }): CodexSession => {
    let connection: Readonly<{ kind: "NotStarted" } | { kind: "Connected"; client: CodexClient } | { kind: "Closed" }> = { kind: "NotStarted" };
    return {
      prepare: (job, evidence) => {
        const client = connectCodex(environment.startCodex(), { emit, stop: environment.stopCodex });
        connection = { kind: "Connected", client };
        return prepareSession(client, job, evidence);
      },
      execute: (job, threadId) => connection.kind === "Connected" ? executeTurn(connection.client, job, threadId, emit) : Promise.resolve(err(TurnState.fail("Session has not started"))),
      close: () => {
        if (connection.kind === "Connected") connection.client.close();
        connection = { kind: "Closed" };
      }
    };
  }
} as const;

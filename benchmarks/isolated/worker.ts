import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { err, type Result } from "neverthrow";
import { WorkerEnvironment, type EnvironmentError } from "./worker-environment.ts";
import { ModelRelay } from "./model-relay.ts";
import { CodexSession } from "./codex-session.ts";
import { Job } from "./job.ts";
import { messageOf } from "./validation.ts";
import type { ExecutionError } from "./turn-state.ts";
import type { WorkerEmit } from "./worker-message.ts";

type Dependencies = Readonly<{ environment: WorkerEnvironment; relay: ModelRelay; session: CodexSession; emit: WorkerEmit }>;
type WorkerResult = Result<Record<string, unknown>, EnvironmentError | ExecutionError>;

// Only orchestration lives here. Adapters own I/O; TurnState owns pure transitions.
export async function runWorker(job: Job, { environment, relay, session, emit }: Dependencies): Promise<WorkerResult> {
  const prepared = await environment.prepare(job);
  if (prepared.isErr()) return err(prepared.error);
  try {
    await relay.listen();
    const ready = await session.prepare(job, prepared.value);
    if (ready.isErr()) return err(ready.error);
    emit({ type: "preflight", value: ready.value.evidence });
    relay.enable();
    return await session.execute(job, ready.value.threadId);
  } finally {
    try { session.close(); } finally { relay.close(); }
  }
}

async function main(): Promise<void> {
  const emit: WorkerEmit = (message) => { process.stdout.write(JSON.stringify(message) + "\n"); };
  const environment = WorkerEnvironment.create();
  const relay = ModelRelay.create({ input: process.stdin, emit });
  const session = CodexSession.create({ environment, emit });
  let outcome: WorkerResult;
  try {
    const job = Job.fromJSON(await readFile("/input/job.json", "utf8"));
    outcome = job.isErr() ? err({ kind: "InvalidEnvironment", message: job.error.message }) : await runWorker(job.value, { environment, relay, session, emit });
  } catch (error) {
    outcome = err({ kind: "InvalidEnvironment", message: messageOf(error) });
  } finally { process.stdin.destroy(); }
  outcome.match(
    (response) => emit({ type: "result", response }),
    (error) => {
      emit({ type: "fatal", status: error.kind === "InvalidEnvironment" ? "invalid_environment" : "execution_failed", message: error.message });
      process.exitCode = 1;
    }
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

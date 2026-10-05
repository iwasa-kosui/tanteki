import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { err, type Result } from "neverthrow";
import { ClaudeEnvironment } from "./claude-environment.ts";
import { ClaudeSession } from "./claude-session.ts";
import { ModelRelay } from "./model-relay.ts";
import { Job } from "./job.ts";
import { messageOf } from "./validation.ts";
import type { EnvironmentError } from "./worker-environment.ts";
import type { ExecutionError } from "./turn-state.ts";
import type { WorkerEmit } from "./worker-message.ts";

type Dependencies = Readonly<{ environment: ClaudeEnvironment; relay: ModelRelay; session: ClaudeSession; emit: WorkerEmit }>;
type WorkerResult = Result<Record<string, unknown>, EnvironmentError | ExecutionError>;

// Claude Code reports its own init event; that event is the preflight evidence.
// Model traffic stays held in the relay until it has been emitted.
export async function runClaudeWorker(job: Job, { environment, relay, session, emit }: Dependencies): Promise<WorkerResult> {
  const prepared = await environment.prepare(job);
  if (prepared.isErr()) return err(prepared.error);
  try {
    await relay.listen();
    return await session.run(job, {
      onInit: (init) => {
        emit({ type: "claudePreflight", value: { ...prepared.value, init } });
        // The prompt was already written to stdin at launch; this records what was submitted.
        emit({ type: "turnInput", input: [{ type: "text", text: job.prompt, text_elements: [] }] });
        relay.enable();
      }
    });
  } finally {
    try { session.close(); } finally { relay.close(); }
  }
}

async function main(): Promise<void> {
  const emit: WorkerEmit = (message) => { process.stdout.write(JSON.stringify(message) + "\n"); };
  const environment = ClaudeEnvironment.create();
  const relay = ModelRelay.create({ input: process.stdin, emit, provider: "claude" });
  const session = ClaudeSession.create({ environment, emit });
  let outcome: WorkerResult;
  try {
    const job = Job.fromJSON(await readFile("/input/job.json", "utf8"));
    outcome = job.isErr() ? err({ kind: "InvalidEnvironment", message: job.error.message }) : await runClaudeWorker(job.value, { environment, relay, session, emit });
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

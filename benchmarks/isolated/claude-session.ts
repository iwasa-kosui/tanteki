import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ok, err, type Result } from "neverthrow";
import { z } from "zod";
import { claudeEventSchema } from "./claude-config.ts";
import { parseJSON, schemaResult, messageOf } from "./validation.ts";
import type { ClaudeEnvironment } from "./claude-environment.ts";
import type { ExecutionError } from "./turn-state.ts";
import type { Job } from "./job.ts";
import type { WorkerEmit } from "./worker-message.ts";

export type ClaudeInit = Readonly<Record<string, unknown> & { type: "system"; subtype: "init" }>;
export type ClaudeSession = Readonly<{
  run: (job: Job, hooks: { onInit: (init: ClaudeInit) => void }) => Promise<Result<Record<string, unknown>, ExecutionError>>;
  close: () => void;
}>;

const fail = (message: string): ExecutionError => ({ kind: "ExecutionFailed", message });
const initEvent = z.looseObject({ type: z.literal("system"), subtype: z.literal("init") });
const resultEvent = z.looseObject({ type: z.literal("result"), is_error: z.boolean().optional(), subtype: z.string().optional(), structured_output: z.unknown().optional() });

export const ClaudeSession = {
  create: ({ environment, emit }: { environment: ClaudeEnvironment; emit: WorkerEmit }): ClaudeSession => {
    let child: ChildProcessWithoutNullStreams | undefined;
    return {
      run: (job, { onInit }) => {
        const completed = Promise.withResolvers<Result<Record<string, unknown>, ExecutionError>>();
        let initialized = false;
        try {
          child = environment.startClaude(job);
        } catch (error) { return Promise.resolve(err(fail(messageOf(error)))); }
        const process = child;
        process.stdin.on("error", () => {});
        process.stderr.on("data", (chunk: Buffer) => emit({ type: "stderr", text: chunk.toString() }));
        process.on("error", (error) => completed.resolve(err(fail(error.message))));
        process.on("close", (code) => completed.resolve(err(fail(`Claude Code exited (${code}) without a result`))));
        createInterface({ input: process.stdout, crlfDelay: Infinity }).on("line", (line) => {
          try {
            const event = parseJSON(line).andThen(schemaResult(claudeEventSchema));
            if (event.isErr()) { completed.resolve(err(fail(`Malformed Claude Code output: ${event.error.message}`))); return; }
            const init = initEvent.safeParse(event.value);
            if (init.success && !initialized) { initialized = true; onInit(init.data as ClaudeInit); }
            emit({ type: "claudeEvent", event: event.value });
            const result = resultEvent.safeParse(event.value);
            if (!result.success) return;
            const output = z.record(z.string(), z.unknown()).safeParse(result.data.structured_output);
            if (!initialized) completed.resolve(err(fail("Claude Code returned a result before init")));
            else if (result.data.is_error !== false) completed.resolve(err(fail(`Claude Code failed: ${result.data.subtype ?? "unknown"}`)));
            else if (!output.success) completed.resolve(err(fail("Claude Code returned no structured output")));
            else completed.resolve(ok(output.data));
          } catch (error) { completed.resolve(err(fail(messageOf(error)))); }
        });
        // The prompt is data on stdin, never an argument.
        process.stdin.end(job.prompt);
        return completed.promise;
      },
      close: () => { if (child) environment.stopClaude(child); child = undefined; }
    };
  }
} as const;

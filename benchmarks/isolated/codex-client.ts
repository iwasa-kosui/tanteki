import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { parseJSON, decode, messageOf } from "./validation.ts";
import { notificationSchema, type CodexNotification, type WorkerEmit } from "./worker-message.ts";

type PendingRPC = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
export type CodexClient = Readonly<{
  call: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string) => void;
  subscribe: (onEvent: (event: CodexNotification) => void, onFailure: (error: Error) => void) => () => void;
  close: () => void;
}>;
const responseSchema = z.looseObject({ id: z.number().int(), result: z.unknown().optional(), error: z.unknown().optional() });

// Mutable maps are transport bookkeeping. The turn's domain state is immutable.
export function connectCodex(child: ChildProcessWithoutNullStreams, { emit, stop }: { emit: WorkerEmit; stop: (child: ChildProcessWithoutNullStreams) => void }): CodexClient {
  const pending = new Map<number, PendingRPC>();
  const listeners = new Set<(event: CodexNotification) => void>();
  const failures = new Set<(error: Error) => void>();
  let connection: Readonly<{ kind: "Open" } | { kind: "Closed"; error: Error }> = { kind: "Open" };
  let nextId = 0;

  function fail(error: Error): void {
    if (connection.kind === "Closed") return;
    connection = { kind: "Closed", error };
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    for (const listener of failures) listener(error);
  }
  const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + "\n"); };

  function receive(line: string): void {
    try {
      const parsed = parseJSON(line);
      if (parsed.isErr()) throw new Error(parsed.error.message);
      const raw = decode(z.record(z.string(), z.unknown()), parsed.value);
      if (Object.hasOwn(raw, "id") && !Object.hasOwn(raw, "method")) {
        const event = decode(responseSchema, raw);
        const request = pending.get(event.id);
        if (!request) throw new Error("Unexpected RPC response");
        if (!event.error && !Object.hasOwn(raw, "result")) throw new Error("RPC response has no result");
        pending.delete(event.id);
        clearTimeout(request.timer);
        if (event.error) request.reject(new Error(JSON.stringify(event.error))); else request.resolve(event.result);
        return;
      }
      const event = decode(notificationSchema, raw);
      emit({ type: "event", event });
      if (event.id !== undefined) send({ id: event.id, error: { code: -32601, message: "Interactive requests are unavailable" } });
      else for (const listener of listeners) listener(event);
    } catch (error) { fail(new Error(messageOf(error))); }
  }

  const lines = createInterface({ input: child.stdout });
  lines.on("line", receive);
  child.stderr.on("data", (data: Buffer) => emit({ type: "stderr", text: data.toString() }));
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Codex exited before completion (${code})`)));
  return {
    call: (method, params) => {
      if (connection.kind === "Closed") return Promise.reject(connection.error);
      const id = ++nextId;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`Codex RPC timed out: ${method}`)), 30000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify: (method) => send({ method }),
    subscribe: (onEvent, onFailure) => {
      listeners.add(onEvent); failures.add(onFailure);
      if (connection.kind === "Closed") onFailure(connection.error);
      return () => { listeners.delete(onEvent); failures.delete(onFailure); };
    },
    close: () => { fail(new Error("Codex connection closed")); lines.close(); stop(child); }
  };
}

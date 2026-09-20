import { z } from "zod";
import { parseJSON, schemaResult, assertNever } from "./validation.ts";
import type { TurnEvent } from "./turn-event.ts";

export type ExecutionError = Readonly<{ kind: "ExecutionFailed"; message: string }>;
export type CompletedTurn = Readonly<{ kind: "Completed"; response: Record<string, unknown> }>;
export type ActiveTurn = Readonly<
  | { kind: "AwaitingResponse"; threadId: string }
  | { kind: "ResponseReceived"; threadId: string; text: string }
>;
export type TurnState = ActiveTurn | CompletedTurn | ExecutionError;
const fail = (message: string): ExecutionError => ({ kind: "ExecutionFailed", message });
const terminal = (state: TurnState): state is CompletedTurn | ExecutionError => state.kind === "Completed" || state.kind === "ExecutionFailed";

function finish(state: ActiveTurn, status: string): CompletedTurn | ExecutionError {
  if (status !== "completed") return fail(`Turn ${status}`);
  if (state.kind === "AwaitingResponse") return fail("No final response");
  return parseJSON(state.text).andThen(schemaResult(z.record(z.string(), z.unknown()))).match(
    (response) => ({ kind: "Completed", response }),
    () => fail("Final response must be a JSON object")
  );
}

function receive(state: TurnState, event: TurnEvent): TurnState {
  if (terminal(state) || event.kind === "Ignored" || event.threadId !== state.threadId) return state;
  switch (event.kind) {
    case "FinalMessage": return { kind: "ResponseReceived", threadId: state.threadId, text: event.text };
    case "TurnFinished": return finish(state, event.status);
    default: return assertNever(event);
  }
}

export const TurnState = { start: (threadId: string): ActiveTurn => ({ kind: "AwaitingResponse", threadId }), receive, fail, isTerminal: terminal } as const;

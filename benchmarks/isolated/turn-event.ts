import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { schemaResult, type ValidationError } from "./validation.ts";
import type { CodexNotification } from "./worker-message.ts";

export type TurnEvent = Readonly<
  | { kind: "FinalMessage"; threadId: string; text: string }
  | { kind: "TurnFinished"; threadId: string; status: string }
  | { kind: "Ignored" }
>;
const message = z.object({ threadId: z.string(), item: z.object({ type: z.literal("agentMessage"), text: z.string(), phase: z.string().nullable().optional() }) });
const finished = z.object({ threadId: z.string(), turn: z.object({ status: z.string() }) });

function fromNotification(event: CodexNotification): Result<TurnEvent, ValidationError> {
  if (event.method === "turn/completed") return schemaResult(finished)(event.params).map(({ threadId, turn }): TurnEvent => ({ kind: "TurnFinished", threadId, status: turn.status }));
  if (event.method === "item/completed") {
    const item = z.object({ item: z.object({ type: z.string() }) }).safeParse(event.params);
    if (!item.success || item.data.item.type !== "agentMessage") return ok({ kind: "Ignored" });
    return schemaResult(message)(event.params).map(({ threadId, item }): TurnEvent => item.phase === "commentary" ? { kind: "Ignored" } : { kind: "FinalMessage", threadId, text: item.text });
  }
  return ok({ kind: "Ignored" });
}
export const TurnEvent = { fromNotification } as const;

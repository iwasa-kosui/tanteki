import { z } from "zod";
import { NativeEvidence } from "./native-evidence.ts";
import { schemaResult, parseJSON } from "./validation.ts";

export const notificationSchema = z.looseObject({ method: z.string(), params: z.record(z.string(), z.unknown()), id: z.union([z.string(), z.number()]).optional() });
export type CodexNotification = z.infer<typeof notificationSchema>;
const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preflight"), value: NativeEvidence.schema }),
  z.object({ type: z.literal("turnInput"), input: z.array(z.object({ type: z.literal("text"), text: z.string(), text_elements: z.array(z.unknown()) })) }),
  z.object({ type: z.literal("request"), id: z.number().int().positive(), encoding: z.string(), data: z.string() }),
  z.object({ type: z.literal("result"), response: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("event"), event: notificationSchema }),
  z.object({ type: z.literal("stderr"), text: z.string() }),
  z.object({ type: z.literal("violation"), message: z.string() }),
  z.object({ type: z.literal("fatal"), status: z.enum(["invalid_environment", "execution_failed"]), message: z.string() })
]);
export type WorkerMessage = z.infer<typeof schema>;
export type WorkerEmit = (message: WorkerMessage) => void;
export const WorkerMessage = { schema, fromJSON: (text: string) => parseJSON(text).andThen(schemaResult(schema)) } as const;

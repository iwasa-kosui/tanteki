import { z } from "zod";
import { plannedExecutionSchema } from "./execution.ts";

export const settingsSchema = z.object({ model: z.string(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]), repeats: z.number().int().positive(), seed: z.string(), timeout: z.number().positive(), maxCalls: z.number().int().positive() });
export type Settings = z.infer<typeof settingsSchema>;
const schema = z.object({ protocol: z.literal("tanteki-isolated-v1"), createdAt: z.string(), runtimeLockHash: z.string(), casesHash: z.string(), settings: settingsSchema, plan: z.array(plannedExecutionSchema), sealed: z.literal(true), evidence: z.object({ records: z.string(), calls: z.string() }), completedAt: z.string(), fingerprint: z.string() });
export type Manifest = z.infer<typeof schema>;
export const Manifest = { schema } as const;

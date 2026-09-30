import { z } from "zod";
import { armSchema } from "./benchmark-case.ts";

const verdictSchema = z.strictObject({ pass: z.boolean(), evidence: z.string().min(1) });
const candidateSchema = z.strictObject({ facts: verdictSchema, grounding: verdictSchema, role: verdictSchema, clarity: verdictSchema, economy: verdictSchema });
const judgmentSchema = z.strictObject({ A: candidateSchema, B: candidateSchema });
export type Judgment = z.infer<typeof judgmentSchema>;
const lintSchema = z.object({ bodyHash: z.string(), lint: z.array(z.object({ ruleId: z.string(), line: z.number(), column: z.number(), message: z.string() })) });
export type LintMeasurement = z.infer<typeof lintSchema>;
const pairSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), mapping: z.object({ A: armSchema, B: armSchema }), response: judgmentSchema }),
  z.object({ status: z.enum(["invalid_environment", "execution_failed"]), error: z.string() })
]);
export type GradedPair = z.infer<typeof pairSchema>;
const schema = z.object({ protocol: z.literal("tanteki-isolated-v1"), runFingerprint: z.string(), model: z.string(), effort: z.string(), instructionsHash: z.string(), createdAt: z.string(), lint: z.record(z.string(), lintSchema), pairs: z.record(z.string(), pairSchema), sealed: z.boolean(), fingerprint: z.string().optional() });
export type Evaluation = z.infer<typeof schema>;
export const Evaluation = { schema, judgmentSchema, lintSchema } as const;

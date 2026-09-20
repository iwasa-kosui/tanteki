import { z } from "zod";
import { AuthorResponse } from "./job.ts";
import { armSchema } from "./benchmark-case.ts";
import { schemaResult } from "./validation.ts";

const usageSchema = z.object({ input_tokens: z.number().nonnegative(), cached_input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() });
export type Usage = z.infer<typeof usageSchema>;
export const emptyUsage = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
const common = z.object({
  promptHash: z.string(), jobHash: z.string(), environmentHash: z.string().optional(),
  containerId: z.string().optional(), usage: usageSchema, modelCalls: z.number().int().nonnegative(),
  providerResponses: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(),
  observations: z.object({ skillTextSeen: z.boolean(), lintCommandSeen: z.boolean() })
});
export type ExecutionMetrics = z.infer<typeof common>;
// status is the persisted protocol field; worker domain transitions use kind.
export type ModelRun<T> = ExecutionMetrics & (
  | Readonly<{ status: "valid"; response: T; responseHash: string }>
  | Readonly<{ status: "invalid_environment" | "execution_failed"; error: string }>
);

const identity = z.object({ id: z.string(), caseId: z.string(), repeat: z.number().int().positive(), arm: armSchema });
export type PlannedExecution = z.infer<typeof identity>;
export const plannedExecutionSchema = identity;
const schema = z.discriminatedUnion("status", [
  common.extend(identity.shape).extend({ status: z.literal("valid"), response: AuthorResponse.schema, responseHash: z.string() }),
  common.extend(identity.shape).extend({ status: z.literal("invalid_environment"), error: z.string() }),
  common.extend(identity.shape).extend({ status: z.literal("execution_failed"), error: z.string() })
]);
export type Execution = z.infer<typeof schema>;
export type ValidExecution = Extract<Execution, { status: "valid" }>;
export const Execution = { schema, parse: schemaResult(schema) } as const;

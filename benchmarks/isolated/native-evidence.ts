import { z } from "zod";

const skillSchema = z.looseObject({ name: z.string(), path: z.string(), scope: z.string(), enabled: z.boolean() });
const catalogSchema = z.object({ data: z.array(z.object({ cwd: z.string(), skills: z.array(skillSchema), errors: z.array(z.unknown()) })) });
const configSchema = z.looseObject({ config: z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).optional() }) });
const threadSchema = z.looseObject({
  model: z.string(), modelProvider: z.string(), cwd: z.string(), instructionSources: z.array(z.string()),
  thread: z.looseObject({ id: z.string() })
});
const environmentSchema = z.object({ protocol: z.literal("tanteki-isolated-v1"), promptHash: z.string(), configTextHash: z.string(), privateHomeEmpty: z.boolean(), workspaceEmpty: z.boolean(), skillDigest: z.string().nullable() });
const schema = environmentSchema.extend({ initialized: z.unknown(), config: configSchema, catalog: catalogSchema, thread: threadSchema });
export type NativeEvidence = z.infer<typeof schema>;
export type EnvironmentEvidence = z.infer<typeof environmentSchema>;
export type SkillCatalog = z.infer<typeof catalogSchema>;
export const NativeEvidence = { schema, catalogSchema, configSchema, threadSchema } as const;

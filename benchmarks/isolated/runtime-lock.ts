import { z } from "zod";
import { inventorySchema } from "./protocol.ts";

const schema = z.object({
  protocol: z.literal("tanteki-isolated-v1"), createdAt: z.string(), codexVersion: z.string(),
  runtimeImage: z.string().regex(/^sha256:[0-9a-f]{64}$/), bundleImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runtimeSources: z.record(z.string(), z.string()), skillSource: inventorySchema, bundleInventory: inventorySchema,
  sourceRevision: z.string(), fingerprint: z.string()
});
export type RuntimeLock = z.infer<typeof schema>;
export const RuntimeLock = { schema } as const;

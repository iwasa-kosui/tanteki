import { z } from "zod";
import { inventorySchema } from "./protocol.ts";
import { protocolSchema } from "./provider.ts";

const schema = z.object({
  protocol: protocolSchema, createdAt: z.string(), codexVersion: z.string().optional(),
  claudeVersion: z.string().optional(),
  runtimeImage: z.string().regex(/^sha256:[0-9a-f]{64}$/), bundleImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runtimeSources: z.record(z.string(), z.string()), skillSource: inventorySchema, bundleInventory: inventorySchema,
  sourceRevision: z.string(), fingerprint: z.string()
});
export type RuntimeLock = z.infer<typeof schema>;
export const RuntimeLock = { schema } as const;

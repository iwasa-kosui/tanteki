import { z } from "zod";
import { schemaResult } from "./validation.ts";

export const dimensions = ["facts", "grounding", "role", "clarity", "economy"] as const;
const criteria = z.strictObject({ facts: z.string().min(1), grounding: z.string().min(1), role: z.string().min(1), clarity: z.string().min(1), economy: z.string().min(1) });
const schema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), title: z.string(), prompt: z.string().min(1),
  type: z.enum(["prd", "design-doc", "adr", "rfc", "stock", "flow", "record"]),
  documentType: z.string().min(1), criteria, expectedBody: z.string().optional()
});
const suiteSchema = z.array(schema).min(1).refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, "Duplicate case ID");
export type BenchmarkCase = Readonly<z.infer<typeof schema>>;
export const BenchmarkCase = { schema, suiteSchema, parse: schemaResult(schema) } as const;

export const armSchema = z.enum(["without_skill", "with_skill"]);
export type Arm = z.infer<typeof armSchema>;
export const arms = ["without_skill", "with_skill"] as const;

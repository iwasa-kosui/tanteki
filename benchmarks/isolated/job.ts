import { z } from "zod";
import { schemaResult, parseJSON } from "./validation.ts";

const schema = z.strictObject({
  protocol: z.literal("tanteki-isolated-v1"), kind: z.enum(["author", "judge"]),
  prompt: z.string().min(1), instructions: z.string().min(1),
  schema: z.looseObject({ type: z.literal("object"), required: z.array(z.string()) }),
  model: z.string().min(1), effort: z.enum(["minimal", "low", "medium", "high", "xhigh"])
});
export type Job = Readonly<z.infer<typeof schema>>;
export const Job = { schema, parse: schemaResult(schema), fromJSON: (text: string) => parseJSON(text).andThen(schemaResult(schema)) } as const;

// Validation must preserve body bytes; trim is only a predicate, never a transform.
const authorResponseSchema = z.strictObject({ body: z.string().refine((s) => s.trim().length > 0), notes: z.string() });
export type AuthorResponse = Readonly<z.infer<typeof authorResponseSchema>>;
export const AuthorResponse = { schema: authorResponseSchema, parse: schemaResult(authorResponseSchema) } as const;

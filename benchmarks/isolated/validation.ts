import { err, ok, Result } from "neverthrow";
import { z } from "zod";

export type ValidationError = Readonly<{ kind: "ValidationError"; message: string }>;
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const schemaResult = <S extends z.ZodType>(schema: S) =>
  (input: unknown): Result<z.output<S>, ValidationError> => {
    const result = schema.safeParse(input);
    return result.success ? ok(result.data) : err({ kind: "ValidationError", message: result.error.message });
  };

export const parseJSON = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (error): ValidationError => ({ kind: "ValidationError", message: messageOf(error) })
);

// Infrastructure adapters may reject malformed I/O. Domain transitions use Result.
export function decode<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schemaResult(schema)(input);
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

export function assertNever(value: never): never { throw new Error(`Unreachable state: ${String(value)}`); }

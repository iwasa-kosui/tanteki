import { z } from "zod";
import type { CodexNotification } from "./worker-message.ts";

const completedCommand = z.object({ item: z.object({
  type: z.literal("commandExecution"), exitCode: z.union([z.literal(0), z.literal(1)]),
  commandActions: z.array(z.looseObject({ command: z.string() }))
}) });

// Count direct invocations only. Mentioning a package/path, reading its source,
// or checking require.resolve is not evidence that lint ran. Indirect wrappers
// can be missed; this observation is not a complete process audit.
const lintInvocation = /^(?:node\s+(?:"[^"\n]*\/scripts\/lint\.mjs"|'[^'\n]*\/scripts\/lint\.mjs'|[^\s'";|&]*scripts\/lint\.mjs)|(?:npx\s+(?:--no-install\s+)?|npm\s+exec\s+(?:--\s+)?|(?:[^\s'";|&]*\/)?)(?:textlint))(?:\s|$)/;

export function sawLintCommand(event: CodexNotification): boolean {
  if (event.method !== "item/completed") return false;
  const result = completedCommand.safeParse(event.params);
  return result.success && result.data.item.commandActions.some((action) => lintInvocation.test(action.command.trim()));
}

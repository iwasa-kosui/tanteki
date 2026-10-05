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

const claudeToolUse = z.object({ message: z.object({ content: z.array(z.looseObject({ type: z.string() })) }) });
const bashUse = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.literal("Bash"), input: z.looseObject({ command: z.string() }) });
const toolResult = z.looseObject({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional(), content: z.unknown().optional() });

// Claude Code reports a failed Bash call as is_error with "Exit code N"; lint exits 1 when it only has findings,
// which Codex counts as a run (exit 0 or 1). Exit code 1 therefore counts here too; anything else does not.
const lintRan = (result: z.infer<typeof toolResult>) => {
  if (!result.is_error) return true;
  const text = typeof result.content === "string" ? result.content : Array.isArray(result.content) ? result.content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("") : "";
  return /^Exit code 1(?:\n|$)/.test(text);
};

// Stateful because tool_use and tool_result arrive in separate stream events.
export function claudeObserver() {
  const pending = new Set<string>();
  return {
    lintCommandSeen(event: { type: string }): boolean {
      const parsed = claudeToolUse.safeParse(event);
      if (!parsed.success) return false;
      let seen = false;
      for (const block of parsed.data.message.content) {
        if (event.type === "assistant") {
          const use = bashUse.safeParse(block);
          if (use.success && lintInvocation.test(use.data.input.command.trim())) pending.add(use.data.id);
        } else if (event.type === "user") {
          const result = toolResult.safeParse(block);
          if (result.success && pending.delete(result.data.tool_use_id) && lintRan(result.data)) seen = true;
        }
      }
      return seen;
    }
  };
}

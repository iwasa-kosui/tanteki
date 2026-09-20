import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const expectedContexts = JSON.parse(await readFile(new URL("./runtime-context.json", import.meta.url), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function contextFingerprint(context) {
  return { hash: digest(JSON.stringify(context)), messages: context.map((m) => ({ role: m.role, content: m.content.map((c) => ({ type: c.type, sha256: digest(c.text) })) })) };
}

export function auditInput(rollout, { prompt, instructions, model, effort, workspace }, profiles = expectedContexts) {
  const rows = rollout.split("\n").filter(Boolean).map(JSON.parse);
  const metas = rows.filter((r) => r.type === "session_meta");
  const turns = rows.filter((r) => r.type === "turn_context");
  if (metas.length !== 1 || turns.length !== 1) throw new Error("Input audit: expected one fresh session and turn");
  const meta = metas[0].payload, turn = turns[0].payload;
  if (meta.cwd !== workspace || turn.cwd !== workspace || turn.model !== model || turn.effort !== effort) throw new Error("Input audit: runtime identity mismatch");
  if (meta.base_instructions?.text !== instructions.trimEnd()) throw new Error("Input audit: unexpected base instructions");
  const items = rows.filter((r) => r.type === "response_item").map((r) => r.payload);
  const messages = items.filter((p) => ["system", "developer", "user"].includes(p.role)).map(({ role, content }) => ({ role, content }));
  const input = messages.at(-1);
  if (input?.role !== "user" || input.content?.length !== 1 || input.content[0].type !== "input_text" || input.content[0].text !== prompt) throw new Error("Input audit: prompt mismatch");
  const context = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content.map((c) => {
    if (c.type !== "input_text" || typeof c.text !== "string") throw new Error("Input audit: non-text context");
    return { type: c.type, text: c.text.replaceAll(workspace, "<WORKSPACE>").replace(/(<current_date>)[0-9]{4}-[0-9]{2}-[0-9]{2}(<\/current_date>)/g, "$1<DATE>$2") };
  }) }));
  // Exact equality rejects skill catalogs, skill instructions, plugins, AGENTS changes,
  // injected reminders and extra turns, not merely known forbidden keywords.
  if (JSON.stringify(contextFingerprint(context)) !== JSON.stringify(profiles[model])) throw new Error("Input audit: unexpected session context (skills/instructions/history may have leaked)");
  if (items.filter((p) => p.role === "assistant").length !== 1 || items.some((p) => !["message", "reasoning"].includes(p.type))) throw new Error("Input audit: unexpected response items or tool activity");
  const firstAssistant = items.findIndex((p) => p.role === "assistant");
  if (items.slice(firstAssistant + 1).some((p) => ["system", "developer", "user"].includes(p.role))) throw new Error("Input audit: context arrived after the response");
  return { version: 2, sessionId: meta.id, model, effort, baseInstructions: meta.base_instructions.text, context: contextFingerprint(context).messages, prompt, contextHash: digest(JSON.stringify(context)), promptHash: digest(prompt), normalization: "Workspace/date are normalized before checking shared context, whose content is represented by SHA-256 digests. Prompt and custom base instructions are exact." };
}

export async function readSessionRollout(sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Input audit: invalid session ID");
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const paths = (await readdir(sessions, { recursive: true })).filter((path) => path.endsWith(`${sessionId}.jsonl`));
  if (paths.length !== 1) throw new Error("Input audit: missing/ambiguous saved session");
  return readFile(join(sessions, paths[0]), "utf8");
}

import { z } from "zod";
import { NativeEvidence } from "./native-evidence.ts";
import { canonical, invariant, sha256, type Inventory } from "./protocol.ts";
import { protocolOf } from "./provider.ts";
import { decode } from "./validation.ts";
import type { Job } from "./job.ts";

export const claudeProtocol = protocolOf("claude");
export const claudeSkillPath = "/home/agent/.claude/skills/tanteki";
export const claudeEnvironment = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/agent", LANG: "C.UTF-8", TZ: "UTC",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:19876", ANTHROPIC_API_KEY: "sk-ant-local-relay-only",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_GROWTHBOOK: "1",
  // Without this, twelve built-in skills (dataviz, code-review, ...) are listed to the model in both arms.
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  // Measured: without this a 503 is retried 7 times in 40 s; with it, once.
  CLAUDE_CODE_MAX_RETRIES: "0",
  npm_config_offline: "true", npm_config_cache: `${claudeSkillPath}/.npm-cache`
} as const;
// Claude Code appends a commit/PR attribution system-reminder to the first user message unless it is blanked.
export const claudeSettings = { attribution: { commit: "", pr: "" } } as const;

const authorTools = ["Bash", "Edit", "Read", "Skill", "StructuredOutput", "Write"];
// StructuredOutput is Claude Code's own synthetic tool for --json-schema; it is not a --tools entry.
export const expectedTools = (job: Pick<Job, "kind">): readonly string[] => job.kind === "author" ? authorTools : ["StructuredOutput"];
// Skill must be enabled or the skill catalog never reaches the model. `doctor` is listed by init but is never offered to the model.
export const hiddenSkills: readonly string[] = ["doctor"];
export const allowedPlugins: readonly string[] = ["cc-plugin-agents-md"];
// Exact system-reminder blocks that may appear in a request. None is expected.
export const allowedReminders: readonly string[] = [];

// Both arms get identical arguments; the skill is present or absent only as files.
// Claude Code's validator does not know the draft 2020-12 meta-schema that z.toJSONSchema declares, so the $schema key is dropped.
export function claudeArguments(job: Job): string[] {
  const { $schema, ...schema } = job.schema;
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--model", job.model, "--effort", job.effort,
    "--system-prompt", job.instructions, "--json-schema", canonical(schema),
    "--setting-sources", "user", "--settings", canonical(claudeSettings), "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
    ...(job.kind === "author" ? ["--tools", "Bash,Read,Write,Edit,Skill", "--allowedTools", "Bash,Read,Write,Edit,Skill"] : ["--tools", ""])
  ];
}
export const claudeCommandHash = (job: Job) => sha256(canonical({ arguments: claudeArguments(job), environment: claudeEnvironment }));

export const claudeEventSchema = z.looseObject({ type: z.string() });
const initSchema = z.looseObject({ type: z.literal("system"), subtype: z.literal("init") });
const schema = NativeEvidence.environmentSchema.extend({ init: initSchema });
export type ClaudeEvidence = z.infer<typeof schema>;
export const ClaudeEvidence = { schema } as const;
const strictInit = initSchema.extend({
  claude_code_version: z.string(), mcp_servers: z.array(z.unknown()), model: z.string(), tools: z.array(z.string()), skills: z.array(z.string()),
  plugins: z.array(z.looseObject({ name: z.string(), path: z.string() })), apiKeySource: z.string(), permissionMode: z.string(), cwd: z.string()
});
const sameSet = (actual: readonly string[], expected: readonly string[]) => canonical([...new Set(actual)].sort()) === canonical([...expected].sort()) && new Set(actual).size === actual.length;

// Everything Claude Code reports about itself must match what this harness configured.
export function validateClaudePreflight(raw: unknown, job: Job, bundle: Inventory | null, claudeVersion: string) {
  const value = decode(schema, raw);
  invariant(value.protocol === claudeProtocol && value.promptHash === sha256(job.prompt), "Submitted prompt differs");
  invariant(value.configTextHash === claudeCommandHash(job), "Claude command line or environment differs");
  invariant(value.skillDigest === (bundle?.digest ?? null), "Skill bundle differs");
  invariant(value.privateHomeEmpty === true && value.workspaceEmpty === true, "Reused working state");
  const init = decode(strictInit, value.init);
  invariant(init.mcp_servers.length === 0, "Unexpected MCP configuration");
  invariant(init.claude_code_version === claudeVersion, "Claude Code version differs");
  invariant(init.model === job.model, "Resolved model differs");
  invariant(init.permissionMode === "dontAsk", "Unexpected permission mode");
  invariant(init.cwd === "/workspace", "Unexpected working directory");
  invariant(init.apiKeySource === "ANTHROPIC_API_KEY", "Unexpected API key source");
  invariant(sameSet(init.skills.filter((skill) => !hiddenSkills.includes(skill)), bundle ? ["tanteki"] : []), "Unexpected skills");
  invariant(sameSet(init.tools, expectedTools(job)), "Unexpected tools");
  invariant(init.plugins.every((plugin) => plugin.path === "builtin" && allowedPlugins.includes(plugin.name)), "Unexpected plugin");
  return value;
}

const textBlock = z.looseObject({ type: z.string(), text: z.string().optional() });
const messageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(textBlock)]) });
const requestSchema = z.looseObject({
  model: z.string(), stream: z.boolean().optional(), output_config: z.looseObject({ effort: z.string().optional() }).optional(),
  tools: z.array(z.looseObject({ name: z.string() })), system: z.array(z.looseObject({ type: z.string(), text: z.string() })), messages: z.array(messageSchema)
});
export type AnthropicRequest = z.infer<typeof requestSchema>;

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
  return into;
}
const userTexts = (content: string | z.infer<typeof textBlock>[]) => typeof content === "string" ? [content] : content.filter((block) => block.type === "text").map((block) => block.text ?? "");

// `first` marks the opening request of a session, the only one whose last user text is exactly the prompt.
export function checkAnthropicRequest(raw: unknown, job: Job, { first }: { first: boolean }) {
  const body = decode(requestSchema, raw);
  invariant(body.model === job.model, "Model substitution detected");
  invariant(body.stream === true, "Model request must stream");
  invariant(body.output_config?.effort === job.effort, "Reasoning effort changed");
  invariant(sameSet(body.tools.map((tool) => tool.name), expectedTools(job)), "Unexpected tool set");
  invariant(!("mcp_servers" in body), "MCP servers in model request");
  invariant(body.system.at(-1)?.text === job.instructions, "System instructions differ from the job");
  for (const text of strings({ system: body.system, messages: body.messages })) {
    invariant(!allowedReminders.reduce((rest, reminder) => rest.replaceAll(reminder, ""), text).includes("<system-reminder>"), "Unexpected system-reminder in model input");
  }
  if (first) {
    const user = body.messages.find((message) => message.role === "user");
    invariant(user && userTexts(user.content).at(-1) === job.prompt, "Prompt missing from actual model request");
  }
  return body;
}

const catalogHeading = "The following skills are available for use with the Skill tool:";
// Remove what legitimately differs between arms or runs; any other difference stays visible.
function normalizeEnvironment(text: string, withSkill: boolean): string {
  const paragraphs = text.split("\n\n");
  const heading = paragraphs.indexOf(catalogHeading);
  if (withSkill) {
    invariant(heading >= 0 && paragraphs[heading + 1]?.startsWith("- tanteki: ") && !paragraphs[heading + 1].includes("\n- "), "Native skill catalog missing or unexpected");
    paragraphs.splice(heading, 2);
  } else invariant(heading < 0, "Unexpected native skill catalog");
  return paragraphs.join("\n\n").replace(/^( - OS Version: ).*$/m, "$1<os>").replace(/(Today's date is )[^\n]*\./, "$1<date>.");
}

export function comparableAnthropicRequest(raw: unknown, job: Job, withSkill: boolean) {
  const body = checkAnthropicRequest(raw, job, { first: true });
  const { metadata, ...rest } = body;
  const { user_id, ...otherMetadata } = z.looseObject({ user_id: z.unknown().optional() }).parse(metadata ?? {});
  let environments = 0;
  const messages = body.messages.map((message) => {
    if (message.role !== "system") return message;
    const content = typeof message.content === "string" ? normalizeEnvironment(message.content, withSkill) : message.content.map((block) => block.text === undefined ? block : { ...block, text: normalizeEnvironment(block.text, withSkill) });
    environments++;
    return { ...message, content };
  });
  invariant(environments === 1, "Environment block missing from model input");
  return { ...rest, ...(Object.keys(otherMetadata).length ? { metadata: otherMetadata } : {}), messages };
}

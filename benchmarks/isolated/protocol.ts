import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { decode } from "./validation.ts";
import { NativeEvidence, type SkillCatalog } from "./native-evidence.ts";
import type { Job } from "./job.ts";
import type { BenchmarkCase } from "./benchmark-case.ts";
import type { Manifest, Settings } from "./manifest.ts";
import type { Execution, ValidExecution } from "./execution.ts";

export const inventorySchema = z.object({ digest: z.string(), files: z.record(z.string(), z.union([z.object({ link: z.string() }), z.object({ sha256: z.string(), executable: z.boolean() })])) });
export type Inventory = z.infer<typeof inventorySchema>;
export type Mount = Readonly<{ source: string; target: string }>;
const containerSchema = z.object({
  Image: z.string(), Config: z.object({ Hostname: z.string(), WorkingDir: z.string(), Env: z.array(z.string()) }),
  Mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean() })),
  HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.boolean(), ReadonlyRootfs: z.boolean(), Binds: z.array(z.string()).nullable().optional(),
    SecurityOpt: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(), CapAdd: z.array(z.string()).nullable(),
    PidMode: z.string(), IpcMode: z.string(), Memory: z.number(), NanoCpus: z.number(), PidsLimit: z.number(), Tmpfs: z.record(z.string(), z.string()) })
});
const modelRequestSchema = z.looseObject({ model: z.string(), previous_response_id: z.unknown().optional(), conversation: z.unknown().optional(), store: z.boolean(),
  input: z.array(z.record(z.string(), z.unknown())), reasoning: z.object({ effort: z.string() })
});

export const protocol = "tanteki-isolated-v1";
export const skillPath = "/home/agent/.agents/skills/tanteki";
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const canonical = (value: unknown): string => { const text = JSON.stringify(sort(value)); invariant(typeof text === "string", "Value is not serializable"); return text; };
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, sort(item)]));
  return value;
}
export const digest = (value: unknown) => sha256(canonical(value));
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Hash paths, bytes and executable bits. Symlinks are recorded rather than followed;
// an exported bundle must never import data from outside its own tree.
export async function inventory(directory: string, { allowLinks = false }: { allowLinks?: boolean } = {}): Promise<Inventory> {
  const entries: Inventory["files"] = {};
  async function walk(relative: string) {
    const absolute = join(directory, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const { readlink, realpath } = await import("node:fs/promises");
      invariant(allowLinks, `Symlink is not allowed: ${relative}`);
      const target = await realpath(absolute);
      invariant(target.startsWith(`${await realpath(directory)}/`), `Escaping symlink: ${relative}`);
      entries[relative] = { link: await readlink(absolute) };
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else {
      invariant(stat.isFile(), `Not a regular file: ${relative}`);
      entries[relative] = { sha256: sha256(await readFile(absolute)), executable: Boolean(stat.mode & 0o111) };
    }
  }
  await walk("");
  return { digest: digest(entries), files: entries };
}

export const authorInstructions = "Fulfil the user's request using the provided material. Return a JSON object with body (the complete deliverable text, not a link to a file) and notes (any message outside the deliverable).";
export const authorSchema: Job["schema"] = { type: "object", additionalProperties: false, properties: { body: { type: "string" }, notes: { type: "string" } }, required: ["body", "notes"] };

export function configText(job: Job) {
  const q = JSON.stringify;
  return `model = ${q(job.model)}
model_provider = "benchmark"
model_reasoning_effort = ${q(job.effort)}
approval_policy = "never"
sandbox_mode = "danger-full-access"
project_doc_max_bytes = 0
web_search = "disabled"
personality = "none"
[features]
apps = false
plugins = false
hooks = false
memories = false
shell_snapshot = false
multi_agent = ${job.kind === "author"}
shell_tool = ${job.kind === "author"}
unified_exec = ${job.kind === "author"}
[analytics]
enabled = false
[model_providers.benchmark]
name = "benchmark"
base_url = "http://127.0.0.1:19876/v1"
env_key = "BENCHMARK_TOKEN"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;
}

export function checkCatalog(catalog: SkillCatalog, withSkill: boolean) {
  invariant(catalog?.data?.length === 1 && catalog.data[0].cwd === "/workspace", "Missing native skill catalog");
  const entry = catalog.data[0];
  invariant(Array.isArray(entry.errors) && entry.errors.length === 0, "Native skill discovery failed");
  const active = entry.skills.filter((s) => s.enabled);
  invariant(active.length === Number(withSkill), "Unexpected enabled skills");
  if (withSkill) invariant(active[0].name === "tanteki" && active[0].path === `${skillPath}/SKILL.md`, "Wrong treatment skill");
  for (const skill of entry.skills) {
    invariant(skill.path === `${skillPath}/SKILL.md` || (skill.scope === "system" && !skill.enabled), `Unexpected skill: ${skill.path}`);
  }
}

export function checkContainer(raw: unknown, image: string, expectedMounts: readonly Mount[]) {
  const info = decode(containerSchema, raw);
  invariant(info.Image === image, "Container image mismatch");
  invariant(info.Config.Hostname === "benchmark" && info.Config.WorkingDir === "/workspace", "Container paths differ");
  invariant(info.HostConfig.NetworkMode === "none", "Container has network access");
  invariant(info.HostConfig.Privileged === false && info.HostConfig.ReadonlyRootfs === true, "Container isolation missing");
  const binds = (info.Mounts ?? []).filter((m) => m.Type !== "tmpfs");
  invariant(!info.HostConfig.Binds?.length && binds.length === expectedMounts.length, "Host/shared mount detected");
  for (const mount of binds) invariant(mount.Type === "bind" && !mount.RW && expectedMounts.some((e) => e.source === mount.Source && e.target === mount.Destination), "Unexpected or writable host mount");
  invariant(info.HostConfig.SecurityOpt?.includes("no-new-privileges"), "Privilege escalation is enabled");
  invariant(info.HostConfig.CapDrop?.includes("ALL"), "Capabilities were not dropped");
  invariant(canonical((info.HostConfig.CapAdd ?? []).map((capability) => capability.replace(/^CAP_/, "")).sort()) === canonical(["SETGID", "SETUID"]), "Unexpected capabilities");
  invariant(info.HostConfig.PidMode === "" && info.HostConfig.IpcMode === "private", "Shared process namespace");
  invariant(info.HostConfig.Memory === 2147483648 && info.HostConfig.NanoCpus === 2000000000 && info.HostConfig.PidsLimit === 256, "Resource limits differ");
  const tmpfs = info.HostConfig.Tmpfs ?? {};
  invariant(Object.keys(tmpfs).sort().join() === "/home/agent,/tmp,/workspace", "Unexpected writable paths");
  return { image: info.Image, network: "none", mounts: "verified read-only task input and optional skill bundle", hostname: "benchmark", cwd: "/workspace", limits: { memory: info.HostConfig.Memory, cpus: info.HostConfig.NanoCpus, pids: info.HostConfig.PidsLimit }, environment: info.Config.Env };
}

export function checkRequest(raw: unknown, job: Pick<Job, "model" | "effort">) {
  const body = decode(modelRequestSchema, raw);
  invariant(body && body.model === job.model, "Model substitution detected");
  invariant(!body.previous_response_id && !body.conversation, "Remote conversation reuse is forbidden");
  invariant(body.store === false, "Model request must disable remote persistence");
  invariant(Array.isArray(body.input), "Missing model input");
  invariant(body.reasoning.effort === job.effort, "Reasoning effort changed");
  return body;
}

// Compare model-visible input except native skill discovery. IDs identify fresh sessions.
export function comparableRequest(raw: unknown, job: Job, withSkill: boolean) {
  const body = checkRequest(raw, job);
  const { prompt_cache_key, client_metadata, input, ...settings } = body;
  let catalogs = 0;
  const messageSchema = z.looseObject({ type: z.literal("message"), role: z.enum(["developer", "user", "system"]), content: z.array(z.looseObject({ type: z.literal("input_text"), text: z.string() })) });
  const inputSchema = z.discriminatedUnion("type", [messageSchema,
    z.looseObject({ type: z.literal("additional_tools"), role: z.literal("developer"), tools: z.array(z.record(z.string(), z.unknown())) })
  ]);
  const messages = input.map((rawMessage) => {
    const item = decode(inputSchema, rawMessage);
    if (item.type === "additional_tools") {
      // Code-mode models put tool definitions in input. Compare all definitions,
      // excluding only the identifier of this fresh input item.
      const { id, ...definitions } = item;
      return definitions;
    }
    const { id, content, ...message } = item;
    return { ...message, content: content.filter((part) => {
      if (!part.text.startsWith("<skills_instructions>\n")) return true;
      invariant(withSkill && message.role === "developer" && part.text.endsWith("</skills_instructions>") && part.text.includes("\n- tanteki:"), "Unexpected native skill instructions");
      catalogs++;
      return false;
    }) };
  });
  invariant(catalogs === Number(withSkill), "Native skill catalog missing from model input");
  return { ...settings, input: messages };
}

export function publicJob(c: Pick<BenchmarkCase, "prompt">, settings: Pick<Settings, "model" | "effort">): Job {
  // Never spread a case: criteria, expectedBody and condition labels stay outside.
  return { protocol, kind: "author", prompt: c.prompt, instructions: authorInstructions, schema: authorSchema, model: settings.model, effort: settings.effort };
}

export function validatePreflight(raw: unknown, job: Job, bundle: Inventory | null) {
  const value = decode(NativeEvidence.schema, raw);
  invariant(value?.protocol === protocol && value.promptHash === sha256(job.prompt), "Submitted prompt differs");
  invariant(value.configTextHash === sha256(configText(job)), "Initial config differs");
  invariant(value.thread?.model === job.model && value.thread.cwd === "/workspace" && value.thread.modelProvider === "benchmark", "Resolved thread differs");
  invariant(Array.isArray(value.thread.instructionSources) && value.thread.instructionSources.length === 0, "Unexpected instruction files loaded");
  checkCatalog(value.catalog, Boolean(bundle));
  invariant(value.skillDigest === (bundle?.digest ?? null), "Skill bundle differs");
  invariant(value.privateHomeEmpty === true && value.workspaceEmpty === true, "Reused working state");
  invariant(value.config?.config && !Object.keys(value.config.config.mcp_servers ?? {}).length, "Unexpected MCP configuration");
  return value;
}

export function pairedRecords(manifest: Pick<Manifest, "plan">, records: readonly Execution[]): [ValidExecution, ValidExecution][] {
  invariant(records.length === manifest.plan.length, "Missing planned executions");
  const byId = new Map(records.map((r) => [r.id, r]));
  invariant(byId.size === records.length, "Duplicate execution record");
  const pairs: [ValidExecution, ValidExecution][] = [];
  for (const planned of manifest.plan) {
    const r = byId.get(planned.id);
    invariant(r && r.arm === planned.arm && r.caseId === planned.caseId && r.repeat === planned.repeat, "Execution does not match plan");
    invariant(["valid", "invalid_environment", "execution_failed"].includes(r.status), "Unknown execution status");
    if (planned.arm !== "without_skill") continue;
    const other = byId.get(`${r.caseId}.${r.repeat}.with_skill`);
    invariant(other, "Missing paired execution");
    if (r.status === "valid" && other.status === "valid") {
      invariant(r.promptHash === other.promptHash && r.jobHash === other.jobHash, "Pair inputs differ");
      invariant(r.environmentHash === other.environmentHash, "Pair environments differ");
      pairs.push([r, other]);
    }
  }
  return pairs;
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, chmod, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as zlib from "node:zlib";
import { z } from "zod";
import { decode, messageOf } from "./validation.ts";
import { WorkerMessage } from "./worker-message.ts";
import { sawLintCommand } from "./observations.ts";
import type { NativeEvidence } from "./native-evidence.ts";
import type { Job } from "./job.ts";
import { emptyUsage, type ModelRun, type ExecutionMetrics } from "./execution.ts";
import { Evaluation } from "./evaluation.ts";
import type { Inventory, Mount } from "./protocol.ts";

export type Transport = (body: Buffer, signal: AbortSignal) => Promise<Response>;
type CommandOptions = { timeout?: number; input?: string; maxBytes?: number; env?: NodeJS.ProcessEnv };
export type ModelOptions<S extends z.ZodType> = {
  image: string; bundle: Inventory | null; bundlePath: string | null; job: Job; directory: string;
  timeout: number; maxCalls: number; transport: Transport; responseSchema: S; signal?: AbortSignal;
};
import { checkContainer, checkRequest, comparableRequest, validatePreflight, digest, sha256, invariant, inventory, canonical } from "./protocol.ts";

export function command(bin: string, args: string[], { timeout = 120000, input, maxBytes = 32 * 1024 * 1024, env = process.env }: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "", stderr = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error(`${bin} timed out`); child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > maxBytes) { failure = new Error(`${bin}: output too large`); child.kill("SIGKILL"); } });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new Error(`${bin} ${args[0]} failed (${code}): ${stderr}`)); else resolve(stdout); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export const docker = (args: string[], options?: CommandOptions) => command("docker", args, options);
export async function temporaryDirectory() {
  const dir = await mkdtemp(join(tmpdir(), "tanteki-isolated-"));
  await chmod(dir, 0o755);
  return dir;
}

export function containerArgs(image: string, mounts: readonly Mount[], { interactive = true, name }: { interactive?: boolean; name: string }) {
  return ["create", ...(interactive ? ["-i"] : []), "--name", name, "--network", "none", "--hostname", "benchmark", "--workdir", "/workspace", "--read-only", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges", "--ipc", "private", "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=512m", "--tmpfs", "/home/agent:rw,nosuid,nodev,mode=1777,size=768m", "--tmpfs", "/workspace:rw,nosuid,nodev,mode=1777,size=256m", ...mounts.flatMap((m) => ["--mount", `type=bind,source=${m.source},target=${m.target},readonly`]), image];
}

export async function exportBundle(image: string, expected: Inventory) {
  const directory = await temporaryDirectory();
  const name = `tanteki-export-${randomUUID()}`;
  try {
    await docker(["create", "--name", name, "--network", "none", "--entrypoint", "/bin/true", image]);
    await docker(["cp", `${name}:/opt/skill`, directory]);
    const path = join(directory, "skill");
    const actual = await inventory(path, { allowLinks: true });
    invariant(actual.digest === expected.digest, "Exported skill bundle differs from build lock");
    return { directory, path };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { await docker(["rm", "-f", name]).catch(() => {}); }
}

export function decodeRequest(message: { data: string; encoding: string }) {
  let data = Buffer.from(message.data, "base64");
  if (message.encoding === "gzip") data = zlib.gunzipSync(data, { maxOutputLength: 16 * 1024 * 1024 });
  else if (message.encoding === "zstd" && zlib.zstdDecompressSync) data = zlib.zstdDecompressSync(data, { maxOutputLength: 16 * 1024 * 1024 });
  else invariant(message.encoding === "identity", `Unsupported transport encoding: ${message.encoding}`);
  invariant(data.length <= 16 * 1024 * 1024, "Model request too large");
  return data;
}

// Production has one fixed destination; there is no generic proxy or CONNECT.
export function apiTransport(apiKey: string | undefined): Transport {
  invariant(typeof apiKey === "string" && apiKey.length > 0, "Set OPENAI_API_KEY on the host; credentials are never copied into containers");
  return async (body, signal) => fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: body.toString("utf8"), signal, redirect: "error" });
}

export class SSEUsage {
  buffer = "";
  usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  completed = 0;
  push(chunk: string) {
    this.buffer += chunk;
    invariant(this.buffer.length < 20 * 1024 * 1024, "Oversized SSE event");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue;
      const raw: unknown = JSON.parse(line.slice(6));
      const event = decode(z.looseObject({ type: z.string() }), raw);
      if (event.type !== "response.completed") continue;
      const value = decode(z.object({ response: z.object({ usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), input_tokens_details: z.object({ cached_tokens: z.number() }).optional() }) }) }), raw);
      const usage = value.response.usage;
      invariant(Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens), "Missing provider usage");
      this.usage.input_tokens += usage.input_tokens;
      this.usage.output_tokens += usage.output_tokens;
      this.usage.cached_input_tokens += usage.input_tokens_details?.cached_tokens ?? 0;
      this.completed++;
    }
  }
}

export async function runModel<S extends z.ZodType>({ image, bundle, bundlePath, job, directory, timeout, maxCalls, transport, responseSchema, signal }: ModelOptions<S>): Promise<ModelRun<z.output<S>>> {
  await mkdir(directory, { recursive: true });
  const staging = await temporaryDirectory();
  const input = join(staging, "input");
  await mkdir(input);
  await writeFile(join(input, "job.json"), canonical(job));
  const mounts: Mount[] = [{ source: input, target: "/input" }, ...(bundlePath ? [{ source: bundlePath, target: "/opt/skill" }] : [])];
  const name = `tanteki-run-${randomUUID()}`;
  const started = performance.now();
  const metrics: ExecutionMetrics = { promptHash: sha256(job.prompt), jobHash: digest(job), usage: emptyUsage(), modelCalls: 0, providerResponses: 0, elapsedMs: 0, observations: { skillTextSeen: false, lintCommandSeen: false } };
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: NodeJS.Timeout | undefined;
  let preflight: NativeEvidence | undefined;
  let gotInput = false;
  let response: unknown;
  let violation: string | undefined;
  let failure: string | undefined;
  let code: number | null = null;
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let logChain = Promise.resolve();
  const log = (event: unknown): void => { logChain = logChain.then(() => appendFile(join(directory, "events.jsonl"), JSON.stringify(event) + "\n")); };
  const stop = (message: string, invalid = false): void => {
    if (invalid) violation ??= message; else failure ??= message;
    for (const controller of controllers) controller.abort();
    child?.kill("SIGKILL");
  };
  const onAbort = (): void => stop("Execution interrupted");
  const send = (message: unknown): void => { if (child && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n"); };
  const userMessage = z.object({ role: z.literal("user"), content: z.array(z.looseObject({ text: z.string() })) });

  async function forward(message: Extract<WorkerMessage, { type: "request" }>): Promise<void> {
    invariant(preflight && gotInput, "Model request before verified input");
    const index = ++metrics.modelCalls;
    if (index > maxCalls) { stop("Model-call budget exceeded"); return; }
    const bytes = decodeRequest(message);
    const body = checkRequest(JSON.parse(bytes.toString("utf8")), job);
    if (index === 1) {
      invariant(body.input.some((item) => { const parsed = userMessage.safeParse(item); return parsed.success && parsed.data.content.some((part) => part.text === job.prompt); }), "Prompt missing from actual model request");
      metrics.environmentHash = digest({ runtime: metrics.environmentHash, request: comparableRequest(body, job, bundle !== null) });
    }
    if (bytes.includes(Buffer.from("name: tanteki\\n"))) metrics.observations.skillTextSeen = true;
    await writeFile(join(directory, `request-${index}.json`), bytes);
    const controller = new AbortController();
    controllers.add(controller);
    const usage = new SSEUsage();
    try {
      const upstream = await transport(bytes, controller.signal);
      send({ type: "response", id: message.id, status: upstream.status, contentType: upstream.headers.get("content-type") ?? "text/event-stream" });
      if (!upstream.ok) failure ??= `Provider HTTP ${upstream.status}`;
      invariant(upstream.body, "Provider returned no response body");
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        send({ type: "chunk", id: message.id, data: Buffer.from(chunk).toString("base64") });
        if (upstream.ok) usage.push(decoder.decode(chunk, { stream: true }));
      }
      if (upstream.ok) usage.push(decoder.decode() + "\n");
      send({ type: "end", id: message.id });
      invariant(!upstream.ok || usage.completed === 1, "Provider response did not complete exactly once");
    } catch (error) { if (!controller.signal.aborted) stop(messageOf(error)); }
    finally {
      for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"] as const) metrics.usage[key] += usage.usage[key];
      metrics.providerResponses += usage.completed;
      controllers.delete(controller);
      log({ type: "providerUsage", index, ...usage.usage, completed: usage.completed });
    }
  }

  async function handle(message: Exclude<WorkerMessage, { type: "request" }>): Promise<void> {
    log(message);
    switch (message.type) {
      case "preflight":
        invariant(!preflight, "Duplicate preflight");
        preflight = validatePreflight(message.value, job, bundle);
        metrics.environmentHash = digest({ container: metrics.environmentHash, config: preflight.config.config });
        await writeFile(join(directory, "preflight.json"), JSON.stringify(preflight, null, 2));
        break;
      case "turnInput":
        invariant(!gotInput && preflight, "Unexpected turn input");
        invariant(canonical(message.input) === canonical([{ type: "text", text: job.prompt, text_elements: [] }]), "Submitted turn input differs");
        gotInput = true;
        break;
      case "violation": stop(message.message, true); break;
      case "fatal": stop(message.message, message.status === "invalid_environment"); break;
      case "result": invariant(response === undefined, "Duplicate result"); response = message.response; break;
      case "event": {
        if (sawLintCommand(message.event)) metrics.observations.lintCommandSeen = true;
        break;
      }
      case "stderr": break;
    }
  }

  try {
    signal?.throwIfAborted();
    await docker(containerArgs(image, mounts, { name }));
    const info = decode(z.array(z.looseObject({ Id: z.string() })).length(1), JSON.parse(await docker(["inspect", name])))[0];
    const environment = checkContainer(info, image, mounts);
    await writeFile(join(directory, "container.json"), JSON.stringify(info, null, 2));
    metrics.containerId = info.Id;
    metrics.environmentHash = digest(environment);
    if (bundlePath && bundle) invariant((await inventory(bundlePath, { allowLinks: true })).digest === bundle.digest, "Skill staging changed");
    child = spawn("docker", ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => log({ type: "dockerStderr", text: chunk.toString() }));
    timer = setTimeout(() => stop("Execution timed out"), timeout * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort(); // An interrupt during container creation must not be lost.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let count = 0;
    let ordered = Promise.resolve();
    lines.on("line", (line) => {
      if (++count > 100000 || line.length > 24 * 1024 * 1024) { stop("Worker log limit exceeded"); return; }
      ordered = ordered.then(() => {
        const parsed = WorkerMessage.fromJSON(line);
        if (parsed.isErr()) throw new Error(parsed.error.message);
        const message = parsed.value;
        if (message.type === "request") {
          const task = forward(message).catch((error: unknown) => stop(messageOf(error), true)).finally(() => tasks.delete(task));
          tasks.add(task);
        } else return handle(message);
      }).catch((error: unknown) => stop(messageOf(error), true));
    });
    const attached = child;
    code = await new Promise<number | null>((resolve, reject) => { attached.on("error", reject); attached.on("close", resolve); });
    await ordered;
    await Promise.allSettled([...tasks]);
    await logChain;
    invariant(sha256(await readFile(join(input, "job.json"))) === sha256(canonical(job)), "Input staging changed");
  } catch (error) { violation ??= messageOf(error); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    for (const controller of controllers) controller.abort();
    await docker(["rm", "--force", name]).catch((error: unknown) => { violation = `Container cleanup failed: ${messageOf(error)}`; });
    await rm(staging, { recursive: true, force: true });
  }
  metrics.elapsedMs = Math.round(performance.now() - started);
  const parsed = responseSchema.safeParse(response);
  const output: ModelRun<z.output<S>> = violation
    ? { ...metrics, status: "invalid_environment", error: violation }
    : code !== 0 || failure || !preflight || !gotInput || !metrics.modelCalls || metrics.modelCalls !== metrics.providerResponses || !parsed.success
      ? { ...metrics, status: "execution_failed", error: failure ?? `Incomplete worker run (${code})${parsed.success ? "" : "; invalid final response"}` }
      : { ...metrics, status: "valid", response: parsed.data, responseHash: digest(parsed.data) };
  await writeFile(join(directory, "result.json"), JSON.stringify(output, null, 2));
  return output;
}

export async function runLint({ image, body, documentType, timeout = 60 }: { image: string; body: string; documentType: string; timeout?: number }) {
  const directory = await temporaryDirectory();
  const name = `tanteki-lint-${randomUUID()}`;
  try {
    const bodyHash = sha256(body);
    await writeFile(join(directory, "job.json"), canonical({ body, bodyHash, documentType }));
    const mounts = [{ source: directory, target: "/input" }];
    await docker(containerArgs(image, mounts, { interactive: false, name }));
    checkContainer(JSON.parse(await docker(["inspect", name]))[0], image, mounts);
    const result = decode(Evaluation.lintSchema, JSON.parse(await docker(["start", "--attach", name], { timeout: timeout * 1000 })));
    invariant(result.bodyHash === bodyHash && Array.isArray(result.lint), "Grader input/output mismatch");
    return result;
  } finally { await docker(["rm", "-f", name]).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

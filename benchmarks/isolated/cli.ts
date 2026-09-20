#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { protocol, invariant, digest, sha256, inventory, publicJob, pairedRecords } from "./protocol.ts";
import { docker, command, temporaryDirectory, exportBundle, apiTransport, runModel, runLint } from "./docker.ts";
import { makePlan } from "./plan.ts";
import { writeReport } from "./report.ts";
import { z } from "zod";
import { decode, messageOf, assertNever } from "./validation.ts";
import { BenchmarkCase } from "./benchmark-case.ts";
import { AuthorResponse, Job } from "./job.ts";
import { Execution, plannedExecutionSchema } from "./execution.ts";
import { Manifest } from "./manifest.ts";
import { RuntimeLock } from "./runtime-lock.ts";
import { Evaluation } from "./evaluation.ts";
import { inventorySchema } from "./protocol.ts";
import { options, type BuildOptions, type GenerateOptions, type GradeOptions, type ReportOptions } from "./options.ts";
import type { Transport } from "./docker.ts";
export { options } from "./options.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const readJSON = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const workerFiles = ["protocol.ts", "worker.ts", "worker-environment.ts", "model-relay.ts", "codex-client.ts", "codex-session.ts", "turn-state.ts", "turn-event.ts", "worker-message.ts", "native-evidence.ts", "job.ts", "validation.ts"];
const runtimeFiles = ["Dockerfile", "Bundle.Dockerfile", "package.json", "package-lock.json", ...workerFiles, "lint-worker.ts", "docker.ts", "cli.ts", "report.ts", "benchmark-case.ts", "execution.ts", "manifest.ts", "evaluation.ts", "runtime-lock.ts", "options.ts", "plan.ts", "observations.ts", "../readable-report.mjs", "../comparison-validity.mjs", "../invalidated-runs.json", "../comparison.css", "../../package-lock.json"];

async function runtimeSources(): Promise<Record<string,string>> { return Object.fromEntries(await Promise.all(runtimeFiles.map(async (name) => [name, sha256(await readFile(join(here, name)))]))); }

export async function build(o: BuildOptions) {
  invariant(o.out, "--out is required");
  const out = resolve(o.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Builds and runs never overwrite previous evidence.
  const staging = await temporaryDirectory();
  try {
    await command(process.execPath, [join(root, "scripts/package-skill.mjs"), "--check"]);
    const source = join(root, "skills/tanteki");
    const skillSource = await inventory(source);
    const runtime = join(staging, "runtime"), bundle = join(staging, "bundle");
    await mkdir(runtime); await mkdir(bundle);
    for (const name of ["Dockerfile", "package.json", "package-lock.json", ...workerFiles]) await cp(join(here, name), join(runtime, name));
    await cp(source, join(bundle, "skill"), { recursive: true });
    for (const [sourceName, target] of [["Bundle.Dockerfile", "Dockerfile"], ...["package.json", "package-lock.json", "lint-worker.ts", "evaluation.ts", "benchmark-case.ts", ...workerFiles].map((name) => [name, name])]) await cp(join(here, sourceName), join(bundle, target));
    console.log("Building fixed Codex runtime (no skill or grading data)…");
    await docker(["build", "--build-arg", `CODEX_VERSION=${o.codexVersion}`, "--iidfile", join(staging, "runtime.id"), runtime], { timeout: 600000 });
    console.log("Building the offline skill / evaluator bundle…");
    await docker(["build", "--iidfile", join(staging, "bundle.id"), bundle], { timeout: 600000 });
    const runtimeImage = (await readFile(join(staging, "runtime.id"), "utf8")).trim();
    const bundleImage = (await readFile(join(staging, "bundle.id"), "utf8")).trim();
    const bundleInventory = decode(inventorySchema, JSON.parse(await docker(["run", "--rm", "--network", "none", bundleImage, "inventory"])));
    const actualVersion = (await docker(["run", "--rm", "--network", "none", "--entrypoint", "codex", runtimeImage, "--version"])).trim();
    invariant(actualVersion === `codex-cli ${o.codexVersion}`, "Installed Codex version differs");
    const unsigned = { protocol, createdAt: new Date().toISOString(), codexVersion: o.codexVersion, runtimeImage, bundleImage, runtimeSources: await runtimeSources(), skillSource, bundleInventory, sourceRevision: (await command("git", ["-C", root, "rev-parse", "HEAD"])).trim() };
    const lock = decode(RuntimeLock.schema, { ...unsigned, fingerprint: digest(unsigned) });
    await save(join(out, "runtime-lock.json"), lock);
    console.log(join(out, "runtime-lock.json"));
    return lock;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function loadLock(path: string) {
  const lock = decode(RuntimeLock.schema, await readJSON(path));
  const { fingerprint, ...unsigned } = lock;
  invariant(fingerprint === digest(unsigned) && lock.protocol === protocol, "Invalid runtime lock");
  for (const image of [lock.runtimeImage, lock.bundleImage]) invariant(/^sha256:[0-9a-f]{64}$/.test(image), "Images must be pinned by content ID");
  invariant(digest(lock.runtimeSources) === digest(await runtimeSources()), "Harness changed since build; build a new runtime lock");
  return lock;
}

export async function prepare(o: GenerateOptions) {
  const lock = await loadLock(o.lock);
  let cases = decode(BenchmarkCase.suiteSchema, await readJSON(o.casesFile ?? join(root, "benchmarks/cases.json")));
  if (o.caseIds) {
    const ids = o.caseIds.split(",");
    invariant(new Set(ids).size === ids.length && ids.every((id) => cases.some((c) => c.id === id)), "Unknown/duplicate case selection");
    cases = cases.filter((c) => ids.includes(c.id));
  }
  const settings = { model: o.model, effort: o.effort, repeats: o.repeats, seed: o.seed, timeout: o.timeout, maxCalls: o.maxCalls };
  const plan = decode(z.array(plannedExecutionSchema), makePlan(cases, settings.repeats, settings.seed));
  return { lock, cases, settings, plan };
}

export async function generate(o: GenerateOptions, transport?: Transport, signal?: AbortSignal) {
  const prepared = await prepare(o);
  if (o.dryRun) {
    const result = { protocol, settings: prepared.settings, plan: prepared.plan, inputs: prepared.cases.map((c) => ({ id: c.id, promptHash: sha256(c.prompt), jobHash: digest(publicJob(c, prepared.settings)) })) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  transport ??= apiTransport(process.env.OPENAI_API_KEY);
  const { lock, cases, settings, plan } = prepared;
  invariant(o.out, "--out is required");
  const out = resolve(o.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  await mkdir(join(out, "private"));
  await mkdir(join(out, "records"));
  const initial = { protocol, createdAt: new Date().toISOString(), runtimeLockHash: digest(lock), casesHash: digest(cases), settings, plan, sealed: false, evidence: {} };
  await save(join(out, "runtime-lock.json"), lock);
  await save(join(out, "private/cases.json"), cases);
  await save(join(out, "manifest.json"), initial);
  const bundle = await exportBundle(lock.bundleImage, lock.bundleInventory);
  const records: Execution[] = [];
  try {
    for (const planned of plan) {
      signal?.throwIfAborted();
      const c = cases.find((c) => c.id === planned.caseId);
      invariant(c, "Missing planned case");
      const withSkill = planned.arm === "with_skill";
      const result = await runModel({ image: lock.runtimeImage, bundle: withSkill ? lock.bundleInventory : null, bundlePath: withSkill ? bundle.path : null, job: publicJob(c, settings), directory: join(out, "calls", planned.id), timeout: settings.timeout, maxCalls: settings.maxCalls, transport, responseSchema: AuthorResponse.schema, signal });
      const record = decode(Execution.schema, { ...planned, ...result });
      records.push(record);
      await save(join(out, "records", `${planned.id}.json`), record);
      console.log(`${planned.id}: ${record.status}`);
    }
    // A disagreement invalidates both sides, never just the inconvenient side.
    for (const c of cases) for (let repeat = 1; repeat <= settings.repeats; repeat++) {
      const pair = records.filter((r) => r.caseId === c.id && r.repeat === repeat);
      if (pair.every((r) => r.status === "valid") && (new Set(pair.map((r) => r.environmentHash)).size !== 1 || new Set(pair.map((r) => r.jobHash)).size !== 1)) {
        for (const r of pair) { const invalid = decode(Execution.schema, { ...r, status: "invalid_environment", error: "Pair environment/input mismatch" }); records[records.indexOf(r)] = invalid; await save(join(out, "records", `${r.id}.json`), invalid); }
      }
    }
    signal?.throwIfAborted();
    const sealed = { ...initial, evidence: { records: (await inventory(join(out, "records"))).digest, calls: (await inventory(join(out, "calls"))).digest }, sealed: true, completedAt: new Date().toISOString() };
    const manifest = decode(Manifest.schema, { ...sealed, fingerprint: digest(sealed) });
    await save(join(out, "manifest.json"), manifest);
    await writeReport({ out, manifest, cases, records });
    return { out, manifest, records };
  } finally { await rm(bundle.directory, { recursive: true, force: true }); }
}

export async function readRun(path: string) {
  const run = resolve(path);
  const manifest = decode(Manifest.schema, await readJSON(join(run, "manifest.json")));
  const { fingerprint, ...unsigned } = manifest;
  invariant(manifest.protocol === protocol && manifest.sealed && fingerprint === digest(unsigned), "Generation is unsealed or manifest changed");
  const lock = await loadLock(join(run, "runtime-lock.json"));
  const cases = decode(BenchmarkCase.suiteSchema, await readJSON(join(run, "private/cases.json")));
  invariant(digest(cases) === manifest.casesHash && digest(lock) === manifest.runtimeLockHash, "Run inputs changed");
  for (const directory of ["records", "calls"] as const) invariant((await inventory(join(run, directory))).digest === manifest.evidence[directory], `Frozen ${directory} changed`);
  const records = await Promise.all(manifest.plan.map(async (p) => decode(Execution.schema, await readJSON(join(run, "records", `${p.id}.json`)))));
  for (const r of records) if (r.status === "valid") {
    invariant(digest(r.response) === r.responseHash, "Frozen output changed");
  }
  const pairs = pairedRecords(manifest, records);
  return { run, manifest, lock, cases, records, pairs };
}

export async function grade(o: GradeOptions, transport?: Transport, signal?: AbortSignal) {
  const data = await readRun(o.run);
  transport ??= apiTransport(process.env.OPENAI_API_KEY);
  const { manifest, lock, cases, records, pairs } = data;
  invariant(o.out, "--out is required");
  const out = resolve(o.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const instructions = await readFile(join(root, "benchmarks/judge-instructions.txt"), "utf8");
  const evaluation: Evaluation = { protocol, runFingerprint: manifest.fingerprint, model: o.model, effort: o.effort, instructionsHash: sha256(instructions), createdAt: new Date().toISOString(), lint: {}, pairs: {}, sealed: false };
  await writeFile(join(out, "judge-instructions.txt"), instructions);
  for (const pair of pairs) {
    signal?.throwIfAborted();
    const c = cases.find((c) => c.id === pair[0].caseId);
    invariant(c, "Missing paired case");
    const id = `${c.id}.${pair[0].repeat}`;
    try {
      for (const r of pair) evaluation.lint[r.id] = await runLint({ image: lock.bundleImage, body: r.response.body, documentType: c.type });
      const swap = (cases.indexOf(c) + pair[0].repeat) % 2 === 0;
      const mapping: { A: "without_skill" | "with_skill"; B: "without_skill" | "with_skill" } = swap ? { A: "with_skill", B: "without_skill" } : { A: "without_skill", B: "with_skill" };
      // Preserve notes because some criteria explicitly accept draft status there.
      // Hide condition labels and tool logs; candidate wording itself is unmodified.
      const candidates = Object.fromEntries(Object.entries(mapping).map(([label, arm]) => [label, pair[arm === "without_skill" ? 0 : 1].response]));
      const prompt = `原依頼と資料:\n${c.prompt}\n\n判定基準:\n${JSON.stringify(c.criteria)}\n\n候補の本文・注記（A/B）:\n${JSON.stringify(candidates)}`;
      const job = decode(Job.schema, { protocol, kind: "judge", prompt, instructions, schema: z.toJSONSchema(Evaluation.judgmentSchema), model: o.model, effort: o.effort });
      const result = await runModel({ image: lock.runtimeImage, bundle: null, bundlePath: null, job, directory: join(out, "calls", id), timeout: o.timeout, maxCalls: 1, transport, responseSchema: Evaluation.judgmentSchema, signal });
      evaluation.pairs[id] = result.status === "valid" ? { status: "valid", mapping, response: result.response } : { status: result.status, error: result.error };
    } catch (error) { evaluation.pairs[id] = { status: "execution_failed", error: messageOf(error) }; }
    await save(join(out, "evaluation.json"), evaluation);
    console.log(`graded ${id}: ${evaluation.pairs[id].status}`);
  }
  // Recheck the generation's bytes after grading; the scorer cannot revise it.
  await readRun(o.run);
  evaluation.sealed = true;
  evaluation.fingerprint = digest(evaluation);
  await save(join(out, "evaluation.json"), evaluation);
  await writeReport({ out, manifest, cases, records, evaluation });
  return evaluation;
}

export async function report(o: ReportOptions) {
  const data = await readRun(o.run);
  const out = resolve(o.out ?? o.run);
  let evaluation: Evaluation | null = null;
  if (o.evaluation) {
    evaluation = decode(Evaluation.schema, await readJSON(join(resolve(o.evaluation), "evaluation.json")));
    const { fingerprint, ...unsigned } = evaluation;
    invariant(evaluation.sealed && fingerprint === digest(unsigned) && evaluation.runFingerprint === data.manifest.fingerprint, "Evaluation changed or belongs to another run");
  }
  await mkdir(out, { recursive: true });
  return writeReport({ out, ...data, evaluation });
}

export async function main(argv: string[]) {
  const o = options(argv);
  if (o.action === "help") console.log(`Usage:
  npm run benchmark -- build --out BUILD_DIR [--codex-version 0.155.1]
  npm run benchmark -- generate --lock BUILD_DIR/runtime-lock.json --out RUN_DIR --model MODEL [--dry-run]
  npm run benchmark -- grade --run RUN_DIR --out GRADE_DIR --model MODEL
  npm run benchmark -- report --run RUN_DIR [--evaluation GRADE_DIR] [--out REPORT_DIR]

Generation and grading are separate. Set OPENAI_API_KEY on the host for model calls.
See benchmarks/isolated/README.md. Old results use npm run benchmark:legacy.`);
  else {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Benchmark interrupted"));
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      switch (o.action) {
        case "build": await build(o); break;
        case "generate": await generate(o, undefined, controller.signal); break;
        case "grade": await grade(o, undefined, controller.signal); break;
        case "report": await report(o); break;
        default: assertNever(o);
      }
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { console.error(messageOf(error)); process.exitCode = 1; });

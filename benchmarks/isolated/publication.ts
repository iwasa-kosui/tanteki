import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Manifest } from "./manifest.ts";
import { RuntimeLock } from "./runtime-lock.ts";
import { BenchmarkCase } from "./benchmark-case.ts";
import { Execution } from "./execution.ts";
import { Evaluation } from "./evaluation.ts";
import { decode } from "./validation.ts";
import { checkContainer, comparableRequest, digest, inventory, inventorySchema, invariant, pairedRecords, publicJob, sha256, validatePreflight } from "./protocol.ts";
import { summarize } from "./report.ts";

export const auditFiles = ["container.json", "preflight.json", "request-1.json"] as const;
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

// This is an archive verifier: compare against the recorded hashes, not today's
// harness files. Publication must remain readable after the harness evolves.
export async function readPublication(directory: string) {
  const manifest = decode(Manifest.schema, await json(join(directory, "manifest.json")));
  const { fingerprint, ...unsigned } = manifest;
  invariant(fingerprint === digest(unsigned), "Published manifest changed");
  const lock = decode(RuntimeLock.schema, await json(join(directory, "runtime-lock.json")));
  const { fingerprint: lockFingerprint, ...lockUnsigned } = lock;
  invariant(lockFingerprint === digest(lockUnsigned) && digest(lock) === manifest.runtimeLockHash, "Published runtime lock changed");
  const cases = decode(BenchmarkCase.suiteSchema, await json(join(directory, "cases.json")));
  invariant(digest(cases) === manifest.casesHash, "Published cases changed");
  invariant((await inventory(join(directory, "records"))).digest === manifest.evidence.records, "Published records changed");
  const evidence = decode(inventorySchema, await json(join(directory, "evidence-inventory.json")));
  invariant(digest(evidence.files) === evidence.digest && evidence.digest === manifest.evidence.calls, "Published evidence inventory changed");
  const records = await Promise.all(manifest.plan.map(async (p) => decode(Execution.schema, await json(join(directory, "records", `${p.id}.json`)))));
  const pairs = pairedRecords(manifest, records);
  for (const r of records) {
    const c = cases.find((c) => c.id === r.caseId);
    invariant(c, "Unknown published case");
    const job = publicJob(c, manifest.settings);
    invariant(r.promptHash === sha256(c.prompt) && r.jobHash === digest(job), "Published job differs from original prompt");
    for (const file of auditFiles) {
      const expected = evidence.files[`${r.id}/${file}`];
      if (!expected) { invariant(r.status !== "valid", "Missing valid execution evidence"); continue; }
      invariant("sha256" in expected, "Audit must be a regular file");
      invariant(sha256(await readFile(join(directory, "input-audits", r.id, file))) === expected.sha256, "Published input audit changed");
    }
    if (r.status !== "valid") continue;
    invariant(digest(r.response) === r.responseHash, "Published output changed");
    invariant(await readFile(join(directory, "documents", `${r.id}.md`), "utf8") === r.response.body, "Published document differs from original output");
    const withSkill = r.arm === "with_skill";
    const rawContainer = await json(join(directory, "input-audits", r.id, "container.json"));
    const container = decode(z.object({ Id: z.string(), Mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string() })) }), rawContainer);
    const mounts = container.Mounts.filter((m) => m.Type !== "tmpfs").map((m) => {
      invariant(m.Source, "Missing mount source");
      return { source: m.Source, target: m.Destination };
    });
    invariant(mounts.map((m) => m.target).sort().join() === (withSkill ? "/input,/opt/skill" : "/input"), "Unexpected published mounts");
    invariant(container.Id === r.containerId, "Published container ID changed");
    const environment = checkContainer(rawContainer, lock.runtimeImage, mounts);
    const preflight = validatePreflight(await json(join(directory, "input-audits", r.id, "preflight.json")), job, withSkill ? lock.bundleInventory : null);
    const rawRequest = await json(join(directory, "input-audits", r.id, "request-1.json"));
    const request = comparableRequest(rawRequest, job, withSkill);
    const input = decode(z.object({ input: z.array(z.record(z.string(), z.unknown())) }), rawRequest).input;
    const userMessage = z.object({ role: z.literal("user"), content: z.array(z.object({ text: z.string() })) });
    invariant(input.some((item) => { const p = userMessage.safeParse(item); return p.success && p.data.content.some((part) => part.text === c.prompt); }), "Prompt missing from published request");
    invariant(digest({ runtime: digest({ container: digest(environment), config: preflight.config.config }), request }) === r.environmentHash, "Published environment differs from original execution");
  }
  const evaluation = decode(Evaluation.schema, await json(join(directory, "evaluation.json")));
  const { fingerprint: evaluationFingerprint, ...evaluationUnsigned } = evaluation;
  invariant(evaluation.sealed && evaluationFingerprint === digest(evaluationUnsigned) && evaluation.runFingerprint === fingerprint, "Published evaluation changed or belongs to another run");
  invariant(sha256(await readFile(join(directory, "judge-instructions.txt"))) === evaluation.instructionsHash, "Published judge instructions changed");
  invariant(Object.keys(evaluation.pairs).sort().join() === pairs.map(([r]) => `${r.caseId}.${r.repeat}`).sort().join(), "Published evaluation pairs differ");
  for (const pair of pairs) {
    const judgment = evaluation.pairs[`${pair[0].caseId}.${pair[0].repeat}`];
    if (judgment.status !== "valid") continue;
    invariant(judgment.mapping.A !== judgment.mapping.B, "Duplicate judgment mapping");
    for (const r of pair) invariant(evaluation.lint[r.id]?.bodyHash === sha256(r.response.body), "Published lint does not match output");
  }
  const summary = summarize(manifest, records, evaluation);
  invariant(digest(await json(join(directory, "summary.json"))) === digest(summary), "Published summary differs from records");
  return { manifest, lock, cases, records, evaluation, summary };
}

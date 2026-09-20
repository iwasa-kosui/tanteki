import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { root, hash, callModel, disabledSkills, pool } from "./benchmark.mjs";

const read = (p) => readFile(p, "utf8");
const json = async (p) => JSON.parse(await read(p));
const save = (p, value) => writeFile(p, JSON.stringify(value, null, 2) + "\n");
const exists = async (p) => { try { await access(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const normalize = (body) => body.replace(/\r\n/g, "\n").replace(/\n+$/, "");

export function reviewPrompt(input) {
  // An allowlist is intentional: never serialize a case, record or old judgment.
  return `文書としての批判的レビューを行ってください。\n\n文書の用途:\n${input.document_kind}\n\n読み手の視点:\n${input.review_perspective}\n\n原依頼・原資料:\n${input.request}\n\n成果物本文:\n${input.body}`;
}

export function buildReviewPlan(cases, records, profiles) {
  const entries = [], inputs = new Map(), ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate source record ${record.id}`);
    ids.add(record.id);
    const c = cases.find((c) => c.id === record.caseId), profile = profiles[record.caseId];
    if (!c || !profile || !/^[a-z0-9-]+$/.test(c.id) || !["with_skill", "without_skill"].includes(record.arm) || !Number.isInteger(record.repeat) || record.repeat < 1 || record.id !== `${c.id}.${record.repeat}.${record.arm}`) throw new Error("Invalid review source record/profile");
    const body = record.attempts.at(-1)?.response?.body;
    if (typeof body !== "string" || !body.trim()) throw new Error(`Missing final body ${record.id}`);
    const input = { document_kind: profile.document_kind, review_perspective: profile.review_perspective, request: c.prompt, body: normalize(body) };
    const inputHash = hash(reviewPrompt(input)), reviewId = `r-${inputHash}`;
    if (!inputs.has(reviewId)) inputs.set(reviewId, { reviewId, inputHash, ...input });
    entries.push({ recordId: record.id, caseId: c.id, title: c.title, repeat: record.repeat, arm: record.arm, reviewId, bodyHash: hash(body) });
  }
  return { entries, inputs: [...inputs.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId)) };
}

function schemaErrors(value, schema, path = "response") {
  const errors = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    for (const key of schema.required) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) errors.push(`${path}.${key}: unknown property`);
      else errors.push(...schemaErrors(value[key], schema.properties[key], `${path}.${key}`));
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    value.forEach((v, i) => errors.push(...schemaErrors(v, schema.items, `${path}[${i}]`)));
  } else if (typeof value !== schema.type) errors.push(`${path}: expected ${schema.type}`);
  else if (schema.type === "string" && schema.minLength && !value.trim()) errors.push(`${path}: empty`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum value`);
  return errors;
}

export function validateReview(value, input, schema) {
  const errors = schemaErrors(value, schema);
  if (errors.length) throw new Error(errors.join("\n"));
  for (const [i, f] of value.findings.entries()) {
    if (f.kind !== "omission" && !f.excerpt.trim()) errors.push(`findings[${i}].excerpt: required`);
    if (f.basis === "source" && !f.source_excerpt.trim()) errors.push(`findings[${i}].source_excerpt: required`);
    if (f.excerpt && !input.body.includes(f.excerpt)) errors.push(`findings[${i}].excerpt: not an exact substring of body`);
    if (f.source_excerpt && !input.request.includes(f.source_excerpt)) errors.push(`findings[${i}].source_excerpt: not an exact substring of request`);
  }
  for (const [i, g] of value.source_gaps.entries()) if (g.excerpt && !input.body.includes(g.excerpt)) errors.push(`source_gaps[${i}].excerpt: not an exact substring of body`);
  const hasMajor = value.findings.some((f) => f.severity !== "minor");
  if (hasMajor !== (value.status === "revision_needed")) errors.push("status: revision_needed must correspond to at least one major/critical finding");
  const blocked = value.source_gaps.some((g) => g.blocks_use);
  if (!hasMajor && blocked !== (value.status === "source_limited")) errors.push("status: blocking source gaps without a major/critical defect must be source_limited");
  if (value.status === "source_limited" && value.source_gaps.some((g) => g.blocks_use && !g.handled_appropriately)) errors.push("status: inadequately handled blocking gaps require an explicit major/critical finding");
  if (errors.length) throw new Error(errors.join("\n"));
  return value;
}

function options(argv) {
  const [command, ...args] = argv;
  const o = { command, effort: "high", jobs: 2, timeout: 300, resume: false, dryRun: false };
  const fields = { "--out": "out", "--source": "source", "--model": "model", "--effort": "effort", "--jobs": "jobs", "--timeout": "timeout" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") o.resume = true;
    else if (args[i] === "--dry-run") o.dryRun = true;
    else if (fields[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) o[fields[args[i]]] = args[++i];
    else throw new Error(`Unknown/missing option: ${args[i]}`);
  }
  if (!["run", "report"].includes(command) || !o.out || (command === "run" && (!o.source || !o.model))) throw new Error("Usage: document-review.mjs run --source EVALUATION --out NEW_DIR --model MODEL [--effort high --jobs 2 --resume --dry-run] | report --out DIR");
  for (const field of ["jobs", "timeout"]) { o[field] = Number(o[field]); if (!Number.isInteger(o[field]) || o[field] < 1) throw new Error(`Invalid ${field}`); }
  if (o.jobs > 8) throw new Error("Maximum jobs is 8");
  o.out = resolve(o.out);
  if (o.source) o.source = resolve(o.source);
  return o;
}

async function run(o) {
  const sourceManifestText = await read(join(o.source, "manifest.json"));
  const sourceManifest = JSON.parse(sourceManifestText);
  const casesText = await read(join(o.source, "cases.json")), cases = JSON.parse(casesText);
  const profiles = await json(join(root, "benchmarks/document-review-profiles.json"));
  const schema = await json(join(root, "benchmarks/document-review.schema.json"));
  const sourceHashes = { "manifest.json": hash(sourceManifestText), "cases.json": hash(casesText) }, records = [];
  for (const p of sourceManifest.plan) {
    const path = `records/${p.id}.json`, body = await read(join(o.source, path)), r = JSON.parse(body);
    if (r.id !== p.id || r.caseId !== p.caseId || r.arm !== p.arm || r.repeat !== p.repeat) throw new Error(`Source plan mismatch: ${p.id}`);
    sourceHashes[path] = hash(body);
    records.push(r);
  }
  const { entries, inputs } = buildReviewPlan(cases, records, profiles);
  const harnessHashes = {};
  for (const p of ["benchmarks/document-review.mjs", "benchmarks/document-review-instructions.txt", "benchmarks/document-review-profiles.json", "benchmarks/document-review.schema.json", "benchmarks/benchmark.mjs"]) harnessHashes[p] = hash(await read(join(root, p)));
  const specification = { version: 1, model: o.model, effort: o.effort, timeout: o.timeout, maxValidationRepairs: 1, sourceEvaluation: { fingerprint: sourceManifest.fingerprint, skillRevision: sourceManifest.skillRevision }, sourceHashes, harnessHashes, entries, inputHashes: inputs.map(({ reviewId, inputHash }) => ({ reviewId, inputHash })) };
  const fingerprint = hash(JSON.stringify(specification));
  if (o.dryRun) { console.log(JSON.stringify({ fingerprint, records: entries.length, uniqueInputs: inputs.length, model: o.model, effort: o.effort }, null, 2)); return; }
  const runtime = { codexVersion: execFileSync(process.env.CODEX_BIN || "codex", ["--version"], { encoding: "utf8" }).trim(), nodeVersion: process.version };
  if (o.resume) {
    const previous = await json(join(o.out, "manifest.json"));
    if (previous.fingerprint !== fingerprint) throw new Error("Resume rejected: source bodies, review instructions, model or harness changed");
    if (JSON.stringify(previous.runtime) !== JSON.stringify(runtime)) throw new Error("Resume rejected: CLI/Node version changed");
  } else {
    await mkdir(dirname(o.out), { recursive: true });
    await mkdir(o.out); // Never replace an existing run or the author evidence.
    await save(join(o.out, "manifest.json"), { createdAt: new Date().toISOString(), fingerprint, ...specification, runtime, jobs: o.jobs, isolation: { verified: false, requested: "fresh ephemeral session; no tools, user/project instructions, native skills, plugins or history", promptExcludes: "old judgments, candidate notes, arm names and skill text", evidence: "CLI flags and tool events only; effective model input has not been verified" } });
    for (const name of ["inputs", "reviews", "calls", "artifacts"]) await mkdir(join(o.out, name));
    await save(join(o.out, "schema.json"), schema);
    await writeFile(join(o.out, "instructions.txt"), await read(join(root, "benchmarks/document-review-instructions.txt")));
    for (const input of inputs) await save(join(o.out, "inputs", `${input.reviewId}.json`), input);
    for (const r of records) await writeFile(join(o.out, "artifacts", `${r.id}.md`), r.attempts.at(-1).response.body);
  }
  // Resume must use the exact frozen reviewer inputs and readable source copies.
  for (const input of inputs) {
    const saved = await json(join(o.out, "inputs", `${input.reviewId}.json`));
    if (hash(reviewPrompt(saved)) !== input.inputHash) throw new Error("Frozen review input changed");
  }
  if (hash(await read(join(o.out, "instructions.txt"))) !== harnessHashes["benchmarks/document-review-instructions.txt"] || hash(await read(join(o.out, "schema.json"))) !== hash(JSON.stringify(schema, null, 2) + "\n")) throw new Error("Frozen reviewer instructions/schema changed");
  for (const entry of entries) if (hash(await read(join(o.out, "artifacts", `${entry.recordId}.md`))) !== entry.bodyHash) throw new Error("Frozen artifact changed");
  const skills = await disabledSkills();
  let completed = 0;
  await pool(inputs, o.jobs, async (input) => {
    const destination = join(o.out, "reviews", `${input.reviewId}.json`);
    if (await exists(destination)) {
      const saved = await json(destination);
      if (saved.inputHash !== input.inputHash) throw new Error("Saved review belongs to different input");
      validateReview(saved.attempts.at(-1).response, input, schema);
      completed++;
      return;
    }
    const attempts = [];
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await callModel({ model: o.model, effort: o.effort, prompt: reviewPrompt(input) + correction, schema, instructionFile: join(o.out, "instructions.txt"), prefix: join(o.out, "calls", `${input.reviewId}.${attempt + 1}`), timeout: o.timeout, skills });
      try { validateReview(result.response, input, schema); } catch (error) {
        attempts.push({ ...result, validationErrors: error.message });
        await save(join(o.out, "calls", `${input.reviewId}.invalid.json`), attempts);
        if (attempt === 1) throw error;
        correction = `\n\n前回のレビューは、引用の完全一致または出力構造の検証に失敗しました。次のエラーだけを修正し、内容の評価を点数や他候補へ合わせないでください。原文に根拠がない指摘は撤回してください。\n${error.message}\n前回の出力:\n${JSON.stringify(result.response)}`;
        continue;
      }
      attempts.push({ ...result, validationErrors: null });
      await save(destination, { reviewId: input.reviewId, inputHash: input.inputHash, attempts });
      console.log(`reviewed ${++completed}/${inputs.length} ${input.reviewId.slice(0, 14)}: ${result.response.status}, ${result.response.findings.length} finding(s)`);
      return;
    }
  });
  console.log(`Reviewed ${entries.length} outputs with ${inputs.length} unique inputs. Run report to render the saved reviews.`);
}

export async function main(argv) {
  const o = options(argv);
  if (o.command === "report") {
    const { renderDocumentReviews } = await import("./document-review-report.mjs");
    console.log(JSON.stringify(await renderDocumentReviews(o.out), null, 2));
  } else await run(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });

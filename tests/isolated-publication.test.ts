import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublication } from "../benchmarks/isolated/publication.ts";
import { arms, type BenchmarkCase } from "../benchmarks/isolated/benchmark-case.ts";
import type { Execution, ValidExecution } from "../benchmarks/isolated/execution.ts";
import { Manifest } from "../benchmarks/isolated/manifest.ts";
import { Evaluation } from "../benchmarks/isolated/evaluation.ts";
import { checkContainer, comparableRequest, configText, digest, inventory, protocol, publicJob, sha256, skillPath } from "../benchmarks/isolated/protocol.ts";
import { writeReport } from "../benchmarks/isolated/report.ts";
import { build } from "../scripts/build-isolated-site.mjs";

const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
async function fixture(root: string) {
  const out = join(root, "benchmarks/results/test-isolated");
  await mkdir(join(out, "records"), { recursive: true });
  await mkdir(join(out, "documents"));
  const c = { id: "example", title: "検証用", prompt: "依頼\n原資料", type: "stock", documentType: "ガイド", criteria: { facts: "事実", grounding: "根拠", role: "役割", clarity: "明確さ", economy: "簡潔さ" } } as const satisfies BenchmarkCase;
  const settings = { model: "test-model", effort: "low", repeats: 1, seed: "fixed", timeout: 60, maxCalls: 24 } as const;
  const emptyInventory = { files: {}, digest: digest({}) };
  const lockUnsigned = { protocol, createdAt: "2026-09-20T00:00:00Z", codexVersion: "0.155.1", runtimeImage: `sha256:${"1".repeat(64)}`, bundleImage: `sha256:${"2".repeat(64)}`, runtimeSources: {}, skillSource: emptyInventory, bundleInventory: emptyInventory, sourceRevision: "a".repeat(40) };
  const lock = { ...lockUnsigned, fingerprint: digest(lockUnsigned) };
  const records: ValidExecution[] = [];
  for (const arm of arms) {
    const withSkill = arm === "with_skill";
    const id = `example.1.${arm}`;
    const dir = join(out, "input-audits", id);
    await mkdir(dir, { recursive: true });
    const job = publicJob(c, settings);
    const mounts = [{ source: "/temporary/input", target: "/input" }, ...(withSkill ? [{ source: "/temporary/bundle", target: "/opt/skill" }] : [])];
    const container = { Id: `container-${arm}`, Image: lock.runtimeImage, Config: { Hostname: "benchmark", WorkingDir: "/workspace", Env: ["LANG=C.UTF-8"] }, Mounts: mounts.map((m) => ({ Type: "bind", Source: m.source, Destination: m.target, RW: false })), HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, SecurityOpt: ["no-new-privileges"], CapDrop: ["ALL"], CapAdd: ["SETUID", "SETGID"], PidMode: "", IpcMode: "private", Memory: 2147483648, NanoCpus: 2000000000, PidsLimit: 256, Tmpfs: { "/home/agent": "", "/tmp": "", "/workspace": "" } } };
    const preflight = { protocol, promptHash: sha256(c.prompt), configTextHash: sha256(configText(job)), privateHomeEmpty: true, workspaceEmpty: true, skillDigest: withSkill ? emptyInventory.digest : null, initialized: {}, config: { config: { mcp_servers: {} } }, catalog: { data: [{ cwd: "/workspace", errors: [], skills: withSkill ? [{ name: "tanteki", path: `${skillPath}/SKILL.md`, scope: "user", enabled: true }] : [] }] }, thread: { model: settings.model, modelProvider: "benchmark", cwd: "/workspace", instructionSources: [], thread: { id } } };
    const request = { model: settings.model, store: false, reasoning: { effort: settings.effort }, input: [{ type: "message", role: "developer", content: withSkill ? [{ type: "input_text", text: "<skills_instructions>\n- tanteki: test\n</skills_instructions>" }] : [] }, { type: "message", role: "user", content: [{ type: "input_text", text: c.prompt }] }] };
    const response = { body: "担当者は原資料を確認します。\n", notes: "検証用データ。品質の実測ではありません。" };
    const record = { id, caseId: c.id, repeat: 1, arm, status: "valid", promptHash: sha256(c.prompt), jobHash: digest(job), containerId: container.Id, environmentHash: digest({ runtime: digest({ container: digest(checkContainer(container, lock.runtimeImage, mounts)), config: preflight.config.config }), request: comparableRequest(request, job, withSkill) }), response, responseHash: digest(response), usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }, modelCalls: 1, providerResponses: 1, elapsedMs: 10, observations: { skillTextSeen: withSkill, lintCommandSeen: false } } as const satisfies Execution;
    records.push(record);
    await save(join(out, "records", `${id}.json`), record);
    await writeFile(join(out, "documents", `${id}.md`), response.body);
    await save(join(dir, "container.json"), container);
    await save(join(dir, "preflight.json"), preflight);
    await save(join(dir, "request-1.json"), request);
  }
  const evidence = await inventory(join(out, "input-audits"));
  const unsigned = { protocol, createdAt: lock.createdAt, completedAt: lock.createdAt, runtimeLockHash: digest(lock), casesHash: digest([c]), settings, plan: records.map(({ id, caseId, repeat, arm }) => ({ id, caseId, repeat, arm })), sealed: true, evidence: { records: (await inventory(join(out, "records"))).digest, calls: evidence.digest } };
  const manifest = Manifest.schema.parse({ ...unsigned, fingerprint: digest(unsigned) });
  const candidate = Object.fromEntries(Object.keys(c.criteria).map((key) => [key, { pass: true, evidence: "検証用の判定。" }]));
  const evaluationUnsigned = { protocol, runFingerprint: manifest.fingerprint, model: "test-judge", effort: "low", instructionsHash: sha256("test instructions"), createdAt: lock.createdAt, lint: Object.fromEntries(records.map((r) => [r.id, { bodyHash: sha256(r.response.body), lint: [] }])), pairs: { "example.1": { status: "valid", mapping: { A: "with_skill", B: "without_skill" }, response: { A: candidate, B: candidate } } }, sealed: true };
  const evaluation = Evaluation.schema.parse({ ...evaluationUnsigned, fingerprint: digest(evaluationUnsigned) });
  await save(join(out, "manifest.json"), manifest);
  await save(join(out, "runtime-lock.json"), lock);
  await save(join(out, "cases.json"), [c]);
  await save(join(out, "evaluation.json"), evaluation);
  await save(join(out, "evidence-inventory.json"), evidence);
  await writeFile(join(out, "judge-instructions.txt"), "test instructions");
  await writeReport({ out, manifest, records, cases: [c], evaluation });
  return out;
}

test("publication verifies archived evidence without local Docker or today's harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "tanteki-isolated-publication-"));
  try {
    const out = await fixture(root);
    const data = await readPublication(out);
    assert.equal(data.summary.gradedPairs, 1);
    for (const [path, error] of [
      ["documents/example.1.with_skill.md", /differs from original/],
      ["input-audits/example.1.with_skill/request-1.json", /audit changed/],
      ["records/example.1.with_skill.json", /records changed/],
    ] as const) {
      const target = join(out, path), original = await readFile(target, "utf8");
      await writeFile(target, original + "\n");
      await assert.rejects(readPublication(out), error);
      await writeFile(target, original);
    }
    await save(join(out, "summary.json"), { ...data.summary, gradedPairs: 20 });
    await assert.rejects(readPublication(out), /summary differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("site renders isolated outputs and paired metrics, preserving links and rejecting missing quotations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tanteki-isolated-site-"));
  try {
    await fixture(root);
    await cp(new URL("../docs/", import.meta.url), join(root, "docs"), { recursive: true });
    await save(join(root, "docs/benchmark.json"), { run: "benchmarks/results/test-isolated" });
    const note = { text: "担当者", note: "動作を行う人を示しています。" };
    const example = { id: "example", tab: "ガイド", title: "動作の主体を比べる", scope: "全文 · 反復1", before: { highlight: [note] }, after: { highlight: [note] }, insight: "両条件とも担当者を明記しています。" };
    await save(join(root, "docs/examples.json"), [example]);
    await build(root);
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    assert.match(html, /test-model/);
    assert.match(html, /有効ペアは1\/1組/);
    assert.match(html, /5\/5/);
    assert.match(html, /results\/documents\/example\.1\.with_skill\.md/);
    assert.doesNotMatch(html, /用途を満たすか|最大1回修正|<!-- (EXAMPLES|RUN_CONTEXT)/);
    for (const [, target] of html.matchAll(/(?:href|cite)="(\.\/[^"#]*)[^"]*"/g)) await access(join(root, "dist", target));
    const comparison = await readFile(join(root, "dist/evaluation.html"), "utf8");
    assert.match(comparison, /id="example.1"/);
    assert.match(comparison, /tanteki の紹介へ戻る/);
    await save(join(root, "docs/examples.json"), [{ ...example, before: { highlight: [{ ...note, text: "存在しない引用" }] } }]);
    await assert.rejects(build(root), /Missing highlight/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

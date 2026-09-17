import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { root, dimensions, arms, validateCases, makePlan, skillContext, authorPrompt, validateAuthor, validateJudge, parseEvents, codexArgs, measure, aggregate, hash, verifySourceSnapshot } from "../benchmarks/benchmark.mjs";

const cases = JSON.parse(await readFile(join(root, "benchmarks/cases.json"), "utf8"));
const files = Object.fromEntries(await Promise.all(["SKILL.md", "references/document-types.md", "references/types/strategy.md", "references/types/research.md", "references/types/requirements.md", "references/types/design.md", "references/types/qa-release.md", "references/types/operations.md", "references/types/knowledge.md", "references/japanese.md", "references/structure.md", "references/delegation.md"].map(async (name) => [name, await readFile(join(root, name), "utf8")])));

test("pinned source validation rejects stale skill or lint code before a model call", () => {
  const source = { "SKILL.md": "skill", "rules/table-cell-length.mjs": "rule" };
  const hashes = { ...Object.fromEntries(Object.entries(source).map(([name, content]) => [name, hash(content)])), "benchmarks/benchmark.mjs": hash("local harness") };
  verifySourceSnapshot(hashes, (name) => Buffer.from(source[name]));
  assert.throws(() => verifySourceSnapshot(hashes, (name) => name === "SKILL.md" ? "old skill" : source[name]), /SKILL.md/);
  assert.throws(() => verifySourceSnapshot(hashes, (name) => name.startsWith("rules/") ? "old rule" : source[name]), /table-cell-length/);
});

test("all cases have complete private rubrics and resolvable skill context", () => {
  validateCases(cases);
  assert.equal(cases.length, 10);
  for (const c of cases) {
    const context = skillContext(c, files);
    const baseline = authorPrompt(c, "without_skill", context);
    const treatment = authorPrompt(c, "with_skill", context);
    assert.ok(baseline.includes(c.prompt));
    assert.ok(treatment.includes(c.prompt));
    assert.ok(!baseline.includes(files["SKILL.md"]));
    assert.ok(treatment.includes(files["SKILL.md"]));
    for (const criterion of Object.values(c.criteria)) {
      assert.ok(!baseline.includes(criterion), `${c.id} baseline rubric leakage`);
      assert.ok(!treatment.includes(criterion), `${c.id} treatment rubric leakage`);
    }
  }
  assert.throws(() => validateCases([cases[0], cases[0]]), /duplicate/);
});

test("seeded schedule contains each pair exactly once per repeat and balances first arm", () => {
  const plan = makePlan(cases, 2, "seed");
  assert.deepEqual(plan, makePlan(cases, 2, "seed"));
  assert.notDeepEqual(plan, makePlan(cases, 2, "different"));
  assert.equal(new Set(plan.map((p) => p.id)).size, 40);
  assert.equal(plan.filter((p) => p.arm === "with_skill").length, 20);
  assert.equal(plan.filter((p, i) => i % 2 === 0 && p.arm === "with_skill").length, 10);
  for (let i = 0; i < plan.length; i += 2) {
    assert.equal(plan[i].caseId, plan[i + 1].caseId);
    assert.equal(plan[i].repeat, plan[i + 1].repeat);
    assert.notEqual(plan[i].arm, plan[i + 1].arm);
  }
});

test("both arms receive the same revision evidence without a hidden rubric", () => {
  const previous = { body: "本文", notes: "" }, feedback = [{ ruleId: "sentence-length", line: 1, message: "短くする" }];
  for (const arm of arms) {
    const prompt = authorPrompt(cases[0], arm, "SKILL-CONTEXT", previous, feedback);
    assert.ok(prompt.includes(JSON.stringify(previous)));
    assert.ok(prompt.includes(JSON.stringify(feedback)));
    assert.equal(prompt.includes("SKILL-CONTEXT"), arm === "with_skill");
  }
});

test("invalid generations, incomplete turns, and tool use cannot become successes", () => {
  assert.throws(() => validateAuthor({ body: "", notes: "" }));
  assert.throws(() => validateAuthor({ body: "本文" }));
  assert.throws(() => validateJudge({ A: {}, B: {} }));
  const completed = { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } };
  const message = { type: "item.completed", item: { type: "agent_message", text: "本文" } };
  assert.deepEqual(parseEvents([message, completed].map(JSON.stringify).join("\n")), completed.usage);
  assert.throws(() => parseEvents(JSON.stringify(message)), /Incomplete/);
  assert.throws(() => parseEvents([completed, { type: "item.started", item: { type: "command_execution" } }].map(JSON.stringify).join("\n")), /Tool activity/);
  assert.throws(() => parseEvents([completed, { type: "error", message: "failure" }].map(JSON.stringify).join("\n")), /failed/);
});

test("CLI disables user instructions, native skills, tools and session persistence for both arms", () => {
  const args = codexArgs({ model: "test", effort: "low", workspace: "/tmp/empty", instructions: "/tmp/instructions", schema: "/tmp/schema", output: "/tmp/output", skills: ["/tmp/a skill"] });
  for (const flag of ["--ignore-user-config", "--ephemeral", "project_doc_max_bytes=0", "features.plugins=false", "features.shell_tool=false", "features.multi_agent=false", 'web_search="disabled"', 'skills.config=[{path="/tmp/a skill",enabled=false}]']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(args.at(-1), "-");
});

test("offline measurement preserves flow tracking and catches stock tracking and edit drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nihongo-benchmark-test-"));
  try {
    const response = { body: "PR #106 はレビュー待ち。", notes: "" };
    const stock = await measure({ type: "stock" }, response, join(dir, "stock.md"));
    const flow = await measure({ type: "flow" }, response, join(dir, "flow.md"));
    assert.ok(stock.lint.some((m) => m.ruleId === "stock-boundary"));
    assert.ok(!flow.lint.some((m) => m.ruleId === "stock-boundary"));
    const c = cases.find((c) => c.id === "surgical-edit");
    assert.equal((await measure(c, { body: c.expectedBody + "\n" }, join(dir, "edit.md"))).exactEdit, true);
    assert.equal((await measure(c, { body: c.expectedBody.replace("7%", "5%") }, join(dir, "drift.md"))).exactEdit, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("aggregate counts final semantic quality separately from initial lint and all generation costs", () => {
  const attempt = (lint, characters = 100) => ({ metrics: { lint, characters }, usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 }, elapsedMs: 20 });
  const records = [{ id: "a", arm: "without_skill", attempts: [attempt([{}]), attempt([])] }, { id: "b", arm: "with_skill", attempts: [attempt([], 50)] }];
  const verdicts = Object.fromEntries(["a", "b"].map((id) => [id, Object.fromEntries(dimensions.map((d) => [d, { pass: id === "b" || d !== "economy" }]))]));
  const summary = aggregate(records, verdicts);
  assert.equal(summary.without_skill.rubricPasses, 4);
  assert.equal(summary.with_skill.rubricPasses, 5);
  assert.equal(summary.without_skill.initialLintPass, 0);
  assert.equal(summary.without_skill.finalLintPass, 1);
  assert.equal(summary.without_skill.inputTokens, 2000);
  assert.equal(summary.without_skill.calls, 2);
  assert.throws(() => aggregate(records.slice(0, 1), verdicts), /Missing arm/);
});

test("dry-run validates every case and never invokes a model", () => {
  const stdout = execFileSync(process.execPath, [join(root, "benchmarks/benchmark.mjs"), "run", "--out", "/tmp/not-created-nihongo-dry", "--model", "not-a-model", "--judge-model", "not-a-judge", "--dry-run"], { encoding: "utf8", env: { ...process.env, CODEX_BIN: "/does/not/exist" } });
  const plan = JSON.parse(stdout);
  assert.equal(plan.plan.length, 40);
  assert.ok(plan.sourceHashes["rules/lib/japanese-rule.mjs"], "Nested lint helpers must be fingerprinted for safe resume");
});

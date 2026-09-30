import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintFiles, readSkillConfig } from "../scripts/lint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "scripts/lint.mjs");

function config(overrides = {}) {
  return {
    rules: {
      "preset-japanese": false,
      "no-ai-jargon": false,
      "no-opaque-compound": false,
      "no-vague-action": false,
      "stock-boundary": false,
      "table-cell-length": false,
      ...overrides
    }
  };
}

async function withFile(text, callback, name = "input.md") {
  const dir = await mkdtemp(join(tmpdir(), "nihongo-lint-"));
  const file = join(dir, name);
  await writeFile(file, text);
  try {
    return await callback({ dir, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function messages(type, text, lintConfig, name) {
  return withFile(text, async ({ file }) => (await lintFiles(type, [file], lintConfig))[0].messages, name);
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("no-ai-jargon reports every visible occurrence with exact positions", async () => {
  const found = await messages("flow", "レバレッジとレバレッジ。\n[レバレッジ](https://example.test/レバレッジ)\n`レバレッジ`\n> レバレッジ\n> > レバレッジ\nhttps://example.test/レバレッジ\n", config({ "no-ai-jargon": { allow: [] } }));
  const jargon = found.filter((message) => message.ruleId === "no-ai-jargon");
  assert.deepEqual(jargon.map(({ line, column }) => [line, column]), [[1, 1], [1, 7], [2, 2]]);
});

test("no-ai-jargon reports known lexical and predicate patterns with concrete alternatives", async () => {
  const found = await messages("flow", "ホリスティックに検討し、プロアクティブに進める。ロバストな実装で価値を解き放つ。ゲームチェンジャーとしてアラインメントを取る。", config({ "no-ai-jargon": { allow: [] } }));
  const jargon = found.filter((message) => message.ruleId === "no-ai-jargon");
  assert.equal(jargon.length, 6);
  assert.ok(jargon.every((message) => message.message.includes("対象と動作を具体化")));
});

test("all prose rules exempt only the matched range of an allowed expression", async () => {
  const cases = [
    ["no-ai-jargon", "可観測性", "観測"],
    ["no-ai-jargon", "レバレッジ比率", "レバレッジ"],
    ["no-ai-jargon", "ロバストな推定", "ロバストな"],
    ["no-opaque-compound", "価値創出最大化基盤という製品名", "価値創出最大化基盤"],
    ["no-vague-action", "適切に対応するという原文", "適切に対応する"]
  ];
  for (const [rule, allowed, candidate] of cases) {
    const text = `${allowed}。${candidate}。${allowed}。${candidate}。`;
    const found = await messages("flow", text, config({ [rule]: { allow: [allowed] } }));
    assert.deepEqual(found.map(({ line, column }) => [line, column]), [
      [1, allowed.length + 2],
      [1, 2 * allowed.length + candidate.length + 4]
    ], rule);
  }
});

test("domain terminology in the default configuration remains lintable", async () => {
  const text = "可観測性を評価する。\nレバレッジ比率を計算する。\nロバストな推定を用いる。\n";
  assert.deepEqual(await messages("flow", text, readSkillConfig()), []);
});

test("ambiguous action patterns cover varied wording without flagging concrete actions", async () => {
  const text = "適宜調整します。\n状況に応じて対処した。\nそれを推進する。\n慎重に評価する。\n";
  const found = await messages("flow", text, config({ "no-vague-action": true }));
  assert.deepEqual(found.map(({ line, column }) => [line, column]), [[1, 1], [2, 1], [3, 1], [4, 1]]);
  assert.deepEqual(await messages("flow", "当番が失敗率を確認する。5%を超えたら配信を停止する。", config({ "no-vague-action": true })), []);
});

test("invalid empty or non-string allow entries fail instead of suppressing checks", async () => {
  for (const allow of [[""], [1], "all"]) {
    await assert.rejects(() => messages("flow", "レバレッジ", config({ "no-ai-jargon": { allow } })), /allow/);
  }
});

test("no-opaque-compound reports abstract noun combinations and supports allow", async () => {
  const visible = await messages("flow", "価値創出最大化基盤と意思決定高度化レイヤー。\n[価値創出最大化基盤](https://example.test/価値創出最大化基盤)\n`価値創出最大化基盤`\n> 価値創出最大化基盤\nhttps://example.test/価値創出最大化基盤\n価値提供と課題解決は具体的に書く。\n", config({ "no-opaque-compound": { allow: [] } }));
  assert.deepEqual(visible.filter((message) => message.ruleId === "no-opaque-compound").map(({ line, column }) => [line, column]), [[1, 1], [1, 11], [2, 2]]);
  const allowed = await messages("flow", "価値創出最大化基盤", config({ "no-opaque-compound": { allow: ["価値創出最大化基盤"] } }));
  assert.equal(allowed.length, 0);
});

test("no-vague-action catches polite conjugations, repeated hits, and excludes code, quotes, and URLs", async () => {
  const found = await messages("flow", "適切に対応します。必要に応じて対応する。これを実施した。\n[適切に対応する](https://example.test/適切に対応する)\n`適切に対応する`\n> 適切に対応する\nhttps://example.test/適切に対応する\n", config({ "no-vague-action": { allow: [] } }));
  const vague = found.filter((message) => message.ruleId === "no-vague-action");
  assert.deepEqual(vague.map(({ line, column }) => [line, column]), [[1, 1], [1, 10], [1, 21], [2, 2]]);
  const allowed = await messages("flow", "適切に対応する", config({ "no-vague-action": { allow: ["適切に対応する"] } }));
  assert.equal(allowed.length, 0);
});

test("stock boundary reports headings, checkboxes, PRs, and tracker links", async () => {
  const text = "## 進捗\n- [ ] 実装\nPR #12\n[PR](https://github.com/acme/repo/pull/3)\nhttps://jira.example.test/browse/DEV-3\n";
  const found = await messages("stock", text, config({ "stock-boundary": true }));
  const stock = found.filter((message) => message.ruleId === "stock-boundary");
  assert.deepEqual(stock.map(({ line, column }) => [line, column]), [[1, 1], [2, 1], [3, 1], [4, 6], [5, 1]]);
  assert.ok(stock.every((message) => message.message.includes("作業追跡はチケットまたは進捗文書へ移して")));
});

test("stock boundary accepts document IDs, ADR business states, and dates", async () => {
  const accepted = "ADR-001\nPRD-001\nRFC-9110\nREQ-001\nISO-8601\n状態：処理中\n状態: 完了\n状態: 採用\n状態: 廃止\n状態: 置換\n2026-09-05\n";
  const found = await messages("adr", accepted, config({ "stock-boundary": true }));
  assert.equal(found.length, 0);
});

test("stock checks inline code and links but excludes fenced and nested block quotes", async () => {
  const found = await messages("design-doc", "`PR #12` [ticket](https://github.com/a/b/issues/9)\n```md\nPR #13\n```\n> PR #14\n> > DEV-3\n> ## 進捗\n> - [ ] 引用内の作業\n", config({ "stock-boundary": true }));
  const stock = found.filter((message) => message.ruleId === "stock-boundary");
  assert.deepEqual(stock.map(({ line, column }) => [line, column]), [[1, 2], [1, 19]]);
});

test("stock masking follows AST ranges for variable fences and quoted fences, then resumes scanning", async () => {
  const found = await messages("stock", "````md\n``` literal fence\n````\n> ```md\n> PR #12\n> ```\n> lazy quote PR #13\nPR #14\n", config({ "stock-boundary": true }));
  const stock = found.filter((message) => message.ruleId === "stock-boundary");
  assert.deepEqual(stock.map(({ line, column }) => [line, column]), [[8, 1]]);
});

test("stock finds ATX and Setext progress headings plus enterprise tracker URLs", async () => {
  const found = await messages("stock", "進捗状況\n====\n\n## ステータス詳細\nhttps://git.acme.test/team/repo/pull/42\nhttps://tracker.acme.test/browse/OPS-5\n", config({ "stock-boundary": true }));
  const stock = found.filter((message) => message.ruleId === "stock-boundary");
  assert.deepEqual(stock.map(({ line, column }) => [line, column]), [[1, 1], [4, 1], [5, 1], [6, 1]]);
});

test("stock does not treat Jira-style IDs such as API-123 as work tracking", async () => {
  const found = await messages("stock", "UTF-8\nTLS-1\nAPI-123\nABC-12\n", config({ "stock-boundary": true }));
  assert.deepEqual(found.map(({ line, column }) => [line, column]), []);
});

test("stock rule is limited to stock-bearing profiles", async () => {
  const text = "PR #12\n";
  for (const type of ["flow", "record"]) {
    const found = await messages(type, text, config({ "stock-boundary": true }));
    assert.equal(found.length, 0, type);
  }
  for (const type of ["design-doc", "prd", "adr", "rfc", "stock"]) {
    const found = await messages(type, text, config({ "stock-boundary": true }));
    assert.equal(found.filter((message) => message.ruleId === "stock-boundary").length, 1, type);
  }
});

test("stock distinguishes HTTP and decision status from work progress", async () => {
  const accepted = "## HTTPステータス\nHTTPステータス: 200\n## ステータスコード\nステータス: 採用\n状態: 完了\n";
  assert.deepEqual(await messages("stock", accepted, config({ "stock-boundary": true })), []);
  const found = await messages("stock", "プルリクエスト#42\n進捗状況: 80%\nステータス: 実装中\n", config({ "stock-boundary": true }));
  assert.deepEqual(found.map(({ line, column }) => [line, column]), [[1, 1], [2, 1], [3, 1]]);
});

test("CLI uses the skill-root config and caller-relative paths despite a hostile external config", async () => {
  await withFile("レバレッジ", async ({ dir, file }) => {
    await writeFile(join(dir, ".textlintrc.json"), JSON.stringify({ rules: { "no-ai-jargon": false } }));
    const result = runCli(["--type", "flow", "--format", "json", "input.md"], dir);
    assert.equal(result.status, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json[0].messages[0].ruleId, "no-ai-jargon");
    assert.equal(json[0].filePath, await import("node:fs/promises").then(({ realpath }) => realpath(file)));
    const pretty = runCli(["--type", "flow", "input.md"], dir);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stdout, /直訳調/);
  });
});

test("CLI rejects invalid invocations with exit status 2", async () => {
  await withFile("ok", async ({ dir, file }) => {
    await writeFile(join(dir, "input.txt"), "ok");
    for (const args of [
      [],
      ["--type", "unknown", file],
      ["--type", "flow", "--wat", file],
      ["--type", "flow"],
      ["--type", "flow", join(dir, "missing.md")],
      ["--type", "flow", dir],
      ["--type", "flow", join(dir, "input.txt")],
      ["--type", "flow", "--format", "bad", file]
    ]) {
      const result = runCli(args, dir);
      assert.equal(result.status, 2, args.join(" "));
    }
  });
});

test("linting never rewrites its source document", async () => {
  await withFile("レバレッジ\n", async ({ file }) => {
    const before = await readFile(file, "utf8");
    await lintFiles("flow", [file]);
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("preset-japanese options in the skill config override preset defaults", async () => {
  const baseline = config({ "preset-japanese": true });
  const overridden = config({ "preset-japanese": { "sentence-length": { max: 10 } } });
  const text = "あいうえおかきくけこさしすせそたちつてと。";
  assert.equal((await messages("flow", text, baseline)).filter((message) => message.ruleId === "sentence-length").length, 0);
  assert.equal((await messages("flow", text, overridden)).filter((message) => message.ruleId === "sentence-length").length, 1);
});

test("table cell length accepts 60 characters and reports every cell at 61 or more, including headers", async () => {
  const text = `| ${"あ".repeat(60)} | ${"い".repeat(61)} |\n| --- | --- |\n| ${"う".repeat(61)} | ${"え".repeat(62)} |\n| ${"お".repeat(60)} | 短い値 |\n`;
  const found = await messages("flow", text, config({ "table-cell-length": true }));
  assert.deepEqual(found.map(({ ruleId, line }) => [ruleId, line]), [
    ["table-cell-length", 1], ["table-cell-length", 3], ["table-cell-length", 3]
  ]);
});

test("table cell length counts rendered text across formatting, links, references, and inline code", async () => {
  const short = "あ".repeat(60);
  const long = "い".repeat(61);
  const url = `https://example.test/${"path/".repeat(10)}`;
  const cells = [
    `**${short}**`, `[${short}](${url})`, `\`${short}\``,
    `**${long}**`, `[${long}](${url})`, `\`${long}\``,
    `[${long}][source]`, `<${url}>`, `*${"う".repeat(31)}*${"え".repeat(31)}`
  ];
  const text = `| 説明 |\n| --- |\n${cells.map((cell) => `| ${cell} |`).join("\n")}\n\n[source]: ${url}\n`;
  const found = await messages("flow", text, config({ "table-cell-length": true }));
  assert.deepEqual(found.map(({ line }) => line), [6, 7, 8, 9, 10, 11]);
});

test("table cell length uses graphemes, decodes entities and escapes, and trims only outer whitespace", async () => {
  const cells = [
    "か\u3099".repeat(60), "👩‍💻".repeat(60), "&amp;".repeat(60), "\\|".repeat(60),
    `   ${"あ".repeat(60)}   `,
    "か\u3099".repeat(61), "👩‍💻".repeat(61), "&amp;".repeat(61), "\\|".repeat(61),
    `${"あ".repeat(30)} ${"い".repeat(30)}`
  ];
  const text = `| 説明 |\n| --- |\n${cells.map((cell) => `| ${cell} |`).join("\n")}\n`;
  const found = await messages("flow", text, config({ "table-cell-length": true }));
  assert.deepEqual(found.map(({ line }) => line), [8, 9, 10, 11, 12]);
});

test("line breaks and HTML formatting inside a Markdown cell do not reset its length", async () => {
  const half = "あ".repeat(31);
  const text = `| 説明 |\n| --- |\n| ${half}<br>${half} |\n| <span>${half}</span><b>${half}</b> |\n`;
  const found = await messages("flow", text, config({ "table-cell-length": true }));
  assert.deepEqual(found.map(({ line }) => line), [3, 4]);
});

test("table cell length preserves fenced examples and nested quotations and ignores prose", async () => {
  const table = `| 説明 |\n| --- |\n| ${"あ".repeat(61)} |`;
  const text = `\`\`\`md\n${table}\n\`\`\`\n\n${table.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${table.split("\n").map((line) => `> > ${line}`).join("\n")}\n\n${"あ".repeat(61)}\n\n${table}\n`;
  const found = await messages("flow", text, config({ "table-cell-length": true }));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, text.trimEnd().split("\n").length);
});

test("table cell length is enabled by default in every document profile and the CLI", async () => {
  const table = `| 説明 |\n| --- |\n| ${"あ".repeat(61)} |\n`;
  for (const type of ["design-doc", "prd", "adr", "rfc", "stock", "flow", "record"]) {
    const found = await messages(type, table, readSkillConfig());
    assert.equal(found.filter(({ ruleId }) => ruleId === "table-cell-length").length, 1, type);
  }
  await withFile(table, async ({ dir, file }) => {
    const before = await readFile(file, "utf8");
    const result = runCli(["--type", "flow", "--format", "json", file], dir);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout)[0].messages[0].ruleId, "table-cell-length");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

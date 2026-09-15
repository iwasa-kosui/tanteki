import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("skill packaging detects stale, missing and obsolete resources without rewriting them", () => {
  const root = mkdtempSync(join(tmpdir(), "nihongo-package-"));
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  try {
    for (const file of ["SKILL.md", "LICENSE", ".textlintrc.json", "package-lock.json",
      "agents/openai.yaml", "references/example.md", "rules/lib/example.mjs", "scripts/lint.mjs"]) {
      write(file, `fixture: ${file}\n`);
    }
    write("package.json", JSON.stringify({ name: "test-skill", scripts: { test: "repo-only" }, dependencies: { example: "1.0.0" } }));
    cpSync(fileURLToPath(new URL("../scripts/package-skill.mjs", import.meta.url)), join(root, "scripts/package-skill.mjs"));
    const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/package-skill.mjs"), ...args], { cwd: tmpdir(), encoding: "utf8" });
    const output = "skills/tanteki/";

    assert.equal(run("--check").status, 1);
    assert.equal(run().status, 0);
    assert.equal(run("--check").status, 0);
    const manifest = JSON.parse(readFileSync(join(root, output, "package.json"), "utf8"));
    assert.equal(manifest.scripts, undefined);
    assert.deepEqual(manifest.dependencies, { example: "1.0.0" });

    write("references/example.md", "updated reference\n");
    rmSync(join(root, output, ".textlintrc.json"));
    write(output + "obsolete.md", "obsolete\n");
    const before = readFileSync(join(root, output, "references/example.md"), "utf8");
    const checked = run("--check");
    assert.equal(checked.status, 1);
    for (const file of ["references/example.md", ".textlintrc.json", "obsolete.md"]) {
      assert.ok(checked.stderr.includes(file), checked.stderr);
    }
    assert.equal(readFileSync(join(root, output, "references/example.md"), "utf8"), before);
    assert.equal(run().status, 0);
    assert.equal(run("--check").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

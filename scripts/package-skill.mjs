#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// gh skills discovers published skills in skills/<name>/SKILL.md.
// Keep the existing root files canonical and ship only runtime resources.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "skills/tanteki");
const sources = [
  "SKILL.md", "LICENSE", ".textlintrc.json", "package-lock.json",
  "agents", "references", "rules", "scripts/lint.mjs"
];

function filesUnder(base, relative = "") {
  const path = join(base, relative);
  if (!statSync(path).isDirectory()) return [relative];
  return readdirSync(path).sort().flatMap((name) => filesUnder(base, join(relative, name)));
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: node scripts/package-skill.mjs [--check]");
  }

  const files = new Map(sources.flatMap((source) => filesUnder(root, source))
    .map((file) => [file, readFileSync(join(root, file))]));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // Repository tests and benchmarks are not part of the installed skill.
  delete manifest.scripts;
  delete manifest.devDependencies;
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  delete lock.packages[""].devDependencies;
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (dependency.dev === true) delete lock.packages[path];
  }
  files.set("package-lock.json", Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
  files.set("package.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  if (args[0] === "--check") {
    const actual = existsSync(destination) ? filesUnder(destination) : [];
    const missingOrChanged = [...files].filter(([file, content]) =>
      !actual.includes(file) || !readFileSync(join(destination, file)).equals(content));
    const extra = actual.filter((file) => !files.has(file));
    if (missingOrChanged.length || extra.length) {
      throw new Error("配布用スキルが正本と一致しません。npm run package:skill を実行してください。\n" +
        [...missingOrChanged.map(([file]) => file), ...extra].join("\n"));
    }
    console.log("配布用スキルは正本と一致しています。");
    return;
  }

  rmSync(destination, { recursive: true, force: true });
  for (const [file, content] of files) {
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, content);
  }
  console.log(`skills/tanteki に ${files.size} ファイルを出力しました。`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

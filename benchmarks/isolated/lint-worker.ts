import { readFile, writeFile } from "node:fs/promises";
import { inventory, sha256, invariant } from "./protocol.ts";
import { z } from "zod";
import { decode } from "./validation.ts";

if (process.argv[2] === "inventory") {
  console.log(JSON.stringify(await inventory("/opt/skill", { allowLinks: true })));
} else {
  const modulePath = "/opt/skill/scripts/lint.mjs";
  const { lintFiles } = await import(modulePath);
  const input = decode(z.object({ body: z.string(), bodyHash: z.string(), documentType: z.string() }), JSON.parse(await readFile("/input/job.json", "utf8")));
  invariant(sha256(input.body) === input.bodyHash, "Grader input changed");
  await writeFile("/tmp/document.md", input.body);
  const [{ messages }] = decode(z.array(z.object({ messages: z.array(z.object({ ruleId: z.string(), line: z.number(), column: z.number(), message: z.string() })) })).length(1), await lintFiles(input.documentType, ["/tmp/document.md"]));
  invariant(sha256(await readFile("/tmp/document.md")) === input.bodyHash, "Grader modified the document");
  console.log(JSON.stringify({ bodyHash: input.bodyHash, lint: messages.map(({ ruleId, line, column, message }) => ({ ruleId, line, column, message })) }));
}

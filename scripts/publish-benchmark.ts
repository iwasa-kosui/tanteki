import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRun, report } from "../benchmarks/isolated/cli.ts";
import { inventory } from "../benchmarks/isolated/protocol.ts";
import { auditFiles, readPublication } from "../benchmarks/isolated/publication.ts";

const { values } = parseArgs({ options: { run: { type: "string" }, evaluation: { type: "string" }, out: { type: "string" } } });
if (!values.run || !values.evaluation || !values.out) throw new Error("Use --run RUN --evaluation GRADE --out NEW_PUBLICATION");
const out = resolve(values.out);
const data = await readRun(values.run);
const evidence = await inventory(join(data.run, "calls"));
await mkdir(out); // Never replace an existing published measurement.
await report({ action: "report", run: data.run, evaluation: values.evaluation, out });
for (const file of ["manifest.json", "runtime-lock.json", "records"]) await cp(join(data.run, file), join(out, file), { recursive: true });
await cp(join(data.run, "private/cases.json"), join(out, "cases.json"));
for (const file of ["evaluation.json", "judge-instructions.txt"]) await cp(join(values.evaluation, file), join(out, file));
await writeFile(join(out, "evidence-inventory.json"), JSON.stringify(evidence, null, 2) + "\n");
await mkdir(join(out, "documents"));
for (const r of data.records) {
  await mkdir(join(out, "input-audits", r.id), { recursive: true });
  for (const file of auditFiles) if (evidence.files[`${r.id}/${file}`]) await cp(join(data.run, "calls", r.id, file), join(out, "input-audits", r.id, file));
  if (r.status === "valid") await writeFile(join(out, "documents", `${r.id}.md`), r.response.body);
}
await readPublication(out);
console.log(`Verified publication: ${out}`);

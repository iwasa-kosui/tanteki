import { sha256 } from "./protocol.ts";
import { arms, type BenchmarkCase } from "./benchmark-case.ts";
import type { PlannedExecution } from "./execution.ts";

export function makePlan(cases: readonly BenchmarkCase[], repeats: number, seed: string): PlannedExecution[] {
  const plan: PlannedExecution[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const ordered = [...cases].sort((a, b) => sha256(`${seed}:${repeat}:${a.id}`).localeCompare(sha256(`${seed}:${repeat}:${b.id}`)));
    for (const c of ordered) {
      // Each case alternates its first condition across repeats.
      const order = (cases.indexOf(c) + repeat) % 2 ? arms : [...arms].reverse();
      for (const arm of order) plan.push({ id: `${c.id}.${repeat}.${arm}`, caseId: c.id, repeat, arm });
    }
  }
  return plan;
}

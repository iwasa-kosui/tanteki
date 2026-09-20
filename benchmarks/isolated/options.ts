import { z } from "zod";
import { decode } from "./validation.ts";
import { invariant } from "./protocol.ts";

const settings = {
  model: z.string().min(1), effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  timeout: z.coerce.number().int().positive().default(600)
};
const schema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("help") }),
  z.strictObject({ action: z.literal("build"), out: z.string(), codexVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default("0.155.1") }),
  z.strictObject({ action: z.literal("generate"), ...settings, lock: z.string(), out: z.string().optional(), dryRun: z.boolean().default(false),
    repeats: z.coerce.number().int().positive().default(2), seed: z.string().default("isolated-v1"), maxCalls: z.coerce.number().int().positive().default(24), caseIds: z.string().optional(), casesFile: z.string().optional() }),
  z.strictObject({ action: z.literal("grade"), ...settings, run: z.string(), out: z.string() }),
  z.strictObject({ action: z.literal("report"), run: z.string(), out: z.string().optional(), evaluation: z.string().optional() })
]);
export type Options = z.infer<typeof schema>;
export type BuildOptions = Extract<Options, { action: "build" }>;
export type GenerateOptions = Extract<Options, { action: "generate" }>;
export type GradeOptions = Extract<Options, { action: "grade" }>;
export type ReportOptions = Extract<Options, { action: "report" }>;

export function options(argv: string[]): Options {
  const [action, ...args] = argv;
  if (!action || ["--help", "help", "-h"].includes(action)) return { action: "help" };
  invariant(["build", "generate", "grade", "report"].includes(action), "Use build, generate, grade or report. The old feedback experiment is benchmark:legacy.");
  const names: Record<string, string> = { "--out": "out", "--lock": "lock", "--model": "model", "--effort": "effort", "--cases": "caseIds", "--cases-file": "casesFile", "--repeats": "repeats", "--seed": "seed", "--timeout": "timeout", "--max-model-calls": "maxCalls", "--codex-version": "codexVersion", "--run": "run", "--evaluation": "evaluation" };
  const raw: Record<string, unknown> = { action };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") raw.dryRun = true;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) raw[names[args[i]]] = args[++i];
    else throw new Error(`Unknown/missing option: ${args[i]}`);
  }
  const parsed = decode(schema, raw);
  if (parsed.action === "generate") invariant(parsed.out || parsed.dryRun, "generate needs --out or --dry-run");
  return parsed;
}

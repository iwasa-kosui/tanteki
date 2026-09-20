import { spawn, spawnSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { ok, err, type Result } from "neverthrow";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Job } from "./job.ts";
import { messageOf } from "./validation.ts";
import type { EnvironmentEvidence } from "./native-evidence.ts";
import { configText, inventory, protocol, sha256, skillPath, invariant } from "./protocol.ts";

const agentEnvironment = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/agent", CODEX_HOME: "/home/agent/.codex",
  LANG: "C.UTF-8", TZ: "UTC", BENCHMARK_TOKEN: "local-relay-only",
  npm_config_offline: "true", npm_config_cache: `${skillPath}/.npm-cache`
};
const childOptions = { uid: 1000, gid: 1000, cwd: "/workspace", env: agentEnvironment };
const forbiddenRoots = ["/etc/codex", "/.agents", "/.codex", "/AGENTS.md", "/AGENTS.override.md", "/workspace/AGENTS.md"];

async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function runSetup(script: string, args: string[] = [], input?: string) {
  const result = spawnSync(process.execPath, ["-e", script, ...args], { ...childOptions, input, encoding: "utf8", maxBuffer: 1024 * 1024 });
  invariant(!result.error && result.status === 0, `Agent setup failed: ${result.error?.message ?? result.stderr}`);
}

export type EnvironmentError = Readonly<{ kind: "InvalidEnvironment"; message: string }>;
export type WorkerEnvironment = Readonly<{
  prepare: (job: Job) => Promise<Result<EnvironmentEvidence, EnvironmentError>>;
  startCodex: () => ChildProcessWithoutNullStreams;
  stopCodex: (child: ChildProcessWithoutNullStreams) => void;
}>;

async function prepare(job: Job): Promise<Result<EnvironmentEvidence, EnvironmentError>> {
  try {
    const privateHomeEmpty = (await readdir("/home/agent")).length === 0;
    const workspaceEmpty = (await readdir("/workspace")).length === 0;
    invariant(privateHomeEmpty && workspaceEmpty, "Nonempty initial working state");
    const found = (await Promise.all(forbiddenRoots.map(async (path) => await exists(path) ? path : null))).filter(Boolean);
    invariant(found.length === 0, `Unexpected configuration roots: ${found.join(", ")}`);
    const config = configText(job);
    runSetup("const fs=require('node:fs');fs.mkdirSync('/home/agent/.codex',{recursive:true});fs.writeFileSync('/home/agent/.codex/config.toml',fs.readFileSync(0));", [], config);
    const withSkill = await exists("/opt/skill");
    if (withSkill) runSetup("require('node:fs').cpSync('/opt/skill',process.argv[1],{recursive:true,verbatimSymlinks:true});", [skillPath]);
    const skillDigest = withSkill ? (await inventory(skillPath, { allowLinks: true })).digest : null;
    return ok({ protocol, promptHash: sha256(job.prompt), configTextHash: sha256(config), privateHomeEmpty, workspaceEmpty, skillDigest });
  } catch (error) { return err({ kind: "InvalidEnvironment", message: messageOf(error) }); }
}

export const WorkerEnvironment = {
  create: (): WorkerEnvironment => ({
    prepare,
    startCodex: () => spawn("codex", ["app-server", "--stdio", "--strict-config"], { ...childOptions, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
    stopCodex: (child: ChildProcessWithoutNullStreams) => {
      if (!child?.pid) return;
      // A same-UID helper avoids giving the trusted supervisor CAP_KILL.
      runSetup("try{process.kill(-Number(process.argv[1]),'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}", [String(child.pid)]);
    }
  })
};

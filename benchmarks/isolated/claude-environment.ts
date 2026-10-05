import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir } from "node:fs/promises";
import { ok, err, type Result } from "neverthrow";
import type { Job } from "./job.ts";
import { messageOf } from "./validation.ts";
import type { EnvironmentEvidence } from "./native-evidence.ts";
import { inventory, sha256, invariant } from "./protocol.ts";
import { claudeArguments, claudeCommandHash, claudeEnvironment, claudeProtocol, claudeSkillPath } from "./claude-config.ts";
import { exists, runSetup, type EnvironmentError } from "./worker-environment.ts";

const forbiddenRoots = ["/etc/claude-code", "/.claude", "/CLAUDE.md", "/workspace/CLAUDE.md", "/workspace/.claude", "/workspace/.mcp.json"];

export type ClaudeEnvironment = Readonly<{
  prepare: (job: Job) => Promise<Result<EnvironmentEvidence, EnvironmentError>>;
  startClaude: (job: Job) => ChildProcessWithoutNullStreams;
  stopClaude: (child: ChildProcessWithoutNullStreams) => void;
}>;

async function prepare(job: Job): Promise<Result<EnvironmentEvidence, EnvironmentError>> {
  try {
    invariant(job.protocol === claudeProtocol, "Job belongs to another protocol");
    const privateHomeEmpty = (await readdir("/home/agent")).length === 0;
    const workspaceEmpty = (await readdir("/workspace")).length === 0;
    invariant(privateHomeEmpty && workspaceEmpty, "Nonempty initial working state");
    const found = (await Promise.all(forbiddenRoots.map(async (path) => await exists(path) ? path : null))).filter(Boolean);
    invariant(found.length === 0, `Unexpected configuration roots: ${found.join(", ")}`);
    const withSkill = await exists("/opt/skill");
    if (withSkill) runSetup("require('node:fs').cpSync('/opt/skill',process.argv[1],{recursive:true,verbatimSymlinks:true});", [claudeSkillPath]);
    const skillDigest = withSkill ? (await inventory(claudeSkillPath, { allowLinks: true })).digest : null;
    return ok({ protocol: claudeProtocol, promptHash: sha256(job.prompt), configTextHash: claudeCommandHash(job), privateHomeEmpty, workspaceEmpty, skillDigest });
  } catch (error) { return err({ kind: "InvalidEnvironment", message: messageOf(error) }); }
}

export const ClaudeEnvironment = {
  create: (): ClaudeEnvironment => ({
    prepare,
    startClaude: (job) => spawn("claude", claudeArguments(job), { uid: 1000, gid: 1000, cwd: "/workspace", env: claudeEnvironment, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
    stopClaude: (child) => {
      if (!child?.pid) return;
      // A same-UID helper avoids giving the trusted supervisor CAP_KILL.
      runSetup("try{process.kill(-Number(process.argv[1]),'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}", [String(child.pid)]);
    }
  })
};

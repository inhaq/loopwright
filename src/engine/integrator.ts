import path from "node:path";
import { randomUUID } from "node:crypto";
import { git, GitError, spawnGit, type GitExec } from "../workspace/git.js";
import { runMechanicalGate, type CommandExecutor } from "./mechanicalGate.js";
import type { MechanicalGateResult } from "../schemas/artifact.js";

/**
 * Integrator (Task 21): merges the branches produced by parallel tasks back
 * together and runs full verification on the combined result (Req 9.3, 9.4).
 *
 * Integration happens in a dedicated worktree on a fresh integration branch, so
 * the source repo's checked-out state is never disturbed. Branches are merged
 * in the given (dependency) order; a conflicting merge is **aborted and
 * surfaced** with its conflicting paths rather than force-resolved, so a human
 * can decide. After the clean merges, the configured verification commands run
 * against the integrated tree.
 */

export interface IntegrationBranch {
  taskId: string;
  branch: string;
}

export interface IntegrationConflict {
  taskId: string;
  branch: string;
  /** unmerged paths reported by git for this merge */
  files: string[];
}

export interface IntegrationResult {
  /** task ids merged cleanly, in order */
  merged: string[];
  /** branches that could not be merged without conflict (surfaced, not merged) */
  conflicts: IntegrationConflict[];
  /** the integration branch holding the merged result */
  integrationBranch: string;
  /** verification run on the integrated tree (absent when no commands given) */
  verification?: MechanicalGateResult;
  /** true when every branch merged cleanly AND verification passed */
  ok: boolean;
}

export interface IntegrateInput {
  repoDir: string;
  branches: IntegrationBranch[];
  /** ref to integrate on top of (default: HEAD) */
  baseRef?: string;
  /** name for the integration branch (default: unique per call) */
  integrationBranch?: string;
  /** commands run on the integrated result (full verification) */
  verifyCommands?: string[];
  /** executor for the verification gate (defaults to the gate's real one) */
  executor?: CommandExecutor;
  git?: GitExec;
  log?: (line: string) => void;
}

/** Lists unmerged (conflicted) paths in a worktree mid-merge. */
async function conflictedFiles(exec: GitExec, cwd: string): Promise<string[]> {
  const res = await exec(["diff", "--name-only", "--diff-filter=U"], cwd);
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function integrate(input: IntegrateInput): Promise<IntegrationResult> {
  const exec = input.git ?? spawnGit;
  const baseRef = input.baseRef ?? "HEAD";
  const integrationBranch = input.integrationBranch ?? `loopwright/integration/${randomUUID().slice(0, 8)}`;
  const dir = path.join(input.repoDir, ".loopwright", "integration", randomUUID().slice(0, 8));

  // Isolate integration in its own worktree so the repo checkout is untouched.
  await git(exec, ["worktree", "add", "-f", "-B", integrationBranch, dir, baseRef], input.repoDir);

  const merged: string[] = [];
  const conflicts: IntegrationConflict[] = [];

  try {
    for (const { taskId, branch } of input.branches) {
      try {
        await git(exec, ["merge", "--no-ff", "-m", `integrate ${taskId}`, branch], dir);
        merged.push(taskId);
        input.log?.(`integrated ${taskId} (${branch})`);
      } catch (err) {
        if (err instanceof GitError) {
          const files = await conflictedFiles(exec, dir);
          // back out the failed merge so subsequent merges can proceed
          await exec(["merge", "--abort"], dir);
          conflicts.push({ taskId, branch, files });
          input.log?.(`CONFLICT integrating ${taskId} (${branch}): ${files.join(", ") || "unknown"}`);
        } else {
          throw err;
        }
      }
    }

    let verification: MechanicalGateResult | undefined;
    if (input.verifyCommands && input.verifyCommands.length > 0) {
      verification = await runMechanicalGate(input.verifyCommands, {
        cwd: dir,
        ...(input.executor ? { executor: input.executor } : {}),
      });
    }

    return {
      merged,
      conflicts,
      integrationBranch,
      ...(verification ? { verification } : {}),
      ok: conflicts.length === 0 && (verification?.passed ?? true),
    };
  } finally {
    // Remove the integration worktree; the integration branch is kept for review.
    await exec(["worktree", "remove", "--force", dir], input.repoDir);
  }
}

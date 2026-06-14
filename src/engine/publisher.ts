import { spawn } from "node:child_process";
import { git, GitError, remoteUrl, spawnGit, type GitExec } from "../workspace/git.js";
import type { IntegrationResult } from "./integrator.js";

/**
 * Publisher (push + pull request).
 *
 * After a run integrates its per-task branches onto a single integration branch
 * (see integrator.ts), this module optionally pushes that branch to a git
 * remote and opens a pull request. It is the only place that talks to a REMOTE,
 * and it does so behind a hard SAFETY GATE: a run that did not cleanly merge and
 * verify must never reach a remote unless the user explicitly overrides.
 *
 * Design rules:
 *   - Never pushes to a default/protected branch. We push the integration
 *     branch under its own name; opening (and merging) a PR is the human's call.
 *   - All errors are turned into a structured `PublishResult`, never thrown, so
 *     a failed push (missing remote, auth) surfaces as a clear status the UI can
 *     render rather than crashing the run after the work succeeded.
 *   - git and the PR creator are injectable so this is unit-testable without a
 *     network or the gh CLI.
 */

/** Why a publish was refused by the safety gate (item 10), or undefined if safe. */
export type PublishRefusal =
  | "integration-failed"
  | "merge-conflicts"
  | "verification-failed"
  | "needs-human"
  | "no-remote";

export interface PublishOptions {
  repoDir: string;
  /** the local integration branch to publish */
  branch: string;
  /** remote name (default "origin") */
  remote?: string;
  /** remote branch name to push to (default: same as `branch`) */
  pushBranch?: string;
  /** whether to push at all */
  push: boolean;
  /** whether to open a PR after a successful push */
  openPr?: boolean;
  prBase?: string;
  prTitle?: string;
  prBody?: string;
  prDraft?: boolean;
  /** push even when the safety gate would refuse */
  overrideSafety?: boolean;
  /** integration outcome used by the safety gate */
  integration?: IntegrationResult;
  /** task ids still needing a human (blocks push unless overridden) */
  needsHuman?: string[];
  git?: GitExec;
  prCreator?: PrCreator;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface PrInfo {
  created: boolean;
  url?: string;
  error?: string;
}

export interface PublishResult {
  /** true once the branch was pushed to the remote */
  pushed: boolean;
  remote: string;
  /** local branch published */
  branch: string;
  /** remote branch it was pushed to */
  pushBranch: string;
  remoteUrl?: string;
  /** set when the safety gate (or a missing remote) blocked the push */
  refused?: PublishRefusal;
  /** human-readable reason, including failed-command output when relevant */
  reason?: string;
  /** present when openPr was requested and a push succeeded */
  pr?: PrInfo;
  /** push error message (auth, network, protected branch, …) */
  error?: string;
}

/** Creates a pull request for an already-pushed branch. Injectable for tests. */
export type PrCreator = (input: {
  repoDir: string;
  head: string;
  base?: string;
  title: string;
  body: string;
  draft: boolean;
  signal?: AbortSignal;
}) => Promise<{ url?: string }>;

/** Result of the safety gate: a refusal code + message, or `undefined` if safe. */
export function publishSafety(opts: {
  integration?: IntegrationResult;
  needsHuman?: string[];
}): { refusal: PublishRefusal; reason: string } | undefined {
  const { integration, needsHuman } = opts;
  if (integration) {
    if (integration.conflicts.length > 0) {
      const branches = integration.conflicts.map((c) => `${c.taskId} (${c.branch})`).join(", ");
      return {
        refusal: "merge-conflicts",
        reason: `Refusing to push: ${integration.conflicts.length} branch(es) had merge conflicts: ${branches}.`,
      };
    }
    if (integration.verification && integration.verification.passed === false) {
      const failed = integration.verification.steps.find((s) => !s.passed);
      const detail = failed
        ? `\nFailed command: ${failed.command} (exit ${failed.exitCode})\n${failed.output}`
        : "";
      return {
        refusal: "verification-failed",
        reason: `Refusing to push: full-tree verification failed after merge.${detail}`,
      };
    }
    if (!integration.ok) {
      return { refusal: "integration-failed", reason: "Refusing to push: integration did not succeed." };
    }
  }
  if (needsHuman && needsHuman.length > 0) {
    return {
      refusal: "needs-human",
      reason: `Refusing to push: ${needsHuman.length} task(s) need a human: ${needsHuman.join(", ")}.`,
    };
  }
  return undefined;
}

/**
 * Pushes the integration branch and (optionally) opens a PR, after enforcing
 * the safety gate. Always resolves with a structured result; never throws.
 */
export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const exec = opts.git ?? spawnGit;
  const remote = opts.remote || "origin";
  const branch = opts.branch;
  const pushBranch = opts.pushBranch || branch;
  const base: PublishResult = { pushed: false, remote, branch, pushBranch };

  if (!opts.push) {
    return { ...base, refused: undefined, reason: "push not requested" };
  }

  // Safety gate (item 10): refuse a push for a run that did not cleanly merge
  // and verify, or that has tasks needing a human — unless explicitly overridden.
  const safety = publishSafety({
    ...(opts.integration ? { integration: opts.integration } : {}),
    ...(opts.needsHuman ? { needsHuman: opts.needsHuman } : {}),
  });
  if (safety && !opts.overrideSafety) {
    opts.log?.(safety.reason);
    return { ...base, refused: safety.refusal, reason: safety.reason };
  }
  if (safety && opts.overrideSafety) {
    opts.log?.(`Safety gate overridden: ${safety.reason}`);
  }

  // A push to a non-existent remote fails with an opaque git error; check first
  // so we can return a precise, actionable message.
  const url = await remoteUrl(opts.repoDir, remote, exec);
  if (!url) {
    const reason = `Remote "${remote}" is not configured. Add it (e.g. git remote add ${remote} <url>) and try again.`;
    opts.log?.(reason);
    return { ...base, refused: "no-remote", reason };
  }

  if (opts.signal?.aborted) {
    return { ...base, remoteUrl: url, error: "cancelled before push" };
  }

  try {
    // Push the integration branch under the chosen remote name. We never push
    // to a default/protected branch here; the user merges via the PR.
    await git(exec, ["push", "--set-upstream", remote, `${branch}:${pushBranch}`], opts.repoDir);
    opts.log?.(`pushed ${branch} -> ${remote}/${pushBranch}`);
  } catch (err) {
    const message = err instanceof GitError ? err.message : String((err as Error)?.message ?? err);
    opts.log?.(`push failed: ${message}`);
    return { ...base, remoteUrl: url, error: message };
  }

  const result: PublishResult = { ...base, pushed: true, remoteUrl: url };

  if (opts.openPr) {
    const creator = opts.prCreator ?? ghPrCreator;
    const title = opts.prTitle?.trim() || `Loopwright: ${branch}`;
    const body = opts.prBody?.trim() || "Opened by Loopwright after a verified actor-critic run.";
    try {
      const { url: prUrl } = await creator({
        repoDir: opts.repoDir,
        head: pushBranch,
        ...(opts.prBase ? { base: opts.prBase } : {}),
        title,
        body,
        draft: opts.prDraft ?? true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      result.pr = { created: true, ...(prUrl ? { url: prUrl } : {}) };
      opts.log?.(`opened PR${prUrl ? `: ${prUrl}` : ""}`);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      result.pr = { created: false, error: message };
      opts.log?.(`PR creation failed: ${message}`);
    }
  }

  return result;
}

const GH_URL_RE = /https?:\/\/\S+/;

/**
 * Default PR creator: shells out to the GitHub CLI (`gh pr create`). Requires
 * `gh` to be installed and authenticated (`gh auth status`). Throws a clear
 * error if `gh` is missing or the command fails, which `publish` captures into
 * `pr.error` for the UI.
 */
export const ghPrCreator: PrCreator = ({ repoDir, head, base, title, body, draft, signal }) =>
  new Promise((resolve, reject) => {
    const args = ["pr", "create", "--head", head, "--title", title, "--body", body];
    if (base) args.push("--base", base);
    if (draft) args.push("--draft");

    const child = spawn("gh", args, { cwd: repoDir, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(
          err.message.includes("ENOENT")
            ? "GitHub CLI (gh) not found. Install it or open the PR manually."
            : err.message,
        ),
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        const match = stdout.match(GH_URL_RE);
        resolve({ ...(match ? { url: match[0] } : {}) });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `gh pr create exited ${code}`));
      }
    });
  });

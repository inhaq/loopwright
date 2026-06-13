import { spawn, type ChildProcess } from "node:child_process";

/**
 * Terminates a child process AND every descendant it spawned.
 *
 * A plain `child.kill()` only signals the direct child. When the child is a
 * shell (`shell: true`) or a launcher like `bash -c`, the real workload runs in
 * a grandchild (e.g. `sleep`). Signalling only the shell orphans that
 * grandchild, which keeps the inherited stdio pipes open and delays the
 * parent's `"close"` event until the grandchild exits on its own — defeating
 * the timeout safeguard entirely.
 *
 * To kill the whole tree the child must be spawned as a process-group leader,
 * i.e. with `detached: true` on POSIX (see {@link detachForTreeKill}). On
 * Windows there is no process-group signalling, so we delegate to `taskkill`.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    // /T kills the process tree, /F forces termination. Best-effort: the
    // process may have already exited, in which case taskkill just no-ops.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    killer.on("error", () => {
      /* taskkill missing or process already gone — nothing more we can do */
    });
    return;
  }

  try {
    // A negative PID targets the entire process group, which exists only
    // because the child was spawned detached (its own session/group leader).
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone, or the child was not a group leader — fall back to
    // signalling the direct child so we at least kill what we can.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

/**
 * Whether to spawn detached so {@link killProcessTree} can signal the whole
 * group. Only meaningful on POSIX; on Windows `detached` opens a new console
 * and is unnecessary because `taskkill /T` walks the tree by PID.
 */
export const detachForTreeKill = process.platform !== "win32";

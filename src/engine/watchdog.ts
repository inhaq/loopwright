/**
 * Stuck-detection watchdog (Task 18).
 *
 * A run can wedge when a backend hangs (a runner that never returns, a gate
 * command that blocks). The loop's caps bound *cycles*, not wall-clock per
 * step, so a single hung call would otherwise stall forever. The watchdog adds
 * a no-progress threshold: if an awaited step doesn't settle within the limit,
 * the loop stops waiting and routes the task to NEEDS_HUMAN.
 *
 * Two pieces:
 *   - `guardProgress` races a single operation against the threshold. It does
 *     not (and cannot) cancel the underlying promise; it stops *waiting* and
 *     reports `stuck` so the caller can abort cleanly.
 *   - `ProgressWatchdog` tracks time since the last progress signal, for a
 *     supervisor (e.g. the parallel scheduler) to poll across tasks.
 */

export type Guarded<T> =
  | { stuck: false; value: T }
  | { stuck: true; elapsedMs: number };

/**
 * Resolves with the operation's value if it settles within `thresholdMs`,
 * otherwise resolves `{ stuck: true }`. A non-positive/!finite threshold
 * disables the guard (awaits normally). Rejections propagate unchanged.
 */
export function guardProgress<T>(op: Promise<T>, thresholdMs: number): Promise<Guarded<T>> {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return op.then((value) => ({ stuck: false as const, value }));
  }
  const started = Date.now();
  return new Promise<Guarded<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ stuck: true, elapsedMs: Date.now() - started });
    }, thresholdMs);
    // Don't let the watchdog timer keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();

    op.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stuck: false, value });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Tracks elapsed time since the last `ping()`. The clock is injectable so a
 * supervisor's stuck logic is deterministically testable.
 */
export class ProgressWatchdog {
  private last: number;

  constructor(
    private readonly thresholdMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.last = clock();
  }

  /** Records that progress happened just now. */
  ping(): void {
    this.last = this.clock();
  }

  msSinceProgress(): number {
    return this.clock() - this.last;
  }

  isStuck(): boolean {
    return (
      Number.isFinite(this.thresholdMs) &&
      this.thresholdMs > 0 &&
      this.msSinceProgress() > this.thresholdMs
    );
  }
}

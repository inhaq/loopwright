import { describe, it, expect } from "vitest";
import { runMechanicalGate, createShellExecutor, TIMEOUT_EXIT_CODE } from "../src/engine/mechanicalGate.js";
import { scriptedExecutor } from "../src/adapters/mocks.js";

describe("mechanical gate", () => {
  it("kills a running command when the abort signal fires", async () => {
    const exec = createShellExecutor();
    const ac = new AbortController();
    const started = Date.now();
    const p = exec("sleep 5", ".", ac.signal);
    setTimeout(() => ac.abort(), 20);
    const out = await p;
    // Cancelled, not run to completion: non-zero and well under the 5s sleep.
    expect(out.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("passes when all commands succeed", async () => {
    const exec = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));
    const r = await runMechanicalGate(["npm run build", "npm test"], { cwd: ".", executor: exec });
    expect(r.passed).toBe(true);
    expect(r.steps).toHaveLength(2);
  });

  it("fails fast at the first failing command", async () => {
    const exec = scriptedExecutor((cmd) => ({ exitCode: cmd === "npm test" ? 1 : 0, output: cmd }));
    const r = await runMechanicalGate(["npm run build", "npm test", "npm run lint"], {
      cwd: ".",
      executor: exec,
    });
    expect(r.passed).toBe(false);
    // build ran + test failed; lint never ran (fail-fast)
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]?.passed).toBe(false);
  });

  it("treats an empty command list as a (recorded) pass", async () => {
    const r = await runMechanicalGate([], { cwd: "." });
    expect(r.passed).toBe(true);
    expect(r.steps).toHaveLength(0);
  });

  it("redacts secrets in captured output", async () => {
    const exec = scriptedExecutor(() => ({ exitCode: 1, output: "FAIL: key=sk-deadbeef0123456789abcd" }));
    const r = await runMechanicalGate(["npm test"], { cwd: ".", executor: exec });
    expect(r.steps[0]?.output).not.toContain("sk-deadbeef");
    expect(r.steps[0]?.output).toContain("[REDACTED]");
  });
});


describe("shell executor safeguards", () => {
  it("kills a command that exceeds the timeout", async () => {
    const exec = createShellExecutor({ timeoutMs: 200 });
    const start = Date.now();
    const r = await exec("sleep 5", ".");
    expect(r.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(r.output).toContain("timeout");
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10_000);

  it("bounds captured output to the configured max", async () => {
    const exec = createShellExecutor({ maxCapturedChars: 100 });
    // Use node itself (guaranteed present, cross-platform) to emit a lot of
    // output rather than POSIX-only shell builtins like `seq`, which fail
    // under cmd.exe on Windows.
    const r = await exec(
      `node -e "for(let i=0;i<1000;i++)console.log('AAAAAAAAAA')"`,
      ".",
    );
    expect(r.exitCode).toBe(0);
    expect(r.output.length).toBeLessThanOrEqual(100);
  }, 10_000);
});

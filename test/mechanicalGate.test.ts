import { describe, it, expect } from "vitest";
import { runMechanicalGate } from "../src/engine/mechanicalGate.js";
import { scriptedExecutor } from "../src/adapters/mocks.js";

describe("mechanical gate", () => {
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

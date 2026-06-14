import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config env boolean parsing", () => {
  it("interprets falsy strings as false (not JS-truthy)", () => {
    const c = loadConfig({
      LOOPWRIGHT_MECHANICAL_GATE: "false",
      LOOPWRIGHT_USE_WORKTREES: "0",
    });
    expect(c.mechanicalGate).toBe(false);
    expect(c.useWorktrees).toBe(false);
  });

  it("interprets truthy strings as true", () => {
    const c = loadConfig({
      LOOPWRIGHT_MECHANICAL_GATE: "true",
      LOOPWRIGHT_USE_WORKTREES: "on",
    });
    expect(c.mechanicalGate).toBe(true);
    expect(c.useWorktrees).toBe(true);
  });

  it("defaults booleans to true when unset", () => {
    const c = loadConfig({});
    expect(c.mechanicalGate).toBe(true);
    expect(c.useWorktrees).toBe(true);
  });
});

describe("config git-ref validation (fail-fast)", () => {
  it("accepts valid ref names and applies defaults", () => {
    const c = loadConfig({ LOOPWRIGHT_BRANCH_PREFIX: "team/loopwright", LOOPWRIGHT_PR_BASE: "release/v1" });
    expect(c.branchPrefix).toBe("team/loopwright");
    expect(c.prBase).toBe("release/v1");
    expect(loadConfig({}).branchPrefix).toBe("loopwright");
  });

  it("rejects a branch prefix with whitespace or invalid ref tokens", () => {
    expect(() => loadConfig({ LOOPWRIGHT_BRANCH_PREFIX: "bad prefix" })).toThrow();
    expect(() => loadConfig({ LOOPWRIGHT_BRANCH_PREFIX: "" })).toThrow();
    expect(() => loadConfig({ LOOPWRIGHT_PUSH_BRANCH: "feat..x" })).toThrow();
    expect(() => loadConfig({ LOOPWRIGHT_PR_BASE: "what?*" })).toThrow();
  });
});

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

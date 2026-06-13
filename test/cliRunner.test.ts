import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { CliRunner } from "../src/runners/cliRunner.js";
import type { RunnerProfile } from "../src/runners/agentRunner.js";

function profile(options: Record<string, unknown>): RunnerProfile {
  return { id: "r1", kind: "cli", model: "test-model", options };
}

describe("CliRunner", () => {
  it("delivers the prompt via stdin and returns stdout", async () => {
    const runner = new CliRunner(profile({ command: "cat", promptVia: "stdin" }));
    const r = await runner.run({ prompt: "hello world", cwd: "." });
    expect(r.text).toBe("hello world");
    expect(r.quotaExhausted).toBe(false);
    expect(r.meta?.exitCode).toBe(0);
  });

  it("substitutes {{model}} and {{prompt}} into argv", async () => {
    const runner = new CliRunner(
      profile({ command: "bash", args: ["-c", "echo m=$0 p=$1", "{{model}}", "{{prompt}}"] }),
    );
    const r = await runner.run({ prompt: "hi", cwd: "." });
    expect(r.text).toContain("m=test-model");
    expect(r.text).toContain("p=hi");
  });

  it("parses the final message from a JSONL event stream", async () => {
    const script =
      `printf '%s\\n' '{"type":"delta","text":"first"}' '{"type":"final","text":"the answer"}'`;
    const runner = new CliRunner(
      profile({
        command: "bash",
        args: ["-c", script],
        output: { mode: "json-stream", textPath: "text", typeField: "type", type: "final" },
      }),
    );
    const r = await runner.run({ prompt: "x", cwd: "." });
    expect(r.text).toBe("the answer");
  });

  it("reads the answer from a file the CLI writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "clirunner-"));
    try {
      const runner = new CliRunner(
        profile({
          command: "bash",
          args: ["-c", `echo "file answer" > out.txt`],
          output: { mode: "file", file: "out.txt" },
        }),
      );
      const r = await runner.run({ prompt: "x", cwd: dir });
      expect(r.text).toBe("file answer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags quota exhaustion by exit code", async () => {
    const runner = new CliRunner(
      profile({ command: "bash", args: ["-c", "echo busy; exit 7"], quota: { exitCodes: [7] } }),
    );
    const r = await runner.run({ prompt: "x", cwd: "." });
    expect(r.quotaExhausted).toBe(true);
    expect(r.meta?.exitCode).toBe(7);
  });

  it("flags quota exhaustion by output pattern", async () => {
    const runner = new CliRunner(
      profile({
        command: "bash",
        args: ["-c", `echo "Error: rate limit exceeded"`],
        quota: { pattern: "rate limit" },
      }),
    );
    const r = await runner.run({ prompt: "x", cwd: "." });
    expect(r.quotaExhausted).toBe(true);
  });

  it("expands ${VARS} in env so secrets pass through without hard-coding", async () => {
    process.env.LW_TEST_SECRET = "sek-123";
    try {
      const runner = new CliRunner(
        profile({
          command: "bash",
          args: ["-c", "echo got=$INJECTED"],
          env: { INJECTED: "${LW_TEST_SECRET}" },
        }),
      );
      const r = await runner.run({ prompt: "x", cwd: "." });
      expect(r.text).toBe("got=sek-123");
    } finally {
      delete process.env.LW_TEST_SECRET;
    }
  });

  it("kills a command that exceeds the timeout", async () => {
    const runner = new CliRunner(
      profile({ command: "bash", args: ["-c", "sleep 5"], timeoutMs: 200 }),
    );
    const start = Date.now();
    const r = await runner.run({ prompt: "x", cwd: "." });
    expect(r.meta?.timedOut).toBe(true);
    expect(r.meta?.exitCode).toBe(124);
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10_000);

  it("reports a spawn error for a missing command instead of throwing", async () => {
    const runner = new CliRunner(profile({ command: "definitely-not-a-real-binary-xyz" }));
    const r = await runner.run({ prompt: "x", cwd: "." });
    expect(r.text).toBe("");
    expect(r.meta?.exitCode).toBe(127);
    expect(typeof r.meta?.spawnError).toBe("string");
  });

  it("validates options at construction (strict schema)", () => {
    expect(() => new CliRunner(profile({ command: "" }))).toThrow();
    expect(() => new CliRunner(profile({ command: "x", bogusKey: true }))).toThrow();
  });
});

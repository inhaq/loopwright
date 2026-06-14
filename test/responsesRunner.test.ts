import { describe, it, expect } from "vitest";
import {
  ResponsesRunner,
  extractResponsesText,
} from "../src/runners/responsesRunner.js";
import type { FetchLike } from "../src/runners/httpRunner.js";
import type { RunnerProfile } from "../src/runners/agentRunner.js";

const profile = (options: Record<string, unknown>): RunnerProfile => ({
  id: "p",
  kind: "http-responses",
  model: "gpt-5.5",
  options,
});

/** A fake fetch that records the call and returns a scripted response. */
function fakeFetch(
  impl: (url: string, init: { headers: Record<string, string>; body: string }) =>
    | { ok: boolean; status: number; json?: unknown; text?: string },
): { fetch: FetchLike; calls: Array<{ url: string; headers: Record<string, string>; body: any }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = impl(url, init);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text ?? "",
    };
  };
  return { fetch, calls };
}

/** A realistic Responses API success body (no output_text convenience field). */
const outputBody = (text: string, usage?: unknown) => ({
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ],
  ...(usage ? { usage } : {}),
});

describe("extractResponsesText", () => {
  it("prefers the output_text convenience field", () => {
    expect(extractResponsesText({ output_text: "hi", output: [] })).toBe("hi");
  });

  it("joins an output_text array", () => {
    expect(extractResponsesText({ output_text: ["a", "b"] })).toBe("ab");
  });

  it("walks output[].content[] for output_text parts", () => {
    expect(extractResponsesText(outputBody("from-content"))).toBe("from-content");
  });

  it("returns empty string for unexpected shapes", () => {
    expect(extractResponsesText(null)).toBe("");
    expect(extractResponsesText({ choices: [] })).toBe("");
  });
});

describe("ResponsesRunner option validation", () => {
  it("rejects a profile without a valid baseUrl", () => {
    expect(() => new ResponsesRunner(profile({}), { fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch }))
      .toThrow();
    expect(() => new ResponsesRunner(profile({ baseUrl: "nope" }), { fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch }))
      .toThrow();
  });

  it("rejects unknown options (strict schema)", () => {
    expect(
      () =>
        new ResponsesRunner(profile({ baseUrl: "https://api.openai.com/v1", bogus: 1 }), {
          fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch,
        }),
    ).toThrow();
  });
});

describe("ResponsesRunner request shaping", () => {
  it("posts to /responses with input + instructions and the profile model", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, json: outputBody("hello") }));
    const runner = new ResponsesRunner(
      profile({ baseUrl: "https://api.openai.com/v1", temperature: 0.3, maxOutputTokens: 256 }),
      { fetch },
    );
    const res = await runner.run({ prompt: "do it", cwd: ".", system: "you are X" });

    expect(res.text).toBe("hello");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]?.body.model).toBe("gpt-5.5");
    expect(calls[0]?.body.input).toBe("do it");
    expect(calls[0]?.body.instructions).toBe("you are X");
    expect(calls[0]?.body.temperature).toBe(0.3);
    expect(calls[0]?.body.max_output_tokens).toBe(256);
  });

  it("sends reasoning.effort when configured", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, json: outputBody("ok") }));
    const runner = new ResponsesRunner(
      profile({ baseUrl: "https://api.openai.com/v1", reasoningEffort: "high" }),
      { fetch },
    );
    await runner.run({ prompt: "p", cwd: "." });
    expect(calls[0]?.body.reasoning).toEqual({ effort: "high" });
  });

  it("reads the API key from the referenced env var (secret by reference)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, json: outputBody("ok") }));
    const runner = new ResponsesRunner(
      profile({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "MY_KEY", headers: { "x-org": "${MY_ORG}" } }),
      { fetch, env: { MY_KEY: "secret-123", MY_ORG: "acme" } },
    );
    await runner.run({ prompt: "p", cwd: "." });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-123");
    expect(calls[0]?.headers["x-org"]).toBe("acme");
  });

  it("surfaces provider usage in meta for the cost ledger", async () => {
    const { fetch } = fakeFetch(() => ({ ok: true, status: 200, json: outputBody("ok", { total_tokens: 99 }) }));
    const runner = new ResponsesRunner(profile({ baseUrl: "https://api.openai.com/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.meta?.usage).toEqual({ total_tokens: 99 });
  });
});

describe("ResponsesRunner quota + error handling", () => {
  it("flags quotaExhausted on HTTP 429", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 429, text: "rate limit" }));
    const runner = new ResponsesRunner(profile({ baseUrl: "https://api.openai.com/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.quotaExhausted).toBe(true);
    expect(res.text).toBe("");
    expect(res.meta?.status).toBe(429);
  });

  it("flags quotaExhausted when the error body matches the configured pattern", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 400, text: "insufficient_quota for org" }));
    const runner = new ResponsesRunner(
      profile({ baseUrl: "https://api.openai.com/v1", quota: { statusCodes: [], pattern: "insufficient_quota" } }),
      { fetch },
    );
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.quotaExhausted).toBe(true);
  });

  it("resolves transport failures to a result with diagnostics instead of throwing", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const runner = new ResponsesRunner(profile({ baseUrl: "https://api.openai.com/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.text).toBe("");
    expect(String(res.meta?.error)).toContain("ECONNREFUSED");
  });
});

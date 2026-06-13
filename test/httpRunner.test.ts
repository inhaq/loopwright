import { describe, it, expect } from "vitest";
import { HttpRunner, type FetchLike } from "../src/runners/httpRunner.js";
import type { RunnerProfile } from "../src/runners/agentRunner.js";

const profile = (options: Record<string, unknown>): RunnerProfile => ({
  id: "p",
  kind: "http",
  model: "test-model",
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

const okBody = (content: string, usage?: unknown) => ({
  choices: [{ message: { role: "assistant", content } }],
  ...(usage ? { usage } : {}),
});

describe("HttpRunner option validation", () => {
  it("rejects a profile without a valid baseUrl", () => {
    expect(() => new HttpRunner(profile({}), { fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch }))
      .toThrow();
    expect(() => new HttpRunner(profile({ baseUrl: "not-a-url" }), { fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch }))
      .toThrow();
  });

  it("rejects unknown options (strict schema)", () => {
    expect(
      () =>
        new HttpRunner(profile({ baseUrl: "https://h/v1", bogus: 1 }), {
          fetch: fakeFetch(() => ({ ok: true, status: 200 })).fetch,
        }),
    ).toThrow();
  });
});

describe("HttpRunner request shaping", () => {
  it("posts an OpenAI-style chat body with system+user messages and the profile model", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, json: okBody("hello") }));
    const runner = new HttpRunner(profile({ baseUrl: "https://h/v1", temperature: 0.2 }), { fetch });
    const res = await runner.run({ prompt: "do it", cwd: ".", system: "you are X" });

    expect(res.text).toBe("hello");
    expect(calls[0]?.url).toBe("https://h/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("test-model");
    expect(calls[0]?.body.messages).toEqual([
      { role: "system", content: "you are X" },
      { role: "user", content: "do it" },
    ]);
    expect(calls[0]?.body.temperature).toBe(0.2);
  });

  it("reads the API key from the referenced env var (secret by reference)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, json: okBody("ok") }));
    const runner = new HttpRunner(
      profile({ baseUrl: "https://h/v1", apiKeyEnv: "MY_KEY", headers: { "x-org": "${MY_ORG}" } }),
      { fetch, env: { MY_KEY: "secret-123", MY_ORG: "acme" } },
    );
    await runner.run({ prompt: "p", cwd: "." });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-123");
    expect(calls[0]?.headers["x-org"]).toBe("acme");
  });

  it("surfaces provider usage in meta for the cost ledger", async () => {
    const { fetch } = fakeFetch(() => ({ ok: true, status: 200, json: okBody("ok", { total_tokens: 42 }) }));
    const runner = new HttpRunner(profile({ baseUrl: "https://h/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.meta?.usage).toEqual({ total_tokens: 42 });
  });
});

describe("HttpRunner quota + error handling", () => {
  it("flags quotaExhausted on HTTP 429", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 429, text: "rate limit" }));
    const runner = new HttpRunner(profile({ baseUrl: "https://h/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.quotaExhausted).toBe(true);
    expect(res.text).toBe("");
    expect(res.meta?.status).toBe(429);
  });

  it("flags quotaExhausted when the error body matches the configured pattern", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 400, text: "insufficient_quota for org" }));
    const runner = new HttpRunner(
      profile({ baseUrl: "https://h/v1", quota: { statusCodes: [], pattern: "insufficient_quota" } }),
      { fetch },
    );
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.quotaExhausted).toBe(true);
  });

  it("does not flag quota for an ordinary non-2xx error", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 500, text: "boom" }));
    const runner = new HttpRunner(profile({ baseUrl: "https://h/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.quotaExhausted).toBe(false);
    expect(res.meta?.status).toBe(500);
  });

  it("resolves transport failures to a result with diagnostics instead of throwing", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const runner = new HttpRunner(profile({ baseUrl: "https://h/v1" }), { fetch });
    const res = await runner.run({ prompt: "p", cwd: "." });
    expect(res.text).toBe("");
    expect(String(res.meta?.error)).toContain("ECONNREFUSED");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTurnstile } from "./turnstile.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
}

describe("verifyTurnstile", () => {
  it("returns true on { success: true }", async () => {
    mockFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstile("tok", "1.2.3.4", "secret")).toBe(true);
  });

  it("returns false on { success: false } (failure/expired)", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), {
          status: 200,
        }),
    );
    expect(await verifyTurnstile("tok", "1.2.3.4", "secret")).toBe(false);
  });

  it("returns false on non-200 responses", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    expect(await verifyTurnstile("tok", null, "secret")).toBe(false);
  });

  it("returns false (fail closed) when fetch throws", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    expect(await verifyTurnstile("tok", "1.2.3.4", "secret")).toBe(false);
  });

  it("short-circuits false without a token or secret", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await verifyTurnstile("", "1.2.3.4", "secret")).toBe(false);
    expect(await verifyTurnstile("tok", "1.2.3.4", "")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts secret + response + remoteip in the form body", async () => {
    let captured: FormData | null = null;
    mockFetch(async (_url, init) => {
      captured = init.body as FormData;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await verifyTurnstile("the-token", "9.9.9.9", "the-secret");
    expect(captured).toBeInstanceOf(FormData);
    expect(captured!.get("secret")).toBe("the-secret");
    expect(captured!.get("response")).toBe("the-token");
    expect(captured!.get("remoteip")).toBe("9.9.9.9");
  });
});

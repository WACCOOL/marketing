import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBflAdapter } from "./bfl.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const apiKey = "test-bfl-key";
const baseUrl = "https://bfl.test";
const pollingUrl = "https://bfl.test/v1/get_result?id=abc-123";
const sampleUrl = "https://delivery.bfl.test/abc-123/sample.png";
const resultBytes = Buffer.from("the-final-png-bytes");

describe("makeBflAdapter.inpaint", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits, polls the returned polling_url, and downloads the sample", async () => {
    fetchMock
      // submit
      .mockResolvedValueOnce(jsonResponse({ id: "abc-123", polling_url: pollingUrl }))
      // poll #1 — not ready yet
      .mockResolvedValueOnce(jsonResponse({ status: "Pending", result: null }))
      // poll #2 — ready
      .mockResolvedValueOnce(
        jsonResponse({ status: "Ready", result: { sample: sampleUrl } }),
      )
      // download
      .mockResolvedValueOnce(
        new Response(resultBytes, { status: 200, headers: { "content-type": "image/png" } }),
      );

    const adapter = makeBflAdapter({ apiKey, baseUrl });
    const out = await adapter.inpaint({
      image: Buffer.from("base-image"),
      mask: Buffer.from("mask-image"),
      prompt: "soft contact shadow under the fixture",
      steps: 30,
    });

    expect(out.equals(resultBytes)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Submit: correct endpoint, x-key auth, base64 image/mask, prompt + steps.
    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!;
    expect(submitUrl).toBe(`${baseUrl}/v1/flux-pro-1.0-fill`);
    expect((submitInit as RequestInit).method).toBe("POST");
    const submitHeaders = (submitInit as RequestInit).headers as Record<string, string>;
    expect(submitHeaders["x-key"]).toBe(apiKey);
    const submitBody = JSON.parse((submitInit as RequestInit).body as string);
    expect(submitBody.image).toBe(Buffer.from("base-image").toString("base64"));
    expect(submitBody.mask).toBe(Buffer.from("mask-image").toString("base64"));
    expect(submitBody.prompt).toBe("soft contact shadow under the fixture");
    expect(submitBody.steps).toBe(30);
    // Fill has no reference-image parameter.
    expect(submitBody.reference).toBeUndefined();
    expect(submitBody.image_prompt).toBeUndefined();

    // Polling hits the RETURNED polling_url (not a hand-built one).
    expect(fetchMock.mock.calls[1]![0]).toBe(pollingUrl);
    expect(fetchMock.mock.calls[2]![0]).toBe(pollingUrl);

    // Download hits the delivery sample URL.
    expect(fetchMock.mock.calls[3]![0]).toBe(sampleUrl);
  });

  it("throws when submit returns no polling_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "abc" }));
    const adapter = makeBflAdapter({ apiKey, baseUrl });
    await expect(
      adapter.inpaint({ image: Buffer.from("a"), mask: Buffer.from("b"), prompt: "p" }),
    ).rejects.toThrow(/no polling_url/);
  });

  it("throws on a terminal non-Ready status", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "abc", polling_url: pollingUrl }))
      .mockResolvedValueOnce(jsonResponse({ status: "Content Moderated" }));
    const adapter = makeBflAdapter({ apiKey, baseUrl });
    await expect(
      adapter.inpaint({ image: Buffer.from("a"), mask: Buffer.from("b"), prompt: "p" }),
    ).rejects.toThrow(/Content Moderated/);
  });
});

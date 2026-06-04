import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFalMatteAdapter } from "./fal.js";

const apiKey = "test-fal-key";
const baseUrl = "https://fal.test";
const cutoutBytes = Buffer.from("transparent-cutout-png-bytes");

describe("makeFalMatteAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits the source URL and downloads the returned transparent PNG", async () => {
    const resultUrl = "https://fal.test/storage/birefnet-output.png";
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ image: { url: resultUrl } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(cutoutBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );

    const adapter = makeFalMatteAdapter({ apiKey, baseUrl });
    const out = await adapter.matte({
      imageUrl: "https://cdn.example.com/fixture.jpg",
    });
    expect(out.equals(cutoutBytes)).toBe(true);

    const [submitUrl, init] = fetchMock.mock.calls[0]!;
    expect(submitUrl).toBe(`${baseUrl}/fal-ai/birefnet/v2`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Key ${apiKey}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.image_url).toBe("https://cdn.example.com/fixture.jpg");
    expect(body.output_format).toBe("png");

    // Second call downloads the result image.
    expect(fetchMock.mock.calls[1]![0]).toBe(resultUrl);
  });

  it("throws when the response has no image url", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ image: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = makeFalMatteAdapter({ apiKey, baseUrl });
    await expect(
      adapter.matte({ imageUrl: "https://cdn.example.com/x.jpg" }),
    ).rejects.toThrow(/no image url/);
  });

  it("throws on a non-2xx submit", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const adapter = makeFalMatteAdapter({ apiKey, baseUrl });
    await expect(
      adapter.matte({ imageUrl: "https://cdn.example.com/x.jpg" }),
    ).rejects.toThrow(/fal BiRefNet failed 500/);
  });
});

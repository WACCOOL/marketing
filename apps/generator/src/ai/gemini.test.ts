import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGeminiAdapter } from "./gemini.js";

const apiKey = "test-gemini-key";
const baseUrl = "https://gemini.test";
const outBytes = Buffer.from("harmonized-image-bytes");

function imageResponse(buf: Buffer): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "Done." },
              { inlineData: { mimeType: "image/png", data: buf.toString("base64") } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("makeGeminiAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("harmonize sends an image part + prompt and decodes the returned image", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse(outBytes));
    const adapter = makeGeminiAdapter({ apiKey, baseUrl });

    const out = await adapter.harmonize({
      image: Buffer.from("\x89PNG\r\n\x1a\n source"),
      prompt: "harmonize the lighting and shadows in this interior scene",
    });
    expect(out.equals(outBytes)).toBe(true);

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(`${baseUrl}/v1beta/models/gemini-2.5-flash-image:generateContent`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(apiKey);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    const parts = body.contents[0].parts;
    expect(parts[0].inline_data.mime_type).toBe("image/png");
    expect(parts[1].text).toContain("harmonize the lighting");
  });

  it("generate sends the prompt first then reference image parts", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse(outBytes));
    const adapter = makeGeminiAdapter({ apiKey, baseUrl });

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]);
    const out = await adapter.generate({
      prompt: "a modern lobby inspired by these fixtures",
      referenceImages: [jpeg],
    });
    expect(out.equals(outBytes)).toBe(true);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const parts = body.contents[0].parts;
    expect(parts[0].text).toContain("modern lobby");
    expect(parts[1].inline_data.mime_type).toBe("image/jpeg");
  });

  it("generate threads model + imageConfig (aspectRatio/imageSize) through to the request", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse(outBytes));
    const adapter = makeGeminiAdapter({ apiKey, baseUrl });

    await adapter.generate({
      prompt: "an empty modern kitchen, no fixtures",
      aspectRatio: "16:9",
      imageSize: "4K",
      model: "gemini-3-pro-image",
    });

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(`${baseUrl}/v1beta/models/gemini-3-pro-image:generateContent`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.generationConfig.imageConfig).toEqual({
      aspectRatio: "16:9",
      imageSize: "4K",
    });
  });

  it("throws when the response has no image part", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = makeGeminiAdapter({ apiKey, baseUrl });
    await expect(adapter.harmonize({ image: Buffer.from("x"), prompt: "p" })).rejects.toThrow(
      /no image part/,
    );
  });
});

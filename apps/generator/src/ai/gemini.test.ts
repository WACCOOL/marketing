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

  it("segment posts a JSON segmentation request and parses masks", async () => {
    // Mask payloads must be base64 PNGs (header base64s to "iVBORw0KGgo");
    // non-PNG strings are rejected by parseMasks.
    const maskList = [
      {
        box_2d: [10, 20, 900, 800],
        mask: "data:image/png;base64,iVBORw0KGgoAAA1",
        label: "lamp",
      },
      { box_2d: [0, 0, 100, 100], mask: "iVBORw0KGgoBBB2" },
      // Garbage payload — must be dropped, not parsed.
      { box_2d: [0, 0, 10, 10], mask: "not-a-png" },
    ];
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(maskList) }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = makeGeminiAdapter({ apiKey, baseUrl });

    const masks = await adapter.segment(Buffer.from("\x89PNG source"));

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(`${baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
    expect(masks).toHaveLength(2); // the garbage payload is dropped
    expect(masks[0]!.box2d).toEqual([10, 20, 900, 800]);
    // The data: prefix is stripped so callers can base64-decode directly.
    expect(masks[0]!.maskPngBase64).toBe("iVBORw0KGgoAAA1");
    expect(masks[0]!.label).toBe("lamp");
    expect(masks[1]!.maskPngBase64).toBe("iVBORw0KGgoBBB2");
  });

  it("segment honors a custom segmentModel", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = makeGeminiAdapter({ apiKey, baseUrl, segmentModel: "gemini-x" });
    await adapter.segment(Buffer.from("x"));
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${baseUrl}/v1beta/models/gemini-x:generateContent`,
    );
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

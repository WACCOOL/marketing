import { describe, expect, it } from "vitest";
import { parseSSEBuffer } from "./sse.js";

/** Frame an event the way hono's streamSSE writes it. */
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("parseSSEBuffer", () => {
  it("parses a single complete frame and leaves no remainder", () => {
    const { frames, rest } = parseSSEBuffer(frame("meta", { conversationId: "c1" }));
    expect(rest).toBe("");
    expect(frames).toEqual([{ event: "meta", data: '{"conversationId":"c1"}' }]);
  });

  it("parses multiple frames in one buffer", () => {
    const buf =
      frame("meta", { conversationId: "c1" }) +
      frame("text", { text: "Hel" }) +
      frame("text", { text: "lo" });
    const { frames, rest } = parseSSEBuffer(buf);
    expect(rest).toBe("");
    expect(frames.map((f) => f.event)).toEqual(["meta", "text", "text"]);
    expect(frames[2]?.data).toBe('{"text":"lo"}');
  });

  it("holds back a trailing partial frame as rest", () => {
    const complete = frame("text", { text: "a" });
    const partial = "event: text\ndata: {\"text\":\"b"; // no terminating blank line
    const { frames, rest } = parseSSEBuffer(complete + partial);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "text", data: '{"text":"a"}' });
    expect(rest).toBe(partial);
  });

  it("reassembles a frame split across two chunks via rest", () => {
    const full = frame("text", { text: "chunked" });
    const cut = 10; // split mid-frame
    const first = parseSSEBuffer(full.slice(0, cut));
    expect(first.frames).toEqual([]); // nothing complete yet
    const second = parseSSEBuffer(first.rest + full.slice(cut));
    expect(second.frames).toEqual([{ event: "text", data: '{"text":"chunked"}' }]);
    expect(second.rest).toBe("");
  });

  it("defaults event to 'message' when no event: line is present", () => {
    const { frames } = parseSSEBuffer('data: {"x":1}\n\n');
    expect(frames).toEqual([{ event: "message", data: '{"x":1}' }]);
  });

  it("tolerates a data: line with no leading space", () => {
    const { frames } = parseSSEBuffer("event: text\ndata:{\"text\":\"z\"}\n\n");
    expect(frames[0]).toEqual({ event: "text", data: '{"text":"z"}' });
  });

  it("joins multi-line data: fields", () => {
    const { frames } = parseSSEBuffer("event: text\ndata: line1\ndata: line2\n\n");
    expect(frames[0]).toEqual({ event: "text", data: "line1\nline2" });
  });

  it("drops blank keep-alive separators and frames with no data", () => {
    const buf = "\n\n" + "event: ping\n\n" + frame("done", { usage: {} });
    const { frames } = parseSSEBuffer(buf);
    // ping has no data line → dropped; only done survives.
    expect(frames).toEqual([{ event: "done", data: '{"usage":{}}' }]);
  });

  it("carries every event kind through unchanged (meta/text/cards/citations/done/error + unknown)", () => {
    const buf =
      frame("meta", { conversationId: "c1" }) +
      frame("text", { text: "hi" }) +
      frame("cards", { cards: [] }) +
      frame("citations", { citations: [] }) +
      frame("mystery", { anything: true }) +
      frame("done", { usage: {} }) +
      frame("error", { error: "boom" });
    const { frames } = parseSSEBuffer(buf);
    expect(frames.map((f) => f.event)).toEqual([
      "meta",
      "text",
      "cards",
      "citations",
      "mystery",
      "done",
      "error",
    ]);
  });
});

/**
 * Pure Server-Sent-Events frame parsing, shared so it can be unit-tested
 * outside the browser bundle. Used by the Thom streaming chat client
 * (apps/web) to decode the `/api/thom/chat/stream` SSE body.
 */

/** One parsed SSE frame. `event` defaults to "message" when the frame omits an
 *  `event:` line (per the SSE spec). */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Given the running decode buffer, split off every COMPLETE frame (frames are
 * separated by a blank line) and return the parsed frames plus the trailing
 * partial to carry into the next chunk. Pure and incremental: it handles frames
 * split across chunks (the caller keeps `rest` and prepends the next chunk),
 * multiple frames per chunk, and multi-line `data:` fields. Frames with no
 * `data:` line (e.g. bare keep-alives) are dropped.
 */
export function parseSSEBuffer(buffer: string): { frames: SSEFrame[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? ""; // trailing partial frame (or "" if buffer ended on \n\n)
  const frames: SSEFrame[] = [];
  for (const part of parts) {
    if (!part.trim()) continue; // skip blank keep-alive separators
    let event = "message";
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

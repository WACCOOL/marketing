/**
 * Minimal HTML → plain-text for ZenDesk Help Center article bodies (which are
 * authored HTML). Pure, dependency-free, and deterministic so it can be unit
 * tested without a DOM.
 *
 * Goals (in order): drop non-content (script/style), turn block-level structure
 * (paragraphs, list items, headings, table rows, <br>) into newlines so the
 * downstream chunker splits on real boundaries, strip the remaining tags,
 * decode the HTML entities we actually see, and collapse runaway whitespace.
 *
 * Not a general-purpose sanitizer — it only needs to produce clean retrieval
 * text, never to round-trip or render.
 */

// Named entities we expect in Help Center copy. Mirrors the small table in
// apps/api/src/saleslayer.ts (decodeEntities) plus a few typographic ones.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

/** Decode the named + numeric (&#NN; / &#xHH;) HTML entities we care about. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : match;
  });
}

// Block-level tags whose close (or self) should force a line break so distinct
// paragraphs/items don't run together into one blob.
const BLOCK_TAGS =
  "address|article|aside|blockquote|div|dl|dd|dt|fieldset|figcaption|figure|" +
  "footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|thead|" +
  "tfoot|tr|ul";

/**
 * Convert an HTML fragment to plain text with paragraph/list/heading structure
 * preserved as newlines.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;

  // 1) Drop elements whose text content is not article prose.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // 2) Explicit line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // 3) Block boundaries -> newline (both the opening and closing tag, so an
  //    unclosed <li> still breaks). List items get a leading bullet marker.
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(new RegExp(`</?(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, "gi"), "\n");

  // 4) Strip any remaining tags.
  s = s.replace(/<[^>]+>/g, "");

  // 5) Decode entities (after tag strip so a literal "&lt;" survives).
  s = decodeEntities(s);

  // 6) Collapse whitespace: normalize spaces/tabs on each line, drop trailing
  //    spaces, and cap consecutive blank lines at one.
  s = s.replace(/[^\S\n]+/g, " "); // runs of non-newline whitespace -> single space
  s = s.replace(/ *\n */g, "\n"); // trim around newlines
  s = s.replace(/\n{3,}/g, "\n\n"); // >=3 newlines -> a single blank line
  return s.trim();
}

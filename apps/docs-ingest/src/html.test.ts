import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "./html.js";

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &quot;x&quot; &nbsp;end")).toBe(
      'Tom & Jerry <3 "x"  end',
    );
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeEntities("A&#66;C")).toBe("ABC");
    expect(decodeEntities("&#x41;&#x42;")).toBe("AB");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("&bogus; &notreal;")).toBe("&bogus; &notreal;");
  });
});

describe("htmlToText", () => {
  it("strips tags", () => {
    expect(htmlToText("<span>hello</span>")).toBe("hello");
  });

  it("drops script and style content", () => {
    const html = "<p>keep</p><script>var x=1;</script><style>.a{color:red}</style><p>me</p>";
    const out = htmlToText(html);
    expect(out).toContain("keep");
    expect(out).toContain("me");
    expect(out).not.toContain("var x");
    expect(out).not.toContain("color:red");
  });

  it("turns paragraphs and headings into blank-line-separated blocks", () => {
    // Adjacent block boundaries collapse to a single blank line (a paragraph
    // break) — the boundary chunkText prefers to split on.
    const out = htmlToText("<h1>Title</h1><p>First para.</p><p>Second para.</p>");
    expect(out).toBe("Title\n\nFirst para.\n\nSecond para.");
  });

  it("renders list items with bullet markers", () => {
    const out = htmlToText("<ul><li>alpha</li><li>beta</li></ul>");
    expect(out).toBe("- alpha\n\n- beta");
  });

  it("converts <br> to newlines", () => {
    expect(htmlToText("line one<br>line two<br/>line three")).toBe(
      "line one\nline two\nline three",
    );
  });

  it("decodes entities after stripping tags", () => {
    expect(htmlToText("<p>A &amp; B &mdash; C</p>")).toBe("A & B — C");
  });

  it("collapses runaway blank lines to a single blank line", () => {
    const out = htmlToText("<p>a</p>\n\n\n\n<p>b</p>");
    expect(out).toBe("a\n\nb");
  });

  it("collapses inner runs of spaces/tabs to a single space", () => {
    expect(htmlToText("<p>c   \t  d</p>")).toBe("c d");
  });

  it("returns empty string for empty/null-ish input", () => {
    expect(htmlToText("")).toBe("");
  });
});

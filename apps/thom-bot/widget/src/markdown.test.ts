import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml } from "./markdown.js";

describe("renderMarkdown", () => {
  it("escapes HTML so model/KB markup can't inject nodes", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders bold, italic, and inline code", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("say *hi*")).toContain("<em>hi</em>");
    expect(renderMarkdown("use `code`")).toContain("<code>code</code>");
  });

  it("links only http(s) URLs and forces safe rel/target", () => {
    const ok = renderMarkdown("[spec](https://waclighting.com/x)");
    expect(ok).toContain('href="https://waclighting.com/x"');
    expect(ok).toContain('target="_blank"');
    expect(ok).toContain('rel="noopener noreferrer"');
  });

  it("does NOT create an anchor for javascript: (or other non-http) schemes", () => {
    const out = renderMarkdown("[x](javascript:alert(1))");
    // No anchor is produced; the markdown stays as inert escaped text.
    expect(out).not.toContain("<a ");
    expect(out).not.toContain('href="javascript:');
  });

  it("renders unordered + ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders headings and fenced code blocks", () => {
    expect(renderMarkdown("## Title")).toContain("<h2>Title</h2>");
    expect(renderMarkdown("```\nx = 1\n```")).toContain("<pre><code>x = 1</code></pre>");
  });

  it("escapeHtml handles all five significant chars", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("renders a GFM table (header + separator + rows) inside a scroll wrapper", () => {
    const out = renderMarkdown("| SKU | Lumens |\n|---|---|\n| A | 1200 |\n| B | 900 |");
    expect(out).toContain('<div class="thom-table-wrap"><table>');
    expect(out).toContain("<thead><tr><th>SKU</th><th>Lumens</th></tr></thead>");
    expect(out).toContain("<tbody><tr><td>A</td><td>1200</td></tr><tr><td>B</td><td>900</td></tr></tbody>");
  });

  it("applies column alignment from the separator row", () => {
    const out = renderMarkdown("| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |");
    expect(out).toContain('<th style="text-align:left">a</th>');
    expect(out).toContain('<th style="text-align:center">b</th>');
    expect(out).toContain('<td style="text-align:right">3</td>');
  });

  it("renders inline formatting and escapes HTML inside cells", () => {
    const out = renderMarkdown("| Name | Note |\n|---|---|\n| **A** | <img src=x> |");
    expect(out).toContain("<td><strong>A</strong></td>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x&gt;");
  });

  it("degrades a partial table (no separator row yet) to plain paragraph text", () => {
    // Mid-stream state: the header row arrived but the |---| row hasn't.
    const out = renderMarkdown("| SKU | Lumens |");
    expect(out).not.toContain("<table>");
    expect(out).toContain("<p>| SKU | Lumens |</p>");
  });

  it("ends a table at a blank line instead of swallowing later pipe rows", () => {
    const out = renderMarkdown("| a |\n|---|\n| 1 |\n\ntext\n\n| stray |");
    expect(out).toContain("<tbody><tr><td>1</td></tr></tbody>");
    expect(out).toContain("<p>text</p>");
    expect(out).toContain("<p>| stray |</p>");
  });

  it("keeps escaped pipes as literal cell text", () => {
    const out = renderMarkdown("| a |\n|---|\n| x \\| y |");
    expect(out).toContain("<td>x | y</td>");
  });

  it("does not regress lists or bold around a table", () => {
    const out = renderMarkdown("- item\n\n| a |\n|---|\n| **b** |\n\n**tail**");
    expect(out).toContain("<ul><li>item</li></ul>");
    expect(out).toContain("<td><strong>b</strong></td>");
    expect(out).toContain("<p><strong>tail</strong></p>");
  });
});

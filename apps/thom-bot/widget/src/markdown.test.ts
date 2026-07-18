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
});

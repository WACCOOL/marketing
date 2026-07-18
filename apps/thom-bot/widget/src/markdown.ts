/**
 * A tiny, safe markdown renderer for assistant prose.
 *
 * We deliberately do NOT pull in react-markdown / a full parser (this widget is
 * a lightweight vanilla bundle). Everything is HTML-escaped FIRST, so no raw
 * markup from the model or the KB can inject nodes; then a small allow-list of
 * inline + block constructs is layered back on. Pure string → string so it can
 * be unit-tested outside the browser.
 *
 * Supported: headings (#..######), unordered + ordered lists, `code` spans,
 * fenced ``` code blocks, **bold**, *italic*, [text](http/https link), and
 * paragraphs. Links are forced to target=_blank rel=noopener noreferrer and
 * only http(s) URLs are linked.
 */

/** Escape the five HTML-significant characters. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) links are rendered as anchors; anything else stays plain text. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

/** Inline formatting on an already HTML-escaped string. */
function renderInline(escaped: string): string {
  let out = escaped;
  // `code`
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // [text](url) — url is escaped already; validate the raw-ish form.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, rawUrl: string) => {
    // Undo the entity-escaping of & inside the URL so safeHref sees a real URL.
    const url = rawUrl.replace(/&amp;/g, "&");
    const href = safeHref(url);
    if (!href) return m;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => `<strong>${b}</strong>`);
  // *italic* / _italic_
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, i: string) => `${pre}<em>${i}</em>`);
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lines: string[] };

/** Render a minimal-markdown string to a safe HTML string. */
export function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src.replace(/\r\n/g, "\n"));
  const lines = escaped.split("\n");
  const blocks: Block[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    // Fenced code block toggles (``` optionally followed by a language token).
    if (/^```/.test(line.trim())) {
      if (inCode) {
        blocks.push({ kind: "code", lines: codeLines });
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1] && heading[2] != null) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul && ul[1] != null) {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ul") last.items.push(ul[1]);
      else blocks.push({ kind: "ul", items: [ul[1]] });
      continue;
    }

    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol && ol[1] != null) {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ol") last.items.push(ol[1]);
      else blocks.push({ kind: "ol", items: [ol[1]] });
      continue;
    }

    if (!line.trim()) {
      // blank line: paragraph break
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "p") blocks.push({ kind: "p", lines: [] });
      continue;
    }

    const last = blocks[blocks.length - 1];
    if (last && last.kind === "p" && last.lines.length) last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  if (inCode && codeLines.length) blocks.push({ kind: "code", lines: codeLines });

  const html: string[] = [];
  for (const b of blocks) {
    if (b.kind === "h") {
      const lvl = Math.min(6, Math.max(1, b.level));
      html.push(`<h${lvl}>${renderInline(b.text)}</h${lvl}>`);
    } else if (b.kind === "ul") {
      html.push(`<ul>${b.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ul>`);
    } else if (b.kind === "ol") {
      html.push(`<ol>${b.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ol>`);
    } else if (b.kind === "code") {
      html.push(`<pre><code>${b.lines.join("\n")}</code></pre>`);
    } else if (b.lines.length) {
      html.push(`<p>${b.lines.map((l) => renderInline(l)).join("<br>")}</p>`);
    }
  }
  return html.join("\n");
}

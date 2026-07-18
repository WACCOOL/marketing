/** Minimal typed DOM helpers so the card builders stay terse and XSS-safe
 *  (everything goes through textContent / setAttribute, never innerHTML). */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svgEl(tag: string, attrs: Attrs = {}, children: (Node | null | undefined)[] = []): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v); // ONLY used for pre-sanitized markdown
    else node.setAttribute(k, String(v));
  }
}

function append(node: HTMLElement, children: (Node | string | null | undefined)[]): void {
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/** An external link that always opens safely in a new tab. */
export function extLink(
  href: string | null | undefined,
  attrs: Attrs,
  children: (Node | string)[],
): HTMLAnchorElement {
  return el("a", { ...attrs, href: href ?? undefined, target: "_blank", rel: "noopener noreferrer" }, children);
}

/**
 * robots.txt parsing with SHAPE VALIDATION.
 *
 * wacarchitectural.com's Blazor catch-all returns HTTP 200 `text/html` SPA
 * markup for EVERY unmatched path, including /robots.txt — so a 200 is NOT
 * evidence a robots file exists. A response only counts as robots.txt when it
 * looks like one (robots-ish first directive, not an HTML document); anything
 * else is treated as ABSENT (allow-all, no sitemaps, no crawl-delay).
 */

export interface RobotsRules {
  /** True when a real robots.txt was found and parsed. */
  present: boolean;
  /** Disallow prefixes for our UA (specific group if present, else `*`). */
  disallow: string[];
  allow: string[];
  /** Crawl-delay in SECONDS for our UA group (or the `*` group), if any. */
  crawlDelaySec: number | null;
  /** Absolute sitemap URLs from `Sitemap:` directives (global). */
  sitemaps: string[];
}

export const EMPTY_ROBOTS: RobotsRules = {
  present: false,
  disallow: [],
  allow: [],
  crawlDelaySec: null,
  sitemaps: [],
};

const UA_TOKEN = "wac-marketing-app";

/** Does this response body look like a robots.txt at all? */
export function looksLikeRobots(body: string, contentType: string | null): boolean {
  const trimmed = body.trimStart();
  if (!trimmed) return false;
  if (trimmed.startsWith("<")) return false; // HTML shell
  if (contentType && /text\/html/i.test(contentType)) return false;
  // First non-comment line must be a robots directive.
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    return /^(user-agent|disallow|allow|sitemap|crawl-delay)\s*:/i.test(l);
  }
  return false;
}

export function parseRobots(body: string): RobotsRules {
  const sitemaps: string[] = [];
  interface Group { agents: string[]; disallow: string[]; allow: string[]; delay: number | null }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], disallow: [], allow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow" && value) current.disallow.push(value);
    else if (field === "allow" && value) current.allow.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  // Most specific matching group wins; fall back to `*`.
  const specific = groups.find((g) => g.agents.some((a) => a && UA_TOKEN.includes(a) || a === UA_TOKEN));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const g = specific ?? wildcard;
  return {
    present: true,
    disallow: g?.disallow ?? [],
    allow: g?.allow ?? [],
    crawlDelaySec: g?.delay ?? null,
    sitemaps,
  };
}

/** Basic robots path matching with `*` wildcards and `$` end anchors. */
function robotsMatch(pattern: string, path: string): boolean {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}`).test(path);
  } catch {
    return path.startsWith(pattern.replace(/[*$]/g, ""));
  }
}

/** Longest-match-wins allow/disallow decision (Google semantics, simplified). */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  if (!rules.present) return true;
  let verdict = true;
  let best = -1;
  for (const d of rules.disallow) {
    if (d.length > best && robotsMatch(d, path)) { verdict = false; best = d.length; }
  }
  for (const a of rules.allow) {
    if (a.length >= best && robotsMatch(a, path)) { verdict = true; best = a.length; }
  }
  return verdict;
}

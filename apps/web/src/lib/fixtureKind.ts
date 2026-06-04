import type { FixtureMount } from "@wac/shared";

/**
 * Derive a fixture's mount surface + a human-readable type from its Sales Layer
 * category/name. Used to (a) make generated scenes fixture-aware (leave space on
 * the right surface) and (b) drive auto-placement. Keyword-based and best-effort
 * — the user can always override the mount in the UI.
 */
export interface FixtureKind {
  mount: FixtureMount;
  fixtureType: string;
}

interface Rule {
  match: RegExp;
  mount: FixtureMount;
  type: string;
}

// Ordered most-specific first; the first match wins.
const RULES: Rule[] = [
  { match: /ceiling fan|\bfan\b/, mount: "ceiling", type: "ceiling fan" },
  { match: /chandelier/, mount: "ceiling", type: "chandelier" },
  { match: /linear|island|billiard/, mount: "ceiling", type: "linear pendant" },
  { match: /pendant/, mount: "ceiling", type: "pendant light" },
  { match: /flush|semi.?flush/, mount: "ceiling", type: "flush mount light" },
  { match: /recess|downlight|down light|can light/, mount: "recessed", type: "recessed downlight" },
  { match: /track|monorail/, mount: "ceiling", type: "track light" },
  { match: /vanity|bath bar/, mount: "wall", type: "vanity light" },
  { match: /sconce/, mount: "wall", type: "wall sconce" },
  { match: /under.?cabinet|tape|strip|cove/, mount: "wall", type: "under-cabinet light" },
  { match: /wall/, mount: "wall", type: "wall light" },
  { match: /landscape|path|bollard|in.?grade|step|deck|outdoor/, mount: "floor", type: "landscape light" },
  { match: /floor lamp/, mount: "floor", type: "floor lamp" },
  { match: /table lamp|desk lamp/, mount: "floor", type: "table lamp" },
];

export function deriveFixtureKind(
  category?: string | null,
  name?: string | null,
): FixtureKind {
  const text = `${category ?? ""} ${name ?? ""}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { mount: rule.mount, fixtureType: rule.type };
    }
  }
  // Default: most WAC product imagery is ceiling-mounted lighting.
  return { mount: "ceiling", fixtureType: "light fixture" };
}

export const MOUNT_LABELS: Record<FixtureMount, string> = {
  ceiling: "Ceiling",
  wall: "Wall",
  floor: "Floor",
  recessed: "Recessed (ceiling)",
};

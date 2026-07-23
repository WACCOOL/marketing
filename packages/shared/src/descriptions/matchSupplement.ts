/**
 * Descriptions — supplemental pptx/pdf parsing + matching (plan §4, Stage 2).
 *
 * Inputs are already-extracted primitives (pptx paragraph texts per slide,
 * pdf text lines per page) so the same code runs in the browser, the Worker
 * (server-side re-match on either side's re-import) and vitest.
 *
 * Matching priority per unit, against the paired master slot's groups only:
 *   1. model-base intersection — a single hit wins outright; a multi-hit is
 *      ambiguous and stays unmatched (never guess).
 *   2. name — case-folded exact, then fuzzy (Levenshtein ≤ 2 or shared
 *      prefix ≥ 5) for the deck/pdf spelling drift the sources exhibit.
 *   3. else unmatched, listed with the slide/page reference.
 */

import { expandModelRange, modelBase } from "./parseMaster.js";

// ---------------------------------------------------------------------------
// Model tokens
// ---------------------------------------------------------------------------

/**
 * A model token as written in the deck/pdf: 2–3 letter prefix, 5–6 digits,
 * optional compact ranges (`/24`), optional trailing R variant letter, and
 * an optional finish/collection suffix chain (`-BK/AB`, `-TWA-XX`).
 */
const MODEL_TOKEN_RE =
  /\b[A-Z]{2,3}\d{5,6}(?:\/\d{2,3})*R?(?:-[A-Z0-9]{2,4}(?:[/-][A-Z0-9]{2,4})*)?(?!\d)/g;

/** All model tokens in a text, expanded (`AB12316/24-BK` → both models). */
export function extractModels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MODEL_TOKEN_RE)) {
    for (const model of expandModelRange(m[0])) {
      const key = model.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }
  return out;
}

function stripModels(text: string): string {
  return text.replace(MODEL_TOKEN_RE, " ");
}

function basesOf(models: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const b = modelBase(m);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared unit shape
// ---------------------------------------------------------------------------

/** One parsed supplemental unit, pre-upload (imageIds are extractor-local). */
export interface ParsedSupplementUnit {
  ref: string;
  name: string | null;
  models: string[];
  modelBases: string[];
  bullets: string[];
  imageIds: string[];
}

export interface ParseSupplementOutcome {
  units: ParsedSupplementUnit[];
  /** Human-readable notes for slides/pages deliberately not imported. */
  skipped: string[];
}

const MAX_BULLETS = 16;

function dedupePush(list: string[], v: string): void {
  const key = v.toLowerCase();
  if (list.some((x) => x.toLowerCase() === key)) return;
  list.push(v);
}

// ---------------------------------------------------------------------------
// pptx lane (Dweled introductions deck)
// ---------------------------------------------------------------------------

export interface PptxSlideInput {
  /** 1-based slide number. */
  index: number;
  /** Paragraph texts (runs already joined per paragraph). */
  paragraphs: string[];
  /** Extractor-local ids of images placed on the slide, in placement order. */
  imageIds: string[];
}

/** Segments never eligible as the product name (deck furniture). */
const NAME_NOISE = new Set(["inspiration", "big player", "pending", "wac home"]);

/** Pure finish-code segments (`BK`, `AB & BN`, `BK/GO & WT/GO`) — structured
 * data the master already carries, dropped from bullets. */
const FINISH_SEG_RE = /^[A-Z]{2,4}(?:\s*[/&,]\s*[A-Z]{2,4})*$/;

/**
 * Pure size segments (`26inches`, `18/24 INCHES`, `10 & 15 Inches`) — the
 * master's L/W/H columns already carry sizes; these are not feature bullets.
 * A segment is size-only when nothing but digits/punctuation remains after
 * removing the unit words ("3 Light 6/9/14inch" keeps its "Light" and stays).
 */
function isSizeSegment(s: string): boolean {
  const residual = s.replace(/inches|inch|in\b/gi, "");
  return residual !== s && /^[\d\s/.,&"–-]*$/.test(residual);
}

/**
 * A deck product name, primary shape: 1–3 ALL-CAPS words (finish codes are
 * shorter; feature bullets are mixed-case). XML paragraph order is not the
 * visual order, so the shape must be strict enough to be order-independent.
 */
const CAPS_NAME_RE = /^[A-Z]{3,}(?: [A-Z]{2,}){0,2}$/;

/** Secondary shape: one word with interior capitals (stylised names). */
const STYLIZED_NAME_RE = /^[A-Za-z]+$/;
const hasInteriorCaps = (s: string) => /[A-Z]/.test(s.slice(1)) && /[a-z]/.test(s);

function cleanSegment(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|/&,.?]+/, "")
    .replace(/[\s\-–—|/&,.?]+$/, "")
    .trim();
}

/**
 * Parse deck slides into supplemental units. Slides with no model tokens
 * (title/section slides) are skipped. The name is the LAST alpha segment
 * that is not deck furniture — the deck consistently puts the product name
 * at the end, after the model numbers.
 */
export function parsePptxSlides(slides: readonly PptxSlideInput[]): ParseSupplementOutcome {
  const units: ParsedSupplementUnit[] = [];
  const skipped: string[] = [];

  for (const slide of slides) {
    const joined = slide.paragraphs.join(" ");
    const models = extractModels(joined);

    const segments: { text: string; fromModelPara: boolean }[] = [];
    for (const p of slide.paragraphs) {
      const fromModelPara = stripModels(p) !== p;
      const text = cleanSegment(stripModels(p));
      if (text.length > 0) segments.push({ text, fromModelPara });
    }

    // Name selection is order-independent by shape (XML paragraph order is
    // not the visual order): a trailing ALL-CAPS run in a model paragraph
    // ("AB12345-BK ZORVIT") is the strongest signal, then a standalone
    // all-caps segment, then a stylised single word.
    let modelParaName: string | null = null;
    let capsName: string | null = null;
    let stylized: string | null = null;
    for (const { text: rawText, fromModelPara } of segments) {
      // "PENDING" is a model-cell placeholder that can share a paragraph
      // with the name — drop it before shape-testing.
      const text = cleanSegment(rawText.replace(/\bPENDING\b/g, " "));
      if (!text || NAME_NOISE.has(text.toLowerCase())) continue;
      if (fromModelPara) {
        const run = /(?:^|[^A-Za-z])([A-Z]{3,}(?: [A-Z]{2,}){0,2})$/.exec(text);
        if (run && !NAME_NOISE.has(run[1]!.toLowerCase())) {
          modelParaName = run[1]!;
          continue;
        }
      }
      if (text.length < 4) continue; // bare finish codes
      if (CAPS_NAME_RE.test(text)) capsName = text; // last qualifying wins
      else if (STYLIZED_NAME_RE.test(text) && hasInteriorCaps(text)) stylized = text;
    }
    const name = modelParaName ?? capsName ?? stylized;

    // Section/title slides carry one lone text (no models, nothing else) and
    // are skipped. A model-LESS product slide (model cell still pending) with
    // a real name and several info paragraphs becomes a name-only unit.
    if (models.length === 0 && (!name || segments.length < 3)) {
      const label = cleanSegment(slide.paragraphs[0] ?? "") || "(no text)";
      skipped.push(
        `slide ${slide.index}: "${label.slice(0, 60)}" has no model numbers; skipped`,
      );
      continue;
    }

    const bullets: string[] = [];
    for (const { text: rawText, fromModelPara } of segments) {
      if (bullets.length >= MAX_BULLETS) break;
      if (fromModelPara) continue; // model list (+ trailing name) — structured
      const text = cleanSegment(rawText.replace(/\bPENDING\b/g, " "));
      if (!text) continue;
      if (name && text.toLowerCase() === name.toLowerCase()) continue;
      if (NAME_NOISE.has(text.toLowerCase())) continue;
      if (FINISH_SEG_RE.test(text)) continue;
      if (isSizeSegment(text)) continue;
      if (text.length < 2) continue;
      dedupePush(bullets, text.slice(0, 500));
    }

    units.push({
      ref: `slide ${slide.index}`,
      name,
      models,
      modelBases: basesOf(models),
      bullets,
      imageIds: [...slide.imageIds],
    });
  }

  return { units, skipped };
}

// ---------------------------------------------------------------------------
// MF pdf lane (naming pdf: model list, "Name:", "- " bullets)
// ---------------------------------------------------------------------------

export interface PdfPageInput {
  /** 1-based page number. */
  index: number;
  /** Text lines in reading order (pdf.js EOL-split). */
  lines: string[];
}

const BRAND_HEADER_RE = /^Modern Forms\.?\s*A WAC Group Brand\.?$/i;
const BULLET_START_RE = /^[-–—]\s*(.+)$/;
const NAME_RE = /Name:\s*([A-Za-z][A-Za-z' ]*[A-Za-z]|[A-Za-z])/;
const EXTENSION_NAME_RE = /[-–]\s*([A-Z][A-Za-z]+)\s+Extension\b/;

/**
 * Parse MF naming-pdf pages into units. Section pages (no models) and
 * collection summary pages (all-caps COLLECTION headline listing several
 * products) are skipped — the latter would otherwise mis-overlay a matched
 * product's bullets with collection blurb.
 */
export function parseMfPdfPages(pages: readonly PdfPageInput[]): ParseSupplementOutcome {
  const units: ParsedSupplementUnit[] = [];
  const skipped: string[] = [];

  for (const page of pages) {
    const lines = page.lines
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0 && !BRAND_HEADER_RE.test(l));
    const rawText = lines.join("\n");
    const models = extractModels(rawText);
    if (models.length === 0) {
      const label = lines[0] ?? "(no text)";
      skipped.push(`page ${page.index}: "${label.slice(0, 60)}" has no model numbers; skipped`);
      continue;
    }
    if (/\bCOLLECTIONS?\b/.test(rawText)) {
      skipped.push(`page ${page.index}: collection summary page; skipped`);
      continue;
    }

    // "Name:" sometimes ends a line with the name on the next one.
    const nameText = rawText.replace(/Name:\s*\n\s*/g, "Name: ");
    const nameMatch = NAME_RE.exec(nameText);
    const extMatch = nameMatch ? null : EXTENSION_NAME_RE.exec(rawText);
    const name = nameMatch
      ? nameMatch[1]!.trim()
      : extMatch
        ? extMatch[1]!.trim()
        : null;

    const bullets: string[] = [];
    let current: string | null = null;
    const push = () => {
      if (current && bullets.length < MAX_BULLETS) dedupePush(bullets, current.slice(0, 500));
      current = null;
    };
    for (const line of lines) {
      const b = BULLET_START_RE.exec(line);
      if (b) {
        push();
        current = b[1]!.trim();
        continue;
      }
      // Continuation of a wrapped bullet — after dropping model tokens and
      // any Name: fragment, whatever remains belongs to the open bullet.
      const residual = cleanSegment(stripModels(line.replace(/Name:.*$/, "")));
      if (residual && current) current += ` ${residual}`;
    }
    push();

    units.push({
      ref: `page ${page.index}`,
      name,
      models,
      modelBases: basesOf(models),
      bullets,
      imageIds: [],
    });
  }

  return { units, skipped };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface SupplementGroup {
  content_key: string;
  name: string | null;
  model_bases: readonly string[];
}

export interface UnitMatch<U> {
  unit: U;
  /**
   * Matched groups — usually one. Several when a single family page/slide
   * lists model bases spanning sibling groups that share one product name
   * (e.g. a sconce + pendant + post-mount family): the overlay applies to
   * every covered sibling.
   */
  content_keys: string[];
  via?: "model" | "name";
  reason?: string;
}

/** Classic Levenshtein distance (names are short; no banding needed). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n]!;
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

const fold = (s: string) => s.trim().toLowerCase();

/**
 * Match units against the paired master's groups. Every ambiguity is an
 * explicit unmatched outcome with a reason — the import summary and slot
 * card surface these for a human.
 */
export function matchSupplementUnits<
  U extends { name: string | null; modelBases: readonly string[] },
>(units: readonly U[], groups: readonly SupplementGroup[]): UnitMatch<U>[] {
  const byBase = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const base of g.model_bases) {
      const key = base.toUpperCase();
      const set = byBase.get(key) ?? new Set<string>();
      set.add(g.content_key);
      byBase.set(key, set);
    }
  }
  const byKey = new Map(groups.map((g) => [g.content_key, g]));

  const nameClose = (a: string, b: string) =>
    levenshtein(a, b) <= 2 || commonPrefixLen(a, b) >= 5;

  return units.map((unit) => {
    // 1. model-base intersection
    const hits = new Set<string>();
    for (const base of unit.modelBases) {
      for (const key of byBase.get(base.toUpperCase()) ?? []) hits.add(key);
    }
    if (hits.size === 1) {
      return { unit, content_keys: [...hits], via: "model" as const };
    }
    if (hits.size > 1) {
      // A family page: its bases cover several master groups that all share
      // one name (a sconce/pendant/post-mount split). That is not ambiguous —
      // the page describes every covered sibling. Distinct names ARE
      // ambiguous and stay unmatched.
      const hitNames = new Set(
        [...hits].map((k) => fold(byKey.get(k)?.name ?? k)),
      );
      const sameName = hitNames.size === 1 ? [...hitNames][0]! : null;
      if (
        sameName &&
        (!unit.name || fold(unit.name) === sameName || nameClose(fold(unit.name), sameName))
      ) {
        return { unit, content_keys: [...hits], via: "model" as const };
      }
      const names = [...hits]
        .map((k) => byKey.get(k)?.name ?? k)
        .slice(0, 4)
        .join(", ");
      return {
        unit,
        content_keys: [],
        reason: `models match ${hits.size} products (${names}); ambiguous`,
      };
    }

    // 2. name matching
    if (!unit.name) {
      return {
        unit,
        content_keys: [],
        reason: "no model number matches the master list and no name was found",
      };
    }
    const target = fold(unit.name);
    const named = groups.filter((g) => g.name);
    const exact = named.filter((g) => fold(g.name!) === target);
    if (exact.length === 1) {
      return { unit, content_keys: [exact[0]!.content_key], via: "name" as const };
    }
    if (exact.length > 1) {
      return {
        unit,
        content_keys: [],
        reason: `name "${unit.name}" matches ${exact.length} products; ambiguous`,
      };
    }
    const fuzzy = named.filter((g) => nameClose(fold(g.name!), target));
    if (fuzzy.length === 1) {
      return { unit, content_keys: [fuzzy[0]!.content_key], via: "name" as const };
    }
    if (fuzzy.length > 1) {
      return {
        unit,
        content_keys: [],
        reason: `name "${unit.name}" is close to ${fuzzy.length} products; ambiguous`,
      };
    }
    return {
      unit,
      content_keys: [],
      reason: `no product matches models or name "${unit.name}"`,
    };
  });
}

// ---------------------------------------------------------------------------
// Overlay assembly + application
// ---------------------------------------------------------------------------

export interface SupplementOverlay {
  bullets: string[];
  imageKeys: string[];
  unitRefs: string[];
}

/**
 * Merge matched units per group (a product can span several slides/pages —
 * e.g. a sconce slide and a pendant slide of the same PPID): bullets and
 * images concatenate in unit order, deduplicated.
 */
export function buildSupplementOverlay(
  matches: readonly {
    content_key: string;
    ref: string;
    bullets: readonly string[];
    imageKeys: readonly string[];
  }[],
): Map<string, SupplementOverlay> {
  const out = new Map<string, SupplementOverlay>();
  for (const m of matches) {
    const cur = out.get(m.content_key) ?? {
      bullets: [],
      imageKeys: [],
      unitRefs: [],
    };
    for (const b of m.bullets) {
      if (cur.bullets.length >= MAX_BULLETS) break;
      dedupePush(cur.bullets, b);
    }
    for (const k of m.imageKeys) {
      if (!cur.imageKeys.includes(k)) cur.imageKeys.push(k);
    }
    cur.unitRefs.push(m.ref);
    out.set(m.content_key, cur);
  }
  return out;
}

export interface OverlayableProduct {
  features: string[];
  attributes: Record<string, unknown>;
}

/**
 * Replace a product's sheet features with the supplement bullets, keeping
 * the sheet originals in attributes.sheetFeatures (idempotent: a re-applied
 * overlay never mistakes previous bullets for sheet features).
 */
export function overlayFeatures<P extends OverlayableProduct>(
  product: P,
  bullets: readonly string[],
): P {
  const priorSheet = product.attributes["sheetFeatures"];
  const sheetFeatures = Array.isArray(priorSheet)
    ? (priorSheet as string[])
    : product.features;
  return {
    ...product,
    features: bullets.slice(0, MAX_BULLETS),
    attributes: { ...product.attributes, sheetFeatures },
  };
}

/** Undo an overlay: restore sheet features and drop the marker. */
export function clearFeatureOverlay<P extends OverlayableProduct>(product: P): P {
  const priorSheet = product.attributes["sheetFeatures"];
  if (!Array.isArray(priorSheet)) return product;
  const attributes = { ...product.attributes };
  delete attributes["sheetFeatures"];
  return { ...product, features: priorSheet as string[], attributes };
}

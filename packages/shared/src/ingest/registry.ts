/**
 * Marketing data ingestion — Source Registry (the spine of the feature).
 *
 * Every ingestable data source is one declarative `SourceDescriptor`. Both the
 * SPA (upload + observability pages) and the API (endpoint validation + queue
 * dispatch) import this registry, so the source list, accepted file types,
 * labels, and the future HubSpot destination map are a single source of truth
 * (the same way `BulkInputRowSchema` is shared today).
 *
 * This module is intentionally PURE/serializable: no `xlsx`, no DB client, no
 * Worker `Env`. The descriptor carries a `parserKey` STRING — the API resolves
 * it to the real parser at runtime (see apps/api) — so importing the registry
 * never drags SheetJS into the browser bundle.
 *
 * Adding a new source later is a small, well-defined change:
 *   1. append one `SourceDescriptor` here,
 *   2. add one `packages/shared/src/ingest/<source>.ts` parser (+ test),
 *   3. add one migration for its staging table,
 *   4. register the parser in the API parser map.
 */

const MB = 1024 * 1024;

/** Canonical Excel content-types (xlsx + legacy xls). */
export const EXCEL_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const EXCEL_XLS = "application/vnd.ms-excel";
export const EXCEL_CONTENT_TYPES = [EXCEL_XLSX, EXCEL_XLS] as const;

/**
 * automated = pushed by a Power Automate flow via the shared ingest token.
 * manual    = uploaded by an authenticated user through a GUI page.
 */
export type IngestAuthMode = "automated" | "manual";

/** Snapshot = each file fully replaces the prior staging rows for the source. */
export type ReconciliationMode = "snapshot" | "append";

/**
 * The FUTURE HubSpot destination, declared now and consumed by a SEPARATE,
 * later plan. Nothing in this codebase reads it yet — it exists so the eventual
 * push has one complete, intentional map to work from.
 */
export interface HubspotDestination {
  object:
    | "orders"
    | "line_items"
    | "rep_codes_custom_object"
    | "products"
    | "none";
  note?: string;
}

/** A single source may accept several distinct files (e.g. the 4 price books). */
export interface SourceVariant {
  key: string;
  label: string;
}

export interface SourceDescriptor {
  /** Stable key — URL segment, R2 prefix segment, and registry key. */
  key: string;
  /** Human label for the UI. */
  label: string;
  /** One-line description for the observability/upload pages. */
  description: string;
  authMode: IngestAuthMode;
  /** R2 inbox prefix segment (usually === key). */
  r2Prefix: string;
  /** Accepted upload content-types (drives extension + validation). */
  acceptedContentTypes: string[];
  /** Extension stamped onto the stored R2 object when content-type is generic. */
  defaultExt: string;
  /** Hard size cap enforced at the ingest boundary. */
  maxBytes: number;
  reconciliation: ReconciliationMode;
  /** Lookup key into the API-side parser map (NOT a function reference). */
  parserKey: string;
  /** Staging table(s) this source writes; the first is the primary. */
  stagingTables: string[];
  /** Declared-now, built-later HubSpot target. */
  hubspot: HubspotDestination;
  /**
   * Whether files land via the `/api/ingest` inbox. Sales Layer is cron-driven
   * (no inbox) but is still listed so the destination map / source list is
   * complete.
   */
  ingestable: boolean;
  /** Present when the source accepts multiple distinct files. */
  variants?: SourceVariant[];
}

export const SOURCES: Record<string, SourceDescriptor> = {
  "open-orders": {
    key: "open-orders",
    label: "Open Orders (SAP)",
    description:
      "Daily SAP export of open/unfulfilled orders at the line-item level, delivered by email and pushed in by Power Automate.",
    authMode: "automated",
    r2Prefix: "open-orders",
    acceptedContentTypes: [...EXCEL_CONTENT_TYPES],
    defaultExt: "xlsx",
    maxBytes: 40 * MB,
    reconciliation: "snapshot",
    parserKey: "openOrders",
    stagingTables: ["open_orders"],
    hubspot: {
      object: "line_items",
      note: "Orders + Line Items (open-orders pipeline). A separate invoiced-orders feed lands later.",
    },
    ingestable: true,
  },

  territory: {
    key: "territory",
    label: "Territory / Rep-Zip Matrix",
    description:
      "Zip-per-row, channel-per-column matrix from SharePoint; each cell is a 3-digit rep code. Pushed in by Power Automate whenever it changes.",
    authMode: "automated",
    r2Prefix: "territory",
    acceptedContentTypes: [...EXCEL_CONTENT_TYPES],
    defaultExt: "xlsx",
    maxBytes: 10 * MB,
    reconciliation: "snapshot",
    parserKey: "territory",
    stagingTables: ["rep_codes"],
    hubspot: {
      object: "rep_codes_custom_object",
      note: "Rep Codes custom object (+ a reporting dataset handled HubSpot-side later).",
    },
    ingestable: true,
  },

  pricing: {
    key: "pricing",
    label: "Pricing Workbooks",
    description:
      "Four annual price-book workbooks, uploaded manually by an admin. Each upload replaces only its own price book.",
    authMode: "manual",
    r2Prefix: "pricing",
    acceptedContentTypes: [...EXCEL_CONTENT_TYPES],
    defaultExt: "xlsx",
    maxBytes: 20 * MB,
    reconciliation: "snapshot",
    parserKey: "pricing",
    stagingTables: ["pricing"],
    hubspot: { object: "products", note: "Products price-book properties." },
    ingestable: true,
    // The four WAC price books. `key` is the stored `pricing.variant` value;
    // `label` is what shows in the admin upload GUI and on ingestion records.
    variants: [
      { key: "c1", label: "C1" },
      { key: "d1", label: "D1" },
      { key: "d6", label: "D6" },
      { key: "d7", label: "D7" },
    ],
  },

  // Already ingested daily by the Sales Layer cron (apps/api/src/saleslayer.ts).
  // Listed ONLY so the destination map and the observability source list are
  // complete — it has no `/api/ingest` inbox.
  "sales-layer": {
    key: "sales-layer",
    label: "Sales Layer (PIM)",
    description:
      "Daily product data from the Sales Layer PIM, already synced into the products table by a scheduled job.",
    authMode: "automated",
    r2Prefix: "sales-layer",
    acceptedContentTypes: [],
    defaultExt: "",
    maxBytes: 0,
    reconciliation: "snapshot",
    parserKey: "salesLayer",
    stagingTables: ["products"],
    hubspot: { object: "products", note: "Already synced daily; future HubSpot Products push." },
    ingestable: false,
  },

  // FUTURE: an invoiced-orders feed (the second HubSpot Orders pipeline) and any
  // other source become a new descriptor here when their source/delivery firm up.
};

export type SourceKey = keyof typeof SOURCES;

/** Look up a descriptor by key. */
export function getSource(key: string): SourceDescriptor | undefined {
  return SOURCES[key];
}

/** All sources (including non-ingestable Sales Layer), in declaration order. */
export function listSources(): SourceDescriptor[] {
  return Object.values(SOURCES);
}

/** Only sources that land files through the `/api/ingest` inbox. */
export function listIngestableSources(): SourceDescriptor[] {
  return listSources().filter((s) => s.ingestable);
}

/** Resolve the variant for a source, if it requires one. */
export function getVariant(
  source: SourceDescriptor,
  variantKey: string | undefined,
): SourceVariant | undefined {
  if (!source.variants) return undefined;
  return source.variants.find((v) => v.key === variantKey);
}

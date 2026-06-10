import {
  type CSSProperties,
  Fragment,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { FIELD_LIMITS, NORMALIZE_FIELDS, SEO_RULES, type NormalizeField } from "@wac/shared";
import { api, apiBlob } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Phase 2 — Product Information (PRD §6), split into three pages under the
 * "Product Info" menu: Romance Copy, SEO, and Data Normalization. Romance/SEO
 * attach at the PPID (product page) level and show the product image +
 * primary attributes beside the editor; normalization shows variant SKUs
 * nested under their product with a PPID-level roll-up.
 */

type Tab = "romance_copy" | "seo" | "normalize";

interface ContentRow {
  id: string;
  ppid: string;
  /** '' = product/PPID-level row; otherwise the variant SKU. */
  sku: string;
  field: string;
  existing_value: string | null;
  ai_value: string | null;
  approved_value: string | null;
  status: "none" | "generated" | "in_review" | "approved";
  flagged: boolean;
  note: string | null;
  reviewed_by: string | null;
  updated_at: string;
}

interface VariantSlim {
  sku: string | null;
  finish: string | null;
  name: string | null;
  cct_code?: string | null;
  cct_desc?: string | null;
  beam_desc?: string | null;
  volt_in?: string | null;
}

interface Item {
  ppid: string;
  name: string;
  brand: string | null;
  category: string | null;
  family: string | null;
  primary_image_url: string | null;
  variants?: VariantSlim[];
  content: ContentRow[];
}

interface ProductDetails {
  ppid: string;
  name: string;
  brand: string | null;
  category: string | null;
  image_url: string | null;
  image_urls: string[];
  attributes: { label: string; value: string }[];
  features: string[];
  variant_count: number;
  existing: {
    romance_copy: string | null;
    seo_title: string | null;
    seo_meta_description: string | null;
  };
}

const PAGE = 50;

/** Raw-value key per normalization field on the slim variant payload. */
const VARIANT_KEY: Record<NormalizeField, keyof VariantSlim> = {
  cct: "cct_desc",
  cct_type: "cct_code",
  beam: "beam_desc",
  voltage: "volt_in",
};
const FIELD_LABEL: Record<string, string> = {
  cct: "CCT",
  cct_type: "CCT Type (Fixed / Selectable / Tunable / Color Changing)",
  beam: "Beam",
  voltage: "Input voltage",
};

export function RomanceCopyPage() {
  return (
    <ProductInfoCore
      tab="romance_copy"
      title="Romance Copy"
      blurb="AI-drafted marketing descriptions per product page (PPID), side-by-side with the existing PIM copy and the product's image and attributes. Approved copy is stored here (system of record) and exportable as CSV."
    />
  );
}

export function SeoPage() {
  return (
    <ProductInfoCore
      tab="seo"
      title="SEO"
      blurb="Title tag, meta description, and Open Graph (og:title, og:description, og:image) per product page (PPID), generated within character limits with the product context in view. Review or bulk-approve; export as CSV."
    />
  );
}

export function NormalizationPage() {
  return (
    <ProductInfoCore
      tab="normalize"
      title="Data Normalization"
      blurb="Standardizes raw attribute values — CCT, beam, and input voltage — into the canonical website format, at both the variant SKU level and as a roll-up for the product page. Unparseable values are flagged for manual resolution, never silently mangled."
    />
  );
}

function itemStatus(item: Item, tab: Tab): string {
  const rows =
    tab === "normalize" ? item.content : item.content.filter((r) => r.sku === "");
  if (rows.some((r) => r.flagged)) return "flagged";
  const want = tab === "seo" ? 2 : 1;
  if (rows.length < want) return "none";
  const order = ["none", "generated", "in_review", "approved"];
  const min = Math.min(...rows.map((r) => order.indexOf(r.status)));
  return order[min] ?? "none";
}

function statusStyle(status: string): CSSProperties {
  switch (status) {
    case "approved":
      return { color: "var(--good)" };
    case "flagged":
      return { color: "var(--bad)" };
    case "generated":
    case "in_review":
      return { color: "var(--accent)" };
    default:
      return {};
  }
}

function StatusTag({ status }: { status: string }) {
  return (
    <span className="tag" style={statusStyle(status)}>
      {status === "none" ? "not started" : status.replace("_", " ")}
    </span>
  );
}

function ProductInfoCore(props: { tab: Tab; title: string; blurb: string }) {
  const { tab } = props;
  const { user } = useAuth();
  // Deep link from the Products hub / Families page: ?ppid= pre-filters the
  // list to that product and opens its editor.
  const [searchParams] = useSearchParams();
  const initialPpid = searchParams.get("ppid");
  const [q, setQ] = useState(initialPpid ?? "");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(initialPpid);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"missing" | "all" | "selected">("missing");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(false);

  async function load(opts: { offset?: number } = {}) {
    const useOffset = opts.offset ?? offset;
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({
        field: tab,
        limit: String(PAGE),
        offset: String(useOffset),
      });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const res = await api<{ items: Item[]; total: number }>(
        `/api/product-info?${params}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, offset]);

  /** Merge fresh content rows into the matching item. */
  function applyContent(rows: ContentRow[]) {
    setItems((prev) =>
      prev.map((item) => {
        const mine = rows.filter((r) => r.ppid === item.ppid);
        if (mine.length === 0) return item;
        const others = item.content.filter(
          (r) => !mine.some((m) => m.field === r.field && m.sku === r.sku),
        );
        return { ...item, content: [...others, ...mine] };
      }),
    );
  }

  function toggleChecked(ppid: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(ppid)) next.delete(ppid);
      else next.add(ppid);
      return next;
    });
  }

  async function exportCsv(approvedOnly = false) {
    setBusy(true);
    setErr(null);
    try {
      const blob = await apiBlob(
        `/api/product-info/export.csv?field=${tab}${approvedOnly ? "&status=approved" : ""}`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `product-info_${tab}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  function batchScopeBody(): Record<string, unknown> | null {
    if (scope === "selected") {
      if (checked.size === 0) {
        setNotice("Select products first (checkboxes), or pick another scope.");
        return null;
      }
      return { scope, ppids: [...checked] };
    }
    return { scope };
  }

  /** Loop the batch endpoint until done/cancelled, with visible progress. */
  async function runGenerateBatch() {
    const scopeBody = batchScopeBody();
    if (!scopeBody) return;
    const kind = tab === "romance_copy" ? "romance" : "seo";
    cancelRef.current = false;
    setBusy(true);
    setErr(null);
    let done = 0;
    let failures = 0;
    try {
      for (;;) {
        const res = await api<{
          processed: string[];
          failed: { ppid: string; error: string }[];
          remaining: number;
        }>("/api/product-info/generate-batch", {
          method: "POST",
          body: JSON.stringify({ kind, limit: 8, ...scopeBody }),
        });
        done += res.processed.length;
        failures += res.failed.length;
        setNotice(
          `Generating ${kind === "romance" ? "romance copy" : "SEO"}… ${done} done, ${res.remaining} remaining${failures ? `, ${failures} failed` : ""}.`,
        );
        if (res.failed.length > 0 && res.processed.length === 0) {
          setErr(`Batch stopped: ${res.failed[0]!.error}`);
          break;
        }
        if (res.remaining === 0 || cancelRef.current) {
          setNotice(
            cancelRef.current
              ? `Batch cancelled after ${done} product${done === 1 ? "" : "s"}.`
              : `Batch complete: ${done} generated${failures ? `, ${failures} failed` : ""}.`,
          );
          break;
        }
      }
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function runNormalize() {
    const scopeBody = batchScopeBody();
    if (!scopeBody) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api<{
        products: number;
        skuRows: number;
        parsed: number;
        flagged: number;
        skippedApproved: number;
        skippedExisting: number;
        noValue: number;
      }>("/api/product-info/normalize", {
        method: "POST",
        body: JSON.stringify({ fields: [...NORMALIZE_FIELDS], ...scopeBody }),
      });
      setNotice(
        `Normalized ${res.products} products / ${res.skuRows} SKU values: ${res.parsed} parsed, ${res.flagged} flagged, ${res.skippedApproved} kept (approved), ${res.skippedExisting} skipped (existing), ${res.noValue} products without data.`,
      );
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkApprovePage() {
    const ids = items
      .flatMap((i) => i.content)
      .filter(
        (r) =>
          !r.flagged &&
          (r.status === "generated" || r.status === "in_review") &&
          (r.ai_value ?? r.approved_value),
      )
      .map((r) => r.id);
    if (ids.length === 0) {
      setNotice("Nothing on this page is ready to approve.");
      return;
    }
    if (!confirm(`Approve ${ids.length} value${ids.length === 1 ? "" : "s"} on this page?`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api<{ approved: number; skipped: number }>(
        "/api/product-info/bulk-approve",
        { method: "POST", body: JSON.stringify({ ids }) },
      );
      setNotice(`Approved ${res.approved}; skipped ${res.skipped}.`);
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  if (user?.role === "rep") {
    return (
      <div className="card">
        <h2>{props.title}</h2>
        <p className="muted">This tool is available to internal users only.</p>
      </div>
    );
  }

  const colCount = tab === "normalize" ? 6 : 5;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>{props.title}</h2>
        <div className="muted">{props.blurb}</div>
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="Search name, brand, PPID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setOffset(0);
              void load({ offset: 0 });
            }
          }}
          style={{ flex: 1, minWidth: 180 }}
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All statuses</option>
          <option value="generated">Generated</option>
          <option value="in_review">In review</option>
          <option value="approved">Approved</option>
          <option value="flagged">Flagged</option>
        </select>
        <button onClick={() => { setOffset(0); void load({ offset: 0 }); }} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search
        </button>
        <button className="secondary" onClick={() => void bulkApprovePage()} disabled={busy}>
          Approve page
        </button>
        <button onClick={() => void exportCsv(true)} disabled={busy}>
          Export approved updates
        </button>
        <button className="secondary" onClick={() => void exportCsv()} disabled={busy}>
          Export all (CSV)
        </button>
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>Batch run</strong>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
          disabled={busy}
        >
          <option value="missing">Missing only (not yet generated)</option>
          <option value="all">All products (keeps approved)</option>
          <option value="selected">Selected ({checked.size})</option>
        </select>
        {tab === "normalize" ? (
          <button onClick={() => void runNormalize()} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Run normalization
          </button>
        ) : (
          <button onClick={() => void runGenerateBatch()} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Generate {tab === "romance_copy" ? "romance copy" : "SEO"}
          </button>
        )}
        {busy && tab !== "normalize" && (
          <button className="secondary" onClick={() => { cancelRef.current = true; }}>
            Stop after this batch
          </button>
        )}
        {checked.size > 0 && (
          <button className="secondary" onClick={() => setChecked(new Set())} disabled={busy}>
            Clear selection
          </button>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}
      {notice && <div className="alert">{notice}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>Product</th>
              <th>PPID</th>
              <th>Brand</th>
              {tab === "normalize" && <th>Canonical CCT</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const st = itemStatus(item, tab);
              const rollup = item.content.find(
                (r) => r.field === "cct" && r.sku === "",
              );
              const isOpen = selected === item.ppid;
              const prevFamily = index > 0 ? items[index - 1]!.family : undefined;
              const showFamily = !!item.family && item.family !== prevFamily;
              return (
                <Fragment key={item.ppid}>
                  {showFamily && (
                    <tr>
                      <td
                        colSpan={colCount}
                        className="muted"
                        style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}
                      >
                        {item.family}
                      </td>
                    </tr>
                  )}
                  <tr
                    onClick={() => setSelected(isOpen ? null : item.ppid)}
                    style={{ cursor: "pointer" }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked.has(item.ppid)}
                        onChange={() => toggleChecked(item.ppid)}
                        style={{ width: "auto" }}
                        aria-label={`Select ${item.name}`}
                      />
                    </td>
                    <td>{item.name}</td>
                    <td className="muted">{item.ppid}</td>
                    <td className="muted">{item.brand ?? "—"}</td>
                    {tab === "normalize" && (
                      <td>{rollup?.approved_value ?? rollup?.ai_value ?? "—"}</td>
                    )}
                    <td>
                      <StatusTag status={st} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={colCount} style={{ background: "var(--panel)" }}>
                        <ExpandedDetail
                          item={item}
                          tab={tab}
                          onContent={applyContent}
                          onError={setErr}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={colCount} className="muted">
                  No products match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
          <button
            className="secondary"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Prev
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE, total)}`} of {total}
          </span>
          <button
            className="secondary"
            disabled={offset + PAGE >= total || loading}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded row: product context panel + the workflow editor
// ---------------------------------------------------------------------------

function useProductDetails(ppid: string, enabled: boolean) {
  const [details, setDetails] = useState<ProductDetails | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api<ProductDetails>(`/api/product-info/details/${encodeURIComponent(ppid)}`)
      .then((d) => {
        if (!cancelled) setDetails(d);
      })
      .catch(() => {
        // panel is contextual; the editor still works without it
      });
    return () => {
      cancelled = true;
    };
  }, [ppid, enabled]);
  return details;
}

function ExpandedDetail(props: {
  item: Item;
  tab: Tab;
  onContent: (rows: ContentRow[]) => void;
  onError: (m: string) => void;
}) {
  const { item, tab } = props;
  const details = useProductDetails(item.ppid, tab !== "normalize");

  if (tab === "normalize") {
    return (
      <NormalizationDetail item={item} onContent={props.onContent} onError={props.onError} />
    );
  }
  return (
    <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap", padding: 8 }}>
      <ProductPanel details={details} fallbackImage={item.primary_image_url} />
      <div style={{ flex: 2, minWidth: 340 }}>
        {tab === "romance_copy" ? (
          <RomanceEditor item={item} details={details} onContent={props.onContent} onError={props.onError} />
        ) : (
          <SeoEditor item={item} details={details} onContent={props.onContent} onError={props.onError} />
        )}
      </div>
    </div>
  );
}

/** The context you need to write or judge copy: image + primary attributes. */
function ProductPanel(props: {
  details: ProductDetails | null;
  fallbackImage: string | null;
}) {
  const d = props.details;
  const img = d?.image_url ?? props.fallbackImage;
  return (
    <div className="col" style={{ flex: 1, minWidth: 240, maxWidth: 340, gap: 10 }}>
      {img ? (
        <img
          src={img}
          alt={d?.name ?? "product"}
          style={{
            width: "100%",
            maxHeight: 220,
            objectFit: "contain",
            background: "#fff",
            borderRadius: "var(--radius)",
          }}
        />
      ) : (
        <div className="muted">No product image.</div>
      )}
      {d && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontSize: 13 }}>
            {d.attributes.map((a) => (
              <Fragment key={a.label}>
                <span className="muted">{a.label}</span>
                <span>{a.value}</span>
              </Fragment>
            ))}
          </div>
          {d.features.length > 0 && (
            <div style={{ fontSize: 13 }}>
              <span className="muted">Features</span>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {d.features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {!d && <div className="muted">Loading product details…</div>}
    </div>
  );
}

function useRowActions(onContent: (rows: ContentRow[]) => void, onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(formatErr(e));
    } finally {
      setBusy(false);
    }
  }
  async function generate(ppid: string, kind: "romance" | "seo") {
    await run(async () => {
      const res = await api<{ content: ContentRow[] }>("/api/product-info/generate", {
        method: "POST",
        body: JSON.stringify({ ppid, kind }),
      });
      onContent(res.content);
    });
  }
  async function patch(
    id: string,
    body: { action: "save" | "approve" | "reopen"; ai_value?: string; approved_value?: string },
  ) {
    await run(async () => {
      const res = await api<{ content: ContentRow }>(`/api/product-info/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onContent([res.content]);
    });
  }
  return { busy, generate, patch };
}

function RomanceEditor(props: {
  item: Item;
  details: ProductDetails | null;
  onContent: (rows: ContentRow[]) => void;
  onError: (m: string) => void;
}) {
  const row = props.item.content.find(
    (r) => r.field === "romance_copy" && r.sku === "",
  );
  const { busy, generate, patch } = useRowActions(props.onContent, props.onError);
  const [draft, setDraft] = useState(row?.ai_value ?? "");
  useEffect(() => setDraft(row?.ai_value ?? ""), [row?.ai_value]);

  const existing = row?.existing_value ?? props.details?.existing.romance_copy ?? "";

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
        <div className="col" style={{ flex: 1, minWidth: 260, gap: 4 }}>
          <strong>Existing copy (PIM)</strong>
          <textarea
            readOnly
            rows={9}
            value={existing}
            placeholder="No romance copy in the PIM for this product."
          />
        </div>
        <div className="col" style={{ flex: 1, minWidth: 260, gap: 4 }}>
          <strong>AI copy {row?.status === "approved" ? "(approved)" : ""}</strong>
          <textarea
            rows={9}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Generate to draft romance copy from the product's PIM attributes."
          />
        </div>
      </div>
      {row?.status === "approved" && row.approved_value && (
        <div className="muted" style={{ fontSize: 12 }}>
          Approved value saved {new Date(row.updated_at).toLocaleString()}.
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button disabled={busy} onClick={() => void generate(props.item.ppid, "romance")}>
          {busy ? <span className="spinner" /> : null}
          {row?.ai_value ? "Regenerate" : "Generate"}
        </button>
        {row && (
          <>
            <button
              className="secondary"
              disabled={busy || draft === (row.ai_value ?? "")}
              onClick={() => void patch(row.id, { action: "save", ai_value: draft })}
            >
              Save edits
            </button>
            <button
              disabled={busy || !draft.trim()}
              onClick={() => void patch(row.id, { action: "approve", ai_value: draft, approved_value: draft })}
            >
              Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const SEO_EDITOR_FIELDS: { field: string; label: string; rows: number; existingKey?: "seo_title" | "seo_meta_description" }[] = [
  { field: "seo_title", label: "Title tag", rows: 1, existingKey: "seo_title" },
  { field: "seo_meta_description", label: "Meta description", rows: 3, existingKey: "seo_meta_description" },
  { field: "h1", label: "H1 (on-page heading)", rows: 1 },
  { field: "og_title", label: "og:title", rows: 1 },
  { field: "og_description", label: "og:description", rows: 2 },
];

/** Deterministic head fields — generated, not AI-written; editable before approval. */
const SEO_HEAD_FIELDS = ["url_slug", "canonical_url", "meta_robots"] as const;

function lengthBadge(field: string, len: number) {
  const rule = SEO_RULES[field];
  if (!rule) return null;
  const over = len > rule.max;
  const under = rule.min !== undefined && len > 0 && len < rule.min;
  return (
    <span
      className="muted"
      style={{ fontWeight: 400, ...(over ? { color: "var(--bad)" } : under ? { color: "var(--accent)" } : {}) }}
      title={rule.min ? `target ${rule.min}–${rule.max} characters` : `max ${rule.max} characters`}
    >
      {len}/{rule.min ? `${rule.min}–${rule.max}` : rule.max}
    </span>
  );
}

interface SeoPayload {
  head: Record<string, unknown>;
  jsonld: object[];
  issues: { level: "error" | "warn"; message: string }[];
}

function SeoEditor(props: {
  item: Item;
  details: ProductDetails | null;
  onContent: (rows: ContentRow[]) => void;
  onError: (m: string) => void;
}) {
  const { item, details } = props;
  const { busy, generate, patch } = useRowActions(props.onContent, props.onError);
  const rowFor = (field: string) =>
    item.content.find((r) => r.field === field && r.sku === "");

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [payload, setPayload] = useState<SeoPayload | null>(null);
  const [showJsonLd, setShowJsonLd] = useState(false);

  const editableFields = [
    ...SEO_EDITOR_FIELDS.map((f) => f.field),
    ...SEO_HEAD_FIELDS,
    "og_image",
  ];
  const aiSignature = editableFields.map((f) => rowFor(f)?.ai_value ?? "").join("\u0000");
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of editableFields) {
      const row = rowFor(f);
      next[f] = row?.approved_value ?? row?.ai_value ?? "";
    }
    setDrafts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSignature]);

  async function loadPayload() {
    try {
      const res = await api<SeoPayload>(
        `/api/product-info/jsonld/${encodeURIComponent(item.ppid)}`,
      );
      setPayload(res);
      setShowJsonLd(true);
    } catch (e) {
      props.onError(formatErr(e));
    }
  }

  const anyRow = SEO_EDITOR_FIELDS.some((f) => rowFor(f.field));
  const overLimit = (field: string) =>
    (FIELD_LIMITS[field] ?? Infinity) < (drafts[field]?.length ?? 0);
  const anyOver = SEO_EDITOR_FIELDS.some((f) => overLimit(f.field));

  async function approveAll() {
    for (const field of editableFields) {
      const row = rowFor(field);
      const value = drafts[field]?.trim();
      if (row && value) {
        await patch(row.id, { action: "approve", approved_value: value });
      }
    }
    setPayload(null);
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {SEO_EDITOR_FIELDS.map((f) => {
        const row = rowFor(f.field);
        const value = drafts[f.field] ?? "";
        const existing = f.existingKey ? details?.existing[f.existingKey] : null;
        return (
          <div className="col" style={{ gap: 4 }} key={f.field}>
            <strong>
              {f.label} {lengthBadge(f.field, value.length)}{" "}
              {row?.status === "approved" && <StatusTag status="approved" />}
            </strong>
            {existing && (
              <div className="muted" style={{ fontSize: 12 }}>
                Existing (PIM): {existing}
              </div>
            )}
            {f.rows === 1 ? (
              <input
                value={value}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                placeholder={`Generate to draft the ${f.label}.`}
              />
            ) : (
              <textarea
                rows={f.rows}
                value={value}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                placeholder={`Generate to draft the ${f.label}.`}
              />
            )}
          </div>
        );
      })}

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 180 }}>
          <strong>
            URL slug {rowFor("url_slug")?.status === "approved" && <StatusTag status="approved" />}
          </strong>
          <input
            value={drafts.url_slug ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, url_slug: e.target.value }))}
            placeholder="lowercase-hyphenated"
          />
          {drafts.url_slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(drafts.url_slug) && (
            <span style={{ color: "var(--bad)", fontSize: 12 }}>
              must be lowercase, hyphenated
            </span>
          )}
        </div>
        <div className="col" style={{ gap: 4, flex: 2, minWidth: 240 }}>
          <strong>
            Canonical URL {rowFor("canonical_url")?.status === "approved" && <StatusTag status="approved" />}
          </strong>
          <input
            value={drafts.canonical_url ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, canonical_url: e.target.value }))}
            placeholder="https://… (absolute, self-referencing)"
          />
        </div>
        <div className="col" style={{ gap: 4 }}>
          <strong>Robots</strong>
          <select
            value={drafts.meta_robots || "index"}
            onChange={(e) => setDrafts((d) => ({ ...d, meta_robots: e.target.value }))}
          >
            <option value="index">index</option>
            <option value="noindex">noindex</option>
          </select>
        </div>
      </div>

      <div className="col" style={{ gap: 4 }}>
        <strong>
          og:image{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (1200×630, absolute URL)
          </span>{" "}
          {rowFor("og_image")?.status === "approved" && <StatusTag status="approved" />}
        </strong>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {drafts.og_image && (
            <img
              src={drafts.og_image}
              alt="og:image"
              style={{ width: 56, height: 56, objectFit: "contain", background: "#fff", borderRadius: 4 }}
            />
          )}
          <input
            value={drafts.og_image ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, og_image: e.target.value }))}
            placeholder="Image URL (defaults to the primary catalog image on generate)"
            style={{ flex: 1 }}
          />
        </div>
        {(details?.image_urls.length ?? 0) > 1 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {details!.image_urls.slice(0, 8).map((u) => (
              <img
                key={u}
                src={u}
                alt=""
                onClick={() => setDrafts((d) => ({ ...d, og_image: u }))}
                style={{
                  width: 44,
                  height: 44,
                  objectFit: "contain",
                  background: "#fff",
                  borderRadius: 4,
                  cursor: "pointer",
                  outline: drafts.og_image === u ? "2px solid var(--accent)" : "1px solid var(--border)",
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        Constants emitted on export: og:type=product · twitter:card=summary_large_image. No offers/price fields — the site does not sell.
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button disabled={busy} onClick={() => void generate(item.ppid, "seo")}>
          {busy ? <span className="spinner" /> : null}
          {anyRow ? "Regenerate" : "Generate"}
        </button>
        {anyRow && (
          <button disabled={busy || anyOver} onClick={() => void approveAll()}>
            Approve all
          </button>
        )}
        <button className="secondary" onClick={() => void loadPayload()} disabled={busy}>
          {showJsonLd ? "Refresh" : "Preview"} structured data
        </button>
      </div>

      {showJsonLd && payload && (
        <div className="col" style={{ gap: 8 }}>
          {payload.issues.length > 0 && (
            <div className="col" style={{ gap: 4 }}>
              {payload.issues.map((i, n) => (
                <div
                  key={n}
                  className={`alert${i.level === "error" ? " error" : ""}`}
                  style={{ padding: "4px 10px", fontSize: 13 }}
                >
                  {i.level === "error" ? "Required: " : "Recommended: "}
                  {i.message}
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <strong>JSON-LD (ProductGroup + BreadcrumbList)</strong>
            <button
              className="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(payload.jsonld, null, 2))
              }
            >
              Copy
            </button>
          </div>
          <pre
            style={{
              maxHeight: 300,
              overflow: "auto",
              fontSize: 11,
              background: "var(--bg)",
              padding: 10,
              borderRadius: "var(--radius)",
            }}
          >
            {JSON.stringify(payload.jsonld, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Normalization detail: per field (CCT / beam / voltage), the PPID-level
 * roll-up row first, then every variant SKU nested under it.
 */
function NormalizationDetail(props: {
  item: Item;
  onContent: (rows: ContentRow[]) => void;
  onError: (m: string) => void;
}) {
  const { item } = props;
  const variants = (item.variants ?? []).filter((v) => v.sku);

  const sections = NORMALIZE_FIELDS.map((field) => {
    const rollup = item.content.find((r) => r.field === field && r.sku === "");
    const bySku = new Map(
      item.content.filter((r) => r.field === field && r.sku !== "").map((r) => [r.sku, r]),
    );
    const withData = variants.filter(
      (v) => v[VARIANT_KEY[field]] || bySku.has(v.sku!),
    );
    return { field, rollup, bySku, withData };
  }).filter((s) => s.rollup || s.withData.length > 0);

  if (sections.length === 0) {
    return (
      <div className="muted" style={{ padding: 8 }}>
        No normalizable attribute data on this product's variants. If the
        catalog was synced before attribute capture was added, re-sync products
        (Products page) and run normalization again.
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 16, padding: 8 }}>
      {sections.map(({ field, rollup, bySku, withData }) => (
        <div className="col" style={{ gap: 6 }} key={field}>
          <strong>{FIELD_LABEL[field]}</strong>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Finish</th>
                <th>Raw (PIM)</th>
                <th>Canonical</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <ValueRow
                label={`Product page (${item.ppid})`}
                finish=""
                raw={rollup?.existing_value ?? "—"}
                row={rollup}
                emphasized
                onContent={props.onContent}
                onError={props.onError}
              />
              {withData.map((v) => (
                <ValueRow
                  key={v.sku!}
                  label={v.sku!}
                  finish={v.finish ?? "—"}
                  raw={bySku.get(v.sku!)?.existing_value ?? (v[VARIANT_KEY[field]] as string | null) ?? "—"}
                  row={bySku.get(v.sku!)}
                  onContent={props.onContent}
                  onError={props.onError}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 12 }}>
        Rows without a canonical value haven't been normalized yet — use "Run
        normalization" above.
      </div>
    </div>
  );
}

function ValueRow(props: {
  label: string;
  finish: string;
  raw: string;
  row: ContentRow | undefined;
  emphasized?: boolean;
  onContent: (rows: ContentRow[]) => void;
  onError: (m: string) => void;
}) {
  const { row } = props;
  const { busy, patch } = useRowActions(props.onContent, props.onError);
  const [draft, setDraft] = useState(row?.approved_value ?? row?.ai_value ?? "");
  useEffect(
    () => setDraft(row?.approved_value ?? row?.ai_value ?? ""),
    [row?.approved_value, row?.ai_value],
  );

  return (
    <tr style={props.emphasized ? { fontWeight: 600 } : undefined}>
      <td>{props.label}</td>
      <td className="muted">{props.finish}</td>
      <td className="muted" title={row?.note ?? undefined}>
        {props.raw}
        {row?.flagged && (
          <span style={{ color: "var(--bad)", marginLeft: 6 }} title={row.note ?? "needs manual resolution"}>
            ⚑
          </span>
        )}
      </td>
      <td>
        {row ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{ minWidth: 140, fontWeight: 400 }}
          />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>{row ? <StatusTag status={row.flagged ? "flagged" : row.status} /> : <span className="muted">—</span>}</td>
      <td>
        {row && (
          <button
            disabled={busy || !draft.trim() || (row.status === "approved" && draft === row.approved_value)}
            onClick={() => void patch(row.id, { action: "approve", approved_value: draft })}
          >
            {busy ? <span className="spinner" /> : null}
            Approve
          </button>
        )}
      </td>
    </tr>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}

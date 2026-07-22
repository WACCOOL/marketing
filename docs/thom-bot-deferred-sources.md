# Thom Bot — Deferred Data Sources

A living backlog of documents / data sources we've **deliberately deferred** from
Thom Bot's knowledge base, so none are forgotten. When a source is integrated,
move it to "Done" with the PR, or delete the row.

Ingested today (for contrast): Sales Layer **`specsheet_pdf`** (spec sheets) and
**`inst_sheet`** (installation manuals), product + variant level. See the plan at
`~/.claude/plans/…` and `apps/api/src/saleslayer.ts` doc-capture.

---

## Deferred

| Source | What it is | Why deferred | Priority | Notes |
|---|---|---|---|---|
| **WIES Studio — dynamic spec sheets** | Spec sheets the brand websites generate on the fly for products that have **no** `specsheet_pdf` in Sales Layer | Needs WIES Studio access (separate app); URL source + auth TBD | **High** | This is the real coverage gap for "completely knowledgeable about spec sheets." Sales Layer `specsheet_pdf` is partial; WIES Studio has the generated URLs for the rest. Confirm how WIES exposes them (API / DB / export). |
| **WIES Studio — PPID page URLs (completeness)** | Canonical product-page URLs keyed by PPID, for the chat's "View product" links | `pdp_urls` (mig 0026) already replicates WIES's PDP resolver and covers most synced products; WIES Studio has the full set | Medium | v1 product cards link via `pdp_urls`. Pull the fuller WIES set only if `pdp_urls` coverage proves insufficient. |
| **IES photometric data** | Beam angle / candela distribution / spacing criteria derived from the `.ies` files (WIES Studio builds charts from these) | Value to Thom unproven; needs IES parsing or WIES-computed data | Phase 2 | `products.ies_url` / variant `ies_url` already stored (a CDN `.zip` of the `.ies`). Evaluate whether beam-spread / distribution answers help Thom before building. |
| **`dim_report` (Sales Layer)** | **DIMMING COMPATIBILITY report charts** (per-fixture dimmer test grids — NOT dimensional drawings; the earlier label here was a mislabel, corrected per docs/thom-dimming-compat-plan.md) | ~~Values are `.zip`~~ **CAPTURED** — the sync now captures `dim_report` (doc_type `dimming_report`, download buttons); zips are unzipped per-entry by the docs-ingest `--dimming` structured-extraction step; the charts are NEVER chunked/embedded (Step B excludes them) | Done (capture) | Structured rows land in `dimming_reports`/`dimming_compat_rows` behind `THOM_DIMMING` after the gated sample-then-full extraction run. |
| **`ftc_label_pdf` (Sales Layer)** | FTC lighting-facts label PDFs (lumens / wattage / CCT) | Sparse coverage; low incremental value over spec sheets | Low (fast-follow) | Field `ftc_label_pdf` on products + variants. Just add to `SALES_LAYER_DOC_FIELDS` once spec/inst are proven — single-PDF shape, no new handling. |
| **`revit` (Sales Layer)** | Revit family / BIM files | Binary CAD, not readable text | Won't ingest | Keep for potential download links on cards only, not RAG. |
| **product_documents prune** | Cleanup of superseded doc links when a product's file changes | v1 capture is idempotent-upsert only (no prune) | Low | A replaced spec sheet leaves the old link until a reconcile. Add a `synced_at`-based prune (mirrors the `products` sync) if staleness matters. |

## Done

_(none yet)_

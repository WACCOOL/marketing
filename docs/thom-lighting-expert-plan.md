# Thom Bot — Lighting-Expert Upgrade Plan (v2.1 — RATIFIED 2026-07-21; amended per Davis: NO licensed-text ingestion, curated-distillation route instead)

**Status:** v2.1, RATIFIED. v1 → two-lens counter-plan (A1–A15, R1–R16) → v2 reconciled → Davis amendments 2026-07-21: (1) licensed IES/ASHRAE/ICC documents are **never ingested into RAG** — their knowledge enters via the curated-distillation route (D.2) and the free-source corpus; (2) with that amendment Davis delegated approval ("self approve unless follow-up questions") and the build is GO. The IES-license legal check is thereby mooted for the build (it would only resurface if verbatim ingestion of licensed text is ever wanted). Figures queried live against prod Supabase (service-role, read-only) 2026-07-21.

**Thesis.** Thom answered "what's the highest lumen light" by crowning a 1,033 lm track head with tape light as runner-up. Three independent causes, three prongs:

1. **No way to query the catalog by spec** — lumens/watts are strings inside `products.variants` jsonb; no tool can sort or filter by a number. → **A: spec view + rank tool.**
2. **No lighting-domain priors** — nothing tells the model tape is a per-foot accent product and floods/wallpacks/high-bays are the high-output classes. → **B: lighting-expertise primer + superlative escalation.**
3. **No general lighting knowledge in the RAG store, and no way to add any** → **C: admin PDF uploads → kb_documents; D: curated source list (incl. US energy codes) with a licensing policy.**

## Data audit (live 2026-07-21)

| Fact | Value | Consequence |
|---|---|---|
| Products / variants | 4,390 / 37,712 | — |
| Variants with a `lumens` string | 3,467 (9%) | Sales Layer alone is nowhere near enough |
| Products with ≥1 numeric variant lumens | 946 (22%), heavily category-skewed (MF pendants ~100%; AETHER/OCULARC/VOLTA 0%) | must merge sources; must report per-scope coverage |
| `lumens` shapes (digits→#) | 3,449 `#`; 8 `# LM`; 6 `#N/A`; 3 `#,#`; 1 `# Lm` | parse conservatively; `#,#` is NOT safe to de-comma blindly (A6) |
| `watts` shapes | `#W` 23,670; multi-value `#W,#W,#W` ~4,300; `#W/ft` 191; `#-#W` 123; prose | per-foot detection; never cross-variant math |
| `product_photometrics` / representative SKUs / `ies_metrics` | 30,641 / 2,365 / 11,175 | IES-computed `metrics.lumens/inputWatts/efficacy` is the deeper source |
| Top SL-lumens product | CHAOS (MF pendant) 51,497 lm | a naive global rank crowns a 40-light chandelier — same failure as tape, better dressed (R4) → class-grouped ranking |

**Union coverage (measured, not estimated — re-verified 2026-07-21 after Davis challenged the 946):** SL variant lumens ∪ photometrics link = **2,497 of 4,390 (57%)**. Product-level `raw_json` was scanned for lumen-bearing Sales Layer fields: there are **none** — variant `zlmt` is the only lumens field in the export (e.g. AETHER products carry `watts: null, lumens: null` on every variant; their output data exists only via IES files). The 1,394 uncovered non-accessory products are dominated by Schonbek decorative categories (~700 rows — lamp-based fixtures whose output depends on lamping, legitimately unrated), aiSpire lines, junk categories (`292`, `0`), and ~53 W TRACK rows. Only **22** uncovered products have an `ies_url` — photometrics-sync has already harvested nearly everything harvestable, so the coverage ceiling is a Sales Layer / spec-sheet data problem, not a sync gap. The rank tool's honest-denominator posture (A.2) is therefore load-bearing, and the primer should note that lamp-based decorative fixtures don't carry a fixture lumen rating.

---

## A. Spec view + `rank_products_by_spec`

### A.1 Migration 0059 (the whole of Prong A's data layer)

`create view public.product_spec_view with (security_invoker = on) as …` — **`security_invoker = on` is the load-bearing security element**: a default view runs as its owner (postgres) and would bypass the scope RLS on `product_photometrics` (0048:57-58), leaking internal-scoped IES data into anon rank results (A1). With invoker semantics, anon sees only 0052-whitelisted `products` columns and public-scoped photometrics; internal users legitimately see more, so **anon and internal ranks may differ — correct, documented, and G.2's regression runs on both surfaces** (A13/R16b).

View shape — one row per SKU:
- Lateral-expand `products.variants`, parsing per variant: de-comma **only** thousands-separator shapes `^\d{1,3}(,\d{3})+$` — any other comma-bearing string is unparseable, never `15002000` (A6); then accept `^\d+(\.\d+)?$` after trimming one trailing `lm`/`w` unit token; skip `#N/A`/prose. `per_ft = true` when the variant's watts/lumens string matches `/ft|per foot`.
- `lumens_max = GREATEST(parsed SL max, representative IES lumens)` with `lumens_source` recording which won — "IES wins" was rejected because the representative file is one optic, often not the max-output variant (R5c).
- **Efficacy is computed per variant, only where a single variant supplies both numbers**, then aggregated; IES `metrics->>'efficacy'` preferred; **no efficacy for `per_ft` rows and never cross-variant division** (A8/R5a).
- **Per-foot rows are ranked by watts/ft only in v1** — nothing marks whether a tape lumens value is per-foot or per-reel, so per-foot lumens ranking is excluded until G.1 verifies semantics against known tape SKUs (R5b).
- `class` — coarse bucket stamped by a CASE/regex over name+category (tape/strip/extrusion → `per-foot`; chandelier/pendant/multi-light → `decorative`; track/monopoint; downlight/recessed; outdoor flood/wall pack/area/landscape; linear/suspended; fan; `other`). SQL-side because the view is SQL; the regex list is documented in the migration and G.1 verifies bucket distribution + top-5 per bucket by eye. TS mirroring was considered and rejected for v1 (drift risk > test value at 8 buckets) (R4 adopted-modified).
- Columns: `sku, name, brand, category, class, is_accessory, lumens_max, lumens_min, lumens_source, watts_max, watts_min, watts_per_ft_max, per_ft, efficacy, variant_count`.

RPC `product_spec_rank(metric, dir, brand_filter, category_filter, class_filter, grouped boolean default true, match_count int)` — SECURITY INVOKER; excludes `is_accessory`; **`where <metric> is not null` + `nulls last`** (A7); `grouped=true` returns top-3 per class, flat mode keeps the `class` column; returns **windowed counts** `in_scope_ranked` and `in_scope_total` so the tool can state the honest per-filter denominator (A9/R14).

Also in 0059 (same migration, three-line fixes each):
- Rewrite `product_photometrics_select` (and `products_select`, `ies_metrics` policy) into the `(select fn())` InitPlan form — 0055 fixed only the 0043 tables and this view walks the same diagnosed statement-timeout path (A4).
- `grant select on public.product_spec_view to anon, authenticated;` + EXECUTE on the RPC (a view has its own ACL; do not assume default privileges) (A1).
- Partial unique index `kb_documents (content_hash) where source_system='admin_upload' and status <> 'superseded'` — backs C.1's duplicate check race-free (A12).
- Migration header carries the 0052-style VERIFY-AS-ANON checklist, including `[DENY] internal-scoped photometrics contribute to anon rank` and an `explain analyze` of the RPC as anon (A1/A4).

### A.2 Tool

`rank_products_by_spec` in `packages/shared/src/thom/tools.ts`: inputs `metric` (lumens|watts|efficacy), `direction` (default highest), optional `brand`, `category`, `class`, `per_foot`, `limit` (cap 25). Output rows are **name-first** — `Endurance Flood Pro Wallpack (SKU 452, WAC Lighting, outdoor): 2,071 lm [IES-measured]` — because the public persona forbids leading with bare catalog numbers and a router-tier model will echo the tool's format (R15a). Grouped output renders per-class sections. Coverage line uses the RPC's windowed counts: *"Ranked among the N of M {scope} products with output data; per-foot products (tape/strip) are ranked separately by watts/ft."* An empty **filtered** result explains that categories are free-text and re-runs unfiltered/grouped rather than implying no data exists (R16a). No cards; the model follows up with `get_product`.

Gate: `THOM_SPEC_RANK=1`, exactly the `THOM_PHOTOMETRICS` idiom (`tools.ts:472-481`, `agent.ts:47-49/:84`). Plumbing that must ship with it (A11): `THOM_SPEC_RANK?` on `ThomEnv` (`packages/shared/src/thom/env.ts`); enabling = **committed `vars` edits** in `apps/api/wrangler.jsonc` (internal) and `apps/thom-bot/wrangler.jsonc` (public) — CI clobbers dashboard vars on every push, so G.2's internal-then-public enablement is two commits, not a toggle. Analytics: map the tool name and the `education` doc_type into real buckets in `analyticsSources.ts` + test — otherwise Davis's dashboard shows `Other (…)` (A10).

### A.3 Superlative escalation (replaces v1's unimplementable "count the tool call")

`shouldEscalate` never sees tool names (A5), and escalating only after a tool call still leaves Haiku answering the failing turn directly (R6). Adopted: a `SUPERLATIVE_INTENT` regex beside `COMPARISON_INTENT` in `agent.ts` (`/\b(highest|brightest|most (powerful|efficient)|max(imum)?\s+(lumens?|output)|lowest (wattage|power)|best (output|efficacy))\b/i`, tuned against chat-analytics logs) that escalates at `toolCallCount >= 0` — the strong model fields the superlative turn from the start. Superlatives are rare; the extra strong-model turns are cheap against a documented Haiku failure. Pure, testable in `agent.test.ts`.

## B. Lighting-expertise primer

`LIGHTING_EXPERTISE` in `prompts.ts`, on **both** surfaces, inserted before the final block (tail cache breakpoint preserved — verified against `prompts.ts:96-106/:158-171`; note the one-time prompt-cache invalidation on deploy, don't read the cache-miss spike as a regression (R16d)). **Split into a base block plus a flag-gated tool bullet**: the "call rank_products_by_spec" instruction is composed only when `THOM_SPEC_RANK=1`, because commanding an unadvertised tool re-creates the original failure (Haiku falls back to semantic search on "high output") (R3). Composition happens where `env` is available (`agent.ts`), via `lightingExpertise(hasSpecRank: boolean)`.

Content (~25 lines, authored to the public copy lints — no em dashes, no bare "WAC", none of the `promptsPublic.test.ts` forbidden vocabulary (A14)):

- **Output taxonomy, qualitative-first:** tape/strip = per-foot accent/cove/undercabinet, never comparable to per-fixture totals; track heads and downlights = accent/task; linear/suspended = ambient; multi-light chandeliers = large *decorative* totals, not "high output"; the high-output classes are flood, wall pack, area/site, high-bay. Numeric ranges are used sparingly and behind a guard sentence: *"These ranges are industry-typical context, never WAC Group specifications; actual catalog data from the tools always overrides them."* (R8a/b)
- **Catalog-shape honesty line:** when a class is thin or absent in the catalog, frame as "the highest-output categories WAC Group offers are X" — reconciles with the existing never-say-we-don't-make-it rule (R8c).
- **The name trap (the actual failure mechanism):** *"'High Output' in a WAC Group product NAME is relative to its own category — high-output tape is still a per-foot accent product. Never treat a name containing 'high output' as evidence of high absolute lumen output."* (R7)
- **Units discipline:** lumens vs candela (a narrow-beam head = huge candela, modest lumens — the Exterminator trap) vs footcandles; delivered vs source lumens; efficacy lm/W; watts measure consumption, not output ("100W-equivalent" is a legacy comparison) (R7).
- **Superlatives** (flag-gated bullet): call `rank_products_by_spec`; present grouped by class; per-foot separately; state the coverage caveat; when the user says "anything", answer with the grouped tops, then offer to refine — do not re-ask.
- **Design targets:** `lighting_requirement` (IES/ASHRAE-backed) is the primary source for recommended footcandles/uniformity/LPD; education documents are supporting context (R13).
- **Licensed documents:** summarize and cite (document, edition, page); do not reproduce extended verbatim passages from licensed standards (R11b).
- **Energy-code posture, unconditional:** for ANY code-compliance question (from documents, web, or memory): name code + edition, note that state adoption and amendments vary, and advise verifying with the local AHJ; on the public surface, Thom does not make compliance determinations — consult the AHJ or a licensed professional (R15b).

## C. Admin knowledge uploads

New `doc_type='education'`, `source_system='admin_upload'`. (No longer "zero migrations" — the dedup index rides in 0059.)

**C.1 API** — `apps/api/src/routes/thomUploads.ts`, same posture as `thomContent.ts` (requireAuth + requireFeature("thom-content") + requireInternal; service client for kb writes):
- `POST /` multipart (`file`, `title` req — **helper text requires edition/year in the title** for standards/codes (R13), `scope` default **internal**, `brand` optional, `force_vision` optional (R12c)): `%PDF` magic + ≤30MB (idiom `ppt.ts:69-111`); R2 `kb/admin_uploads/{uuid}.pdf` to `ASSETS_BUCKET`; insert `kb_documents` row `pending_extract` with `content_hash`; duplicate = insert-conflict on the 0059 partial index (covers `pending_extract` too, race-free) → 409 naming the existing doc (A12).
- `GET /` list (status, last_error, chunk_count, **truncation warning** (R1), extracted_at); `POST /:id/reingest`; `DELETE /:id` → superseded + chunks deleted + R2 object deleted; `GET /:id/file` streams the PDF (internal auth). `kb_documents.url` stays null.

**C.2 Extraction** — docs-ingest `admin_upload` branch. Counter-plan found the v1 path dead on arrival (A2): the nightly workflow passes **no R2 credentials** (`webStoreFromEnv()` → null in scheduled runs) and the store's `getText` is UTF-8-only. Required in the Prong-C PR:
- Add `R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY` + `R2_BUCKET: wac-marketing-assets` to `docs-ingest.yml` env (exact pattern of `site-crawl.yml:72-75`; secrets already exist org-side).
- Add `getBytes(key)` (`transformToByteArray()`) beside `getText`.
- **Per-page extraction** (`mergePages: false`), pages joined with markers, `chunk.page` assigned from marker offsets via a small pure helper in `packages/shared/src/ingest/` (unit-tested). Today every chunk is inserted `page: null` (`index.ts:585`) — for 200-page standards a title-only citation is useless, and for licensed internal docs the page is the auditability (A3/R2).
- `chunkText` with `maxChunks` **parametrized to 2,000** for admin_upload — the default 400 silently truncates at ~270 pages, which would have dropped exactly the appendices (JA8, LPD tables) Davis wants, while showing "active" (R1). Record chunk_count and surface a truncation flag to C.1's list.
- Vision fallback: page-capped for admin_upload; over-cap or >100-page scanned docs fail with a clear `last_error` ("scanned documents this large aren't supported") instead of burning the API budget and the 60-minute job cap (A15/R12c). Licensed standards are born-digital, so this is an edge.

**C.3 Retrieval + gating** — `education` joins BOTH `search_docs` allowlists, but **intent-gated** per the ratified web-crawl §D.2 philosophy rather than unconditionally (R9): extend `detectDocsQueryIntent` so **product/SKU-shaped queries exclude `education`** from `doc_types` — education chunks structurally cannot displace spec-sheet chunks on the query class the team has fought contamination on (the vec branch's fixed LIMIT 50 pool is the crowding risk, not the lexical branch). Company/ambiguous/educational intents include it. Stamp `authority = 0.9` on education docs at upload — inert while `THOM_AUTHORITY` is off, correct the day it flips on (R9). The scope gate needs no work: the public Worker holds only the anon key and `kb_chunks` RLS blocks internal rows for anon regardless of parameters — an internal-scoped licensed doc is unretrievable publicly by construction (verified, 0054:152 + 0055:25-29).

**Competitor screen:** DOE/DLC/ENERGY STAR material names manufacturers; today the public competitor screen runs only on web_search turns, so public-scope education chunks would bypass it (R10). Adopted: run `screenCompetitors` on public turns **whose citations include `doc_type='education'`** (citations already carry doc_type — cheap and precise), PLUS the C.4 review gate below.

**C.4 Web UI** — a **Documents** section in `ThomContentAdmin.tsx`: upload form (scope defaults internal; helper text: *"Licensed or purchased documents (IES, ASHRAE, ICC) must stay Internal. Public is only for public-domain/government documents."*), status table (pending → "indexed by the nightly ingest (11:00 UTC)" / active / failed + error / truncated), re-ingest, delete, open-PDF. **Flipping a doc to public requires a review confirmation** ("checked for third-party brand names; content verified") (R10b/G.4).

## D. Source list & licensing policy

**Hard rule (per Davis 2026-07-21, supersedes the v2 scope-based rule): licensed standards (IES/ASHRAE/ICC) are NEVER ingested into `kb_documents` — any scope.** IES terms bar reproduction on a "networked computer environment," and their PDFs are single-user licensed; a RAG store serving verbatim excerpts is exactly that. Their *knowledge* (facts, values, concepts — which copyright does not protect) enters through D.2. Upload scope rules for the remaining (free) corpus: government/public-domain docs may be `public` after the C.4 review gate; anything else defaults `internal`.

### D.2 Curated-distillation route (RATIFIED — the licensed-knowledge path)

Two channels, both existing machinery:
1. **Structured values → estimator tables** (`packages/shared`, pure + tested, served by `lighting_requirement`): recommended illuminance/uniformity by space, LPD allowances, JA8 efficacy thresholds — numeric facts restated in our own structure, cited by standard name + edition. This already exists for ASHRAE 90.1/IES RP values (`estimator.ts`); Title 24 §140.6 + JA8 join it (was already planned, R12); LS-1 definitions and RP values extend it as acquired.
2. **Concept summaries → Thom Knowledge** (`marketing_content`, doc_type `marketing` today — add doc_subtype `education`): terminology, design concepts, code-navigation guidance authored **in our own words** with name+edition citations, projected into RAG by the existing `projectMarketingContent` path. Authoring workflow: Davis (or Claude, from the licensed doc Davis provides in-session — reading and distilling facts is fine; the output must be paraphrase, never extended quotation) writes entries per topic. First entries: IES-file/photometric vocabulary (from LM-63), definitions core (from LS-1 when purchased), Title 24/JA8 orientation.

The primer's no-verbatim line (B) stays as defense-in-depth for anything licensed that ever reaches context.

| # | Source | Gives Thom | License | Scope | Status |
|---|---|---|---|---|---|
| 1 | **VA Lighting Design Manual PG-18-10 (2022)** (Davis has — it is NOT a California guide) | glossary, selection guidance, illuminance targets | US federal, public | public (after C.4 review) | ready |
| 2 | **CA Title 24 Part 6 + JA8** (current edition) | California energy code; JA8 high-efficacy rules WAC residential certifies to | CEC, free | public | Davis downloads |
| 3 | **DOE Building Energy Codes Program** PDFs (energycodes.gov) — state adoption maps, IECC/90.1 lighting guides | "which code applies where" + plain-English provisions | US DOE, free | public | download |
| 4 | **DOE SSL fact sheets** incl. the lumens-vs-watts / LED-labeling sheet (R13) | LED fundamentals; the wattage-era trap | US DOE, free | public | download |
| 5 | **DLC Technical Requirements** + **ENERGY STAR Luminaires** | the thresholds rebates/"high output" claims hinge on | free | public | download |
| 6 | **IDA/IES Model Lighting Ordinance (MLO)** (R13) | outdoor lighting zones + BUG limits — pairs with the existing BUG metrics | free | public | download |
| 7 | **ADA Standards §307** protrusion limits (R13) | the 4-inch wall-sconce rule — perennial real-world question | public domain | public | download |
| 8 | **ANSI/IES LS-1** (Nomenclature & Definitions) | THE expert-vocabulary standard | IES $ | **never ingested — distill via D.2** | Davis: purchase; then distill definitions |
| 9 | **IES application RPs** (RP-1, RP-8, RP-28, …), selectively | canonical design guidance | IES $$ | **never ingested — distill via D.2** | Davis, selective; values → estimator tables |
| 10 | **ANSI/IES LM-63-19** (Davis has) | IES-file vocabulary — photometrics pipeline already implements it (R13) | IES licensed | **never ingested — distill via D.2** | one short Thom Knowledge entry, done |
| 11 | **IES Lighting Handbook** | broad; LS-1 + targeted RPs deliver most value first (R13) | IES $$$ | **never ingested** | defer |
| 12 | ASHRAE 90.1 / IECC full text | actual commercial code text | licensed | **never ingested — #3 covers it; values → estimator** | not needed |

**Code tables get a curated route, not just RAG** (R12): raw-text extraction mangles multi-column LPD tables (label↔value association destroyed, vision fallback never fires on dense text) — retrieval would hand the model plausible, cited, wrong fragments. The headline numbers people actually ask for — **Title 24 §140.6 area-category LPDs + JA8 efficacy thresholds** — are added to the estimator-style curated data in `packages/shared` (small, pure, tested) behind `lighting_requirement`, which the prompt already prefers. Ingested code PDFs serve as prose/background. Each code doc gets a G.4 spot-check: query 3 known table values against the source before trusting.

v1 ingests **PDF uploads only** — no crawler extension to non-WAC domains (endorsed by counter-plan).

## E. Tests

- Prompts: primer passes `normalizeCopy` unchanged + the `promptsPublic.test.ts` negative lints; base-vs-flag-gated composition; breakpoint still on the last block.
- Tools: rank formatting (grouped, name-first, coverage line from windowed counts), empty-filter fallback, flag-gated composition + public dispatch, `education` intent gating in `authority.ts`/`tools.ts` (product-intent excludes it), analytics bucket mapping.
- Agent: `SUPERLATIVE_INTENT` escalation at zero tool calls (`agent.test.ts`).
- Ingest: per-page chunk helper (page assignment), `admin_upload` branch with mocked R2 bytes, `maxChunks` parametrization + truncation flag.
- API: magic-byte/size-cap rejection, duplicate-hash 409 via the partial index, scope default internal, review-gate on scope flip.
- Estimator: Title 24/JA8 table lookups.
- **Regression conversation** (manual, both surfaces (R16b)): the verbatim failing chat → expect class-grouped, coverage-caveated answer, correct high-output classes, no tape nomination, superlative turn on the strong model.

## G. Rollout (gated, in order)

1. **Migration 0059.** No user-visible change. Verify: VERIFY-AS-ANON checklist incl. the photometrics DENY case; `explain analyze` as anon; counting SQL — parse coverage by source, per_ft counts, class distribution + eyeball top-5 per class, the A6 literal cases (`"1,033"`, `"1500,2000"`-style multi-value, `#N/A`), tape-SKU lumens semantics check (decides whether per-foot lumens ranking can ever ship).
2. **PR: A + B.** Primer base block live (tool bullet composes only under the flag — safe by construction now). Enable `THOM_SPEC_RANK` internal (wrangler vars commit), run the regression conversation, then the public vars commit.
3. **PR: C** (route + UI + ingest branch + workflow R2 env + allowlists/intent gate + competitor-screen extension + analytics buckets). `education` in allowlists is inert with zero docs.
4. Upload #1 (VA manual) internal → dispatch docs-ingest → verify retrieval + **real page citations** + truncation flag clear → C.4 review → flip public. (Licensed docs are never uploaded — D.2.)
5. Davis downloads #2–#7; batch-upload per the table; per-code-doc 3-value spot-check (R12). D.2 distillation entries authored as sources are acquired.
6. Curated Title 24/JA8 estimator data PR (can parallel #3–#5).
7. Housekeeping: move the deferred-sources "IES photometric data" row to **Done** (it shipped as photometrics-sync) (R16c); add education-uploads row.

## H. Deferred

- Category normalization / clean application flags; CRI/IP/CCT rank filters; per-foot lumens ranking (pending G.1 semantics check); materializing the view; TS mirror of the class regex.
- Crawler extension to gov/standards domains; inline Worker-side extraction (instant indexing); table-aware extraction (the R12 curated route + force-vision toggle are the v1 levers).
- Photometrics coverage push (2,365/4,390 representative SKUs — raising it raises rank coverage automatically).
- Authored "Lighting 101" marketing-content articles (no code).
- JA8/Title 24 per-product compliance fields in the catalog.

## Davis decisions

- [x] Plan RATIFIED 2026-07-21 (v2.1 amendments: no licensed ingestion; D.2 distillation route; delegated self-approval).
- [x] License check mooted — licensed text never enters RAG; using the *knowledge* needs no permission. (Optional future: email Standards@ies.org only if verbatim ingestion is ever wanted.)
- [ ] Purchase LS-1 (+ selective RPs) when ready — feeds D.2, not RAG.
- [ ] `THOM_PHOTOMETRICS` intent (Prong A reads the photometrics store regardless; the flag only gates the per-SKU tools).
- Defaults adopted under self-approval: uploads ride the `thom-content` gate; SUPERLATIVE_INTENT pre-escalation on; public scope only for gov/public-domain docs behind the C.4 review gate.

## Adjudication ledger (counter-plan → resolution)

| Obj | Sev | Resolution |
|---|---|---|
| A1 view RLS bypass | BLOCKER | security_invoker=on + explicit view grants + VERIFY-AS-ANON w/ DENY case (A.1) |
| A2 docs-ingest R2 creds + text-only store | BLOCKER | workflow R2 env (site-crawl pattern) + `getBytes` (C.2) |
| A3/R2 `page: null` vs promised citations | MAJOR/BLOCKER | per-page extraction + page-marker chunk helper; page citation is a G.4 gate (C.2) |
| A4 0048 policies pre-InitPlan | MAJOR | rewritten in 0059 + explain-analyze gate (A.1) |
| A5/R6 escalation unimplementable / too late | MAJOR | SUPERLATIVE_INTENT regex at toolCallCount ≥ 0 (A.3) |
| A6 comma-strip corruption | MAJOR | thousands-shape-only de-comma + G.1 literals (A.1) |
| A7 NULL ordering | MINOR | not-null filter + nulls last (A.1) |
| A8/R5a cross-variant efficacy | MAJOR | per-variant-only efficacy; none for per_ft (A.1) |
| A9/R14 coverage denominator | MINOR | windowed in-scope counts returned by RPC (A.1/A.2) |
| A10 analytics buckets | MINOR | mapped + tested (A.2) |
| A11 env/vars plumbing | MINOR | ThomEnv + committed wrangler vars, two-commit enablement (A.2) |
| A12 dup-409 unbacked | MINOR | partial unique index in 0059, covers pending_extract (A.1/C.1) |
| A13/R16b anon/internal divergence | MINOR | documented; regression on both surfaces (A.1/E) |
| A14 primer copy lints | MINOR | authored to lints + tests (B/E) |
| A15/R12c vision cost/limits | MINOR | page-capped vision, clear last_error, force_vision toggle (C.2) |
| R1 maxChunks truncation | BLOCKER | parametrized 2,000 + truncation surfacing (C.2) |
| R3 primer commands absent tool | BLOCKER | flag-gated tool bullet composition (B) |
| R4 global rank crowns CHAOS | MAJOR | class-grouped ranking, SQL-side buckets, G.1 verification (A.1/A.2) |
| R5b per-foot lumens ambiguity | MAJOR | per-foot ranked by watts/ft only in v1 (A.1) |
| R5c IES-wins understates max | MAJOR | GREATEST + honest source column (A.1) |
| R7 "High Output" name trap + wattage era | MAJOR | explicit primer lines (B) |
| R8 range leak / absent classes | MAJOR | qualitative-first + guard sentence + catalog-shape line (B) |
| R9 education contamination | MAJOR | intent-gated doc_types (§D.2 pattern) + authority 0.9 stamp (C.3) |
| R10 competitor-screen bypass | MAJOR | screen on education-citing public turns + C.4 review gate (C.3/C.4) |
| R11 internal RAG licensing | MAJOR | legal check in checklist + no-verbatim primer line (D/B) |
| R12 mangled code tables | MAJOR | curated Title 24/JA8 estimator data + 3-value spot-checks + force-vision (D) |
| R13 source-list revisions | MINOR | LM-63 optional, Handbook deferred, +MLO/ADA/DOE-labeling, edition-in-title, lighting_requirement primacy (D/B/C.1) |
| R15 SKU-first output / conditional AHJ | MINOR | name-first rows; unconditional AHJ + public no-determinations (A.2/B) |
| R16 empty-filter, deferred-doc truth, cache spike | MINOR | fallback behavior (A.2), Done row (G.7), noted (B) |

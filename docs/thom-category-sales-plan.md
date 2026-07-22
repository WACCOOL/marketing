# Thom Bot — Category Sales Plan (v2 — RECONCILED; awaiting Davis ratification)

**Status:** v2, 2026-07-21. v1 draft → counter-plan (objections CS1–CS17) → this reconciliation. **All seventeen adjudicated resolutions ADOPTED** (ledger at the end); the plan now awaits Davis ratification before build. Figures queried live against prod Supabase (service-role, READ-ONLY) 2026-07-21; join coverage is **sampled** (10k/5k/5k turnover pages + the full open-order snapshot), not exhaustive — the build's G.1 stage re-measures exactly with SQL. Per the repo-is-public rule this document carries **no dollar figures, no customer names, no revenue-mix percentages, and no bucket-dominance characterizations** — only row counts and join-coverage rates. The same rule binds the build: G.2 reconciliation results are never recorded in public files (CS15).

**Thesis.** An internal user asked Thom *"What are the sales of downlights today?"* and Thom (correctly, today) answered that it has no sales-aggregate capability. Every ingredient already exists in the warehouse: 1.76M invoiced turnover lines with `billing_date` and a per-line net value, a 7.7k-line open-order backlog snapshot, and a catalog (`products` + `product_spec_view`) that knows each product's brand, category, family, and class. Nothing joins them, nothing aggregates them, and no tool exposes them. The feature is one rollup layer + one internal-only `crm_*` tool, spanning **three planes**:

1. **Invoiced sales** (plane 1) — `turnover_orders`, the authoritative "what did we actually sell" record. Ships first.
2. **Backlog** (plane 2) — `open_orders` (`is_open=true`), the "what is ordered but not yet invoiced" snapshot. Ships with plane 1 (same join, same tool, one extra branch). **Covers WAC-family orders only; Schonbek backlog is not in this system** (CS4 — see §A.3).
3. **Pipeline/won/lost deals** (plane 3) — category mix of HubSpot deals (open pipeline, Closed Won, Closed Lost). **No local deal-line table exists today**; this plane needs a quote-line mirror first (§C) and ships as stage 2 of the same plan.

---

## Data audit (live 2026-07-21; coverage sampled)

| Fact | Value | Consequence |
|---|---|---|
| `turnover_orders` rows | 1,755,769 (WAC 1,705,587 / SCH 50,182) | plenty of history; every window query needs an index (see below) |
| `billing_date` range | 2023-12-29 → **2026-07-21 (today)** | same-day rows DO land intraday — "today" is answerable but **partial** |
| Lines yesterday / last 7d / MTD / YTD | 1,547 / 11,687 / 31,696 / 338,708 | YTD scan ≈ 339k rows — fine with an index, marginal without |
| **No `billing_date` index exists** (0038 indexes doc/sold_to/rep/quote/brand only) | `eq.` count probes on billing_date **timed out** during this audit | migration MUST add the **`(billing_date, brand)`** index before any tool ships (CS8 — column order is load-bearing, see §A.4) |
| `brand` column semantics | `WAC` \| `SCH` — this is the SAP **file** provenance (which turnover file the line came from), NOT the catalog brand of the product | two different brand concepts; the tool splits them into two parameters so the router cannot conflate a Schonbek-file filter with a Modern Forms catalog filter (CS3, §A.3) |
| Non-USD lines | `currency` is not uniformly USD (intl/export lines present) | rollups aggregate `currency='USD'` only; the RPC reports the excluded non-USD line/value **share** and the tool prints it; we never convert — there are no FX rates in this warehouse (CS2) |
| Turnover sync cadence | GH cron `7 */3 * * *`; files land ad hoc on SFTP; last ingest 2026-07-21 11:15 UTC (3 ingests that minute, all `succeeded`) | freshness = last succeeded `data_ingestions` row (`source='turnover'`), NOT "now"; worst case ~3h behind the file, file lag unknown → mandatory "as of" line |
| Value column semantics | `lineValue()` (`apps/turnover-sync/src/hubspot.ts:408`): `discounted_sales` unless 0, else `ytd_total` — channel-dependent (Home Depot / DS* drop-ship / some distributor volume zero DS), confirmed to the cent against Power BI 2026-07-09 | the SQL rollup must mirror `lineValue()` exactly, with a TS↔SQL parity test |
| Duplicate-credit lines | one invoice line credited to two reps = **two rows** (secondary usually qty 0); `groupOrders()` sums value over **qty≠0 lines only**; **counter-plan live probe: all 24 sampled split-credit pairs collapse to the correct single value under the qty≠0 rule** | rollup must filter `quantity <> 0` or it double-counts split-credit lines; sampled qty-0 share: 1.3% recent, 22.4% in the oldest pages. Rule verified clean — unchanged in v2 |
| Returns/credits | negative-value lines present (sampled old pages show negative class sums) | keep them — the answer is NET sales; document it in the tool output |
| Pseudo-materials | `CUSTOM`, `PARTS`, `ADJUSTMENT`, `DEFECTIVE ALLOWANC` appear as materials | land in the "unclassified" bucket honestly, never dropped |
| **Join coverage — turnover → catalog (sampled)** | WAC recent 10k lines: **92.0% of lines / 95.9% of value**; SCH recent 5k: **65.2% / 88.3%**; WAC oldest 5k: **76.4% / 56.8%** | make-or-break: viable for WAC and for recent windows generally; Schonbek and deep history need the unclassified bucket front-and-center — and coverage varies enough by year that multi-year windows need per-year coverage reporting (CS7) |
| Join mechanism | materials are **variant SKUs** (orderable matnr), essentially never the parent PPID (0 direct PPID hits in 15k WAC samples); `products.variants` jsonb holds variant→parent | need a variant→product map view (expand `variants`, ~75k variant SKUs over 4,390 products); the compat build's runtime `variant_search ilike` probe is per-SKU and unusable for set joins |
| Category/family/class reachability | resolved parent gives `products.brand/category/family` directly; `class` comes from `product_spec_view` (0059/0060 CASE; **0063 revises the CASE in the variant-grain base view + adds wall/bath**) | join `product_spec_view` for class → single source, automatically picks up 0063's revision when applied; the class-bucket distribution of resolved value (measured exactly in G.1, not recorded here) makes **category** (Sales Layer) the safer default grouping, class an alternative (CS15 wording) |
| `open_orders` | 53,327 rows, **7,652 open**; snapshot upsert (`is_open` flip), cron `37 */2 * * *`, last update 2026-07-21 10:39 UTC; 0 open lines with null material | plane 2 is cheap: same join; value = `line_net_value`; freshness = snapshot time; **no brand column** — `business_unit` **prod-verified: product-line codes, zero SCH values** → the backlog is WAC-family only, stated in the output (CS4) |
| Deal-line source (plane 3) | **no local quote-line table.** `hubspot_sync_records` = payload *ledger* only (31,741 deal payloads captured since 2026-06-22, bodies in R2); the Worker push already parses `payload.products` → HubSpot line items (`material__ → hs_sku`, `mapping.ts:131`) | capture-forward staging is a small hook in the existing push; history needs a HubSpot **deals-first** walk (§C — CS5; a raw line-items walk is off the table) |
| Deal conventions | qty-0 quote lines ≈ 42% and are **intentional quote text** (SAP zeroes, never deletes); Closed Lost value = `max_amount` **falling back to `amount`** (`lostValue()` = `num(maxAmount) ?? num(amount)`, `packages/shared/src/hubspot/dealRollups.ts:170,192` — CS9); Closed Won = `amount`; open quotes may be legitimately $0 | plane-3 unit/mix math excludes qty-0 lines; dollar totals stay at DEAL grain via the amount/max_amount conventions — never sum quote-line values for lost deals |
| Existing tool surface | internal-only `crm_*` extension: `agent.ts` injects `HUBSPOT_TOOLS` with `owns: name.startsWith("crm_")`; public surface hard-rejects any non-allowlisted tool (`tools.ts:1074-1076`); `CRM_GUIDANCE` lives only in `internalSystem()` | the new tool rides the same extension + prefix and inherits the public-surface hard-reject for free |
| RLS today | `turnover_orders`/`open_orders`/`data_ingestions` select = **bare per-row** `is_active_internal_or_admin()` policies (pre-InitPlan form) ; internal Thom retrieval runs as the **user** (`routes/thom.ts:116`, `userSupabase`) | SECURITY INVOKER RPC + existing RLS = the DB itself enforces internal/admin — but the bare policies re-evaluate the function per row on a 339k-row YTD scan; **0064 must rewrite them into the 0055 InitPlan form first** (CS1, §A.0) |

---

## A. Data layer — migration `0064_category_sales.sql`

**Numbering (CS13):** 0062 (feedback plan) and 0063 (attribute filter) were reserved in-flight and are now **MERGED as PRs #226/#227 — but the migrations are applied by Davis separately**, so re-check both `ls supabase/migrations` AND applied-state in the dashboard at build time. The 0063 class dependency is **contingent, not blocking**: this plan's join shape works from 0060's CASE either way; 0063 merely revises the CASE in place and this plan inherits the revision through `product_spec_view` whenever it is applied.

### A.0 RLS InitPlan rewrite + window bounds (CS1 — BLOCKER, ratified)

- 0064 **also drops and recreates the three bare per-row select policies** — `turnover_orders` (0038:55), `open_orders` (0025:60), `data_ingestions` (0019:76) — in the 0055 InitPlan form: `for select using ((select public.is_active_internal_or_admin()))`. Without this, every window scan pays a per-row function call; with it, Postgres hoists the check into an InitPlan evaluated once. Same policy names, same semantics, zero behavior change for callers.
- The migration's `explain analyze` gate **runs AS AN AUTHENTICATED JWT — never service role**. Service role bypasses RLS entirely, so a service-role plan proves nothing about the InitPlan hoist or the RLS cost the real user pays. The verify block records the authenticated-role plan.
- **Posture ratified (closes v1's §A.6 open question):** SECURITY INVOKER + per-user RLS **stays**, despite the `crm_*` HubSpot tools running on a service token. The audience is identical either way (`requireInternal` gates the surface, so exactly the same users can reach both), and the DB-level wall is worth having on raw dollars: a misrouted call yields zero rows from Postgres itself, not from tool-layer politeness.
- **Window bounds:** v1 caps explicit date ranges at **~2 years** (731 days); longer requests get a plain-English "narrow the window" reply. The monthly pre-aggregate table that would unlock arbitrary history is **deferred** (§G) — no measured need yet, and the cap keeps the worst-case scan bounded.

### A.1 Variant→product resolution map

`create view public.product_variant_map with (security_invoker = on) as` — lateral `jsonb_array_elements(products.variants)`, one row per variant SKU:
`variant_key` (= `upper(btrim(v->>'sku'))`, the `normalizeSkuKey` convention from `accessories/parse.ts` — both sides of every lookup normalize identically), `product_sku`, plus pass-through `brand, category, family, is_accessory`. Parent PPIDs are ALSO emitted as rows (`variant_key = upper(sku)`) so the rare direct-PPID material still resolves. ~75k rows expanded from 4,390 products — small enough that a plain view hash-joins fine; **no materialization in v1** (the products table re-syncs daily; a matview adds a refresh obligation for zero measured need — G.1 re-checks with `explain analyze`).

**Collision rule (CS16, threshold encoded):** duplicate variant keys are broken deterministically by `distinct on (variant_key) … order by variant_key, product_sku` — but this survives **only if G.1 measures disagreeing-parent collisions** (same variant key resolving to parents that differ in brand/category/family/class) **at < 0.1% of window value**. At or above the threshold, colliding keys are excluded from resolution and route to `(unclassified)` instead — an honest bucket beats a deterministic-but-arbitrary attribution. The 0.1%-of-value threshold is written into the G.1 gate, not left to build-time judgment.

### A.2 Value + dedup semantics (parity with the HubSpot push, or the numbers diverge from every dashboard)

- `thom_line_value(ds numeric, ytd numeric)` — IMMUTABLE SQL mirror of `lineValue()`: `case when coalesce(ds,0) <> 0 then ds else coalesce(ytd,0) end`.
- Aggregate only `quantity <> 0` lines (the `groupOrders()` rule): kills the secondary-rep duplicate rows and the rebate/text lines, and matches the order totals already pushed to HubSpot. **Verified live in the counter-plan review: all 24 sampled split-credit duplicate pairs collapse correctly under this filter.**
- **USD only (CS2):** aggregate `currency = 'USD'` lines exclusively. The RPC returns the excluded non-USD **line share and value share** for the window; the tool prints one line whenever it is nonzero ("excludes N% of lines (M% of value) in non-USD currencies"). We **never convert** — there are no exchange rates in this warehouse, and a silent mixed-currency sum is a wrong number wearing a right-looking unit.
- Negative lines (returns/credits) stay in: outputs are NET. Units = `sum(quantity)`; orders = `count(distinct billing_document)`.
- The migration verify block carries the `groupOrders.test.ts` literals as SQL asserts: `(62.25, 622.2) → 62.25`, `(0, 203) → 203`, `(null, 203) → 203`, `(0, null) → 0`.

### A.3 Rollup RPCs

`thom_sales_by_category(p_plane text, p_date_from date, p_date_to date, p_group_by text, p_file_brand text, p_catalog_brand text, p_class text, p_category text, p_family text, p_top_n int)` — SECURITY INVOKER, pinned `search_path`, `p_`-prefixed args (the 0063 ambiguity lesson), `p_group_by` whitelisted to `('category','class','family','brand','product')`, `p_top_n` clamped (default 10, cap 25).

**Two brand parameters, never one (CS3):**
- `p_file_brand` — `WAC` | `SCH`: filters `turnover_orders.brand`, i.e. which SAP turnover file the line came from. This is a data-provenance filter.
- `p_catalog_brand` — filters (and `group_by='brand'` groups) the **resolved catalog brand**, through a label map that normalizes Sales Layer brand codes to display names: `WAC → WAC Lighting`, `MOF`/`MFF → Modern Forms`, Schonbek sub-brand codes → their Schonbek display names, `AISPIRE → aiSpire`, etc. (exact map enumerated from `products.brand` distinct values at build).
- The tool schema spells out **both** parameters with these exact meanings so the router model cannot conflate "Schonbek's file" with "products branded Schonbek" — they differ wherever cross-brand materials ride one file.

Branches:

- **plane `invoiced`:** `turnover_orders` filtered `billing_date between p_date_from and p_date_to` (+ optional `p_file_brand`), `currency='USD'`, qty≠0, value via `thom_line_value`; left-join `product_variant_map` on the normalized material, then `product_spec_view` (on `product_sku`) for `class` — the class CASE stays in exactly one place and this plan inherits 0063's wall/bath revision the day its migration is applied. Group rows where the join misses fall into group_key **`(unclassified)`** — returned as a first-class row, never dropped (§A.5).
- **plane `backlog`:** `open_orders` where `is_open`, value = `line_net_value`, units = `order_qty`, orders = `count(distinct so)`. Date args must be NULL — backlog is a *snapshot*, not a time series; the function raises on a dated backlog request as a **backstop**, but the TS layer normally prevents this from ever firing (CS17, §B). No `p_file_brand` here: **`business_unit` is prod-verified as product-line codes with zero SCH values — the backlog is WAC-family only**, and both the RPC comment and the tool output say so (CS4). The product-line codes themselves are noted as a free future grouping (§G).
- **plane `pipeline`:** stage 2, over the §C mirror; same signature, plus `p_deal_bucket in ('open','won','lost')`. Lost value = `max_amount` **with `amount` fallback** — the `lostValue()` convention, fallback included (CS9).

**Returns per group:** `group_key, net_value, units, line_count, order_count`, plus honest denominators on every row: `total_value, resolved_value, resolved_line_pct`, and the non-USD exclusion shares (CS2).

**Coverage denominators are WINDOW-WIDE (CS7):** computed after `p_file_brand` but **before** any category/class/family filter — so a class-filtered answer still shows what share of the *whole window* resolved, and the unclassified share cannot vanish just because the user asked about downlights. For windows crossing a calendar-year boundary, the RPC returns a **per-year coverage breakdown** (coverage swings from ~96% to ~57% of value across years in the samples); if the tool elects to print a single number it must carry an explicit variance warning instead.

Companion `thom_sales_freshness(p_plane text)`: latest succeeded `data_ingestions` row for `source='turnover'` (or the open-orders source), `max(billing_date)`, `max(updated_at)`. One place computes the "as of" facts; the tool never invents them.

### A.4 Index (load-bearing; column order pinned — CS8)

`create index … turnover_orders_billing_brand_idx on public.turnover_orders (billing_date, brand)` — **`billing_date` leads, pinned.** A brand-leading `(brand, billing_date)` index cannot serve the common *unfiltered* window scan ("sales of downlights this month" spans both files) without a skip-scan Postgres doesn't do; date-leading serves both the unfiltered range scan and the brand-filtered one (brand as an index filter suffix). This audit's `eq.billing_date` probes **timed out on prod** without any date index; every window in this feature filters on it. Also verify the `open_orders (is_open)` partial path is adequate (0025 already indexes `is_open`).

### A.5 Unresolved-material honesty

Sampled unresolved share: WAC recent ≈ 8% of lines (≈4% of value), Schonbek ≈ 35% of lines (≈12% of value — legacy/custom codes like crystal-run SKUs), WAC deep history up to ≈43% of value (catalog churn + `ADJUSTMENT`-type pseudo-materials). Rule: the `(unclassified)` bucket appears in every grouped answer, sized, with one fixed explanation ("materials that don't resolve to the current product catalog — custom, legacy, parts, and adjustment lines"). Silently dropping it would misstate totals by double-digit percentages on Schonbek and any multi-year window. The RPC's window-wide `resolved_line_pct` (CS7) makes the omission impossible for the tool to hide — even under a class filter.

### A.6 Security posture (ratified — CS1)

- Both new views + both RPCs: `security_invoker = on` / INVOKER; **grant select/execute to `authenticated` ONLY — never `anon`** (and explicitly `revoke … from anon, public` — a view has its own ACL, 0059's lesson).
- The real wall is RLS: `turnover_orders`, `open_orders`, `data_ingestions` are `is_active_internal_or_admin()` selects — rewritten to the InitPlan form in this same migration (§A.0) — and internal Thom queries run as the user (`userSupabase`). A non-internal authenticated user reaching the RPC gets zero rows from the database itself, not from tool-layer politeness. The tool detects the zero-rows-with-zero-total case and answers "no access to sales data" rather than "zero sales".
- The v1 open question on posture asymmetry (per-user RLS here vs service-token `crm_*`) is **closed**: adjudication ratified keeping the stricter posture. Audience is identical (`requireInternal`), so the asymmetry costs nothing, and the DB-level wall on raw dollars is worth it.

---

## B. Tool — `crm_sales_by_category` (internal-only, same injection path as every `crm_*` tool)

**Composition.** New `apps/api/src/thom/salesTools.ts` (schemas + dispatch, Supabase-backed via `ctx.sb` — the user-RLS client). `agent.ts` composes ONE internal extension: `tools: [...HUBSPOT_TOOLS (when HUBSPOT_READ_TOKEN), ...SALES_TOOLS (when THOM_CATEGORY_SALES=1)]`, `owns: name.startsWith("crm_")` unchanged, dispatch routed by name. The `crm_` prefix is what buys the guarantees: prompts advertise it only in `internalSystem()` (flag-gated — §D/CS6), the shared brain's public allowlist hard-rejects it (`tools.ts:1074-1076`), and `anonBoundary.test.ts` gets one more assertion. Nothing about this tool exists on `apps/thom-bot` (public) — no flag there, no schema there, nothing to leak.

**Inputs.**
- `window`: `today | yesterday | this_week | last_week | mtd | qtd | ytd | last_year`, or explicit `date_from`/`date_to` (ISO). **Windows resolve in TS, in `America/New_York`** — `billing_date` is an SAP business date; a UTC "today" is wrong for ~4h every evening (the closedate noon-UTC lesson, applied preemptively). Never let the model compute dates. **The schema pins the calendar conventions the model would otherwise guess (CS12): weeks are Monday-start ET; `qtd`/`ytd` are CALENDAR quarters/years, not fiscal.** Explicit ranges are capped at ~2 years (§A.0); longer gets a "narrow the window" reply.
- `plane`: `invoiced` (default) | `backlog` | `pipeline` (stage 2; until then the tool returns a one-line "not yet available — I can show invoiced sales or open-order backlog instead").
  - **Backlog window handling (CS17):** router models habitually fill `window` on every call. For `plane:'backlog'` the TS layer **silently DROPS** `window` and any non-explicit date args — *translate, don't raise*. Only an **explicitly dated** backlog request (`date_from`/`date_to` supplied) gets the plain-English explanation that backlog is a point-in-time snapshot with no date dimension. The RPC's raise (§A.3) remains as a backstop that should never fire in practice.
- `group_by`: `category` (default) | `class` | `family` | `brand` | `product`; optional filters `file_brand` (WAC|SCH — SAP file provenance), `catalog_brand` (display-name brand via the §A.3 label map — the schema spells out both meanings, CS3), `class`, `category`, `family`; `top_n` (≤25). **The schema enumerates the legal `class` values verbatim from the 0060/0063 CASE (CS12)** so the model filters on real buckets, not invented ones.
- Drill-down is the same tool, narrowed: *"which downlight families sold most this month"* → `{window:'mtd', class:'downlight', group_by:'family'}`. The description spells out exactly that example so the router model copies it.

**Output (text-only, no cards, row-capped — the `crm_*` house pattern).**

```
Invoiced sales, downlights (class), MTD Jul 1–21:
1. <family/category rows: net value, units, orders>
...
(unclassified): <value> — materials not in the current catalog (custom/legacy/parts/adjustments)
Note: order counts are per-group and NOT additive across rows (one order spans categories).
Excludes <n>% of lines (<m>% of value) in non-USD currencies (no conversion available).
Coverage: 92% of lines (96% of value) resolved to the catalog for this window. [multi-year: per-year breakdown or variance warning]
As of the last turnover sync, 2026-07-21 07:15 ET (data through billing date 2026-07-21 — today's figures are PARTIAL: invoices post throughout the day and files arrive on a ~3-hour sync).
```

- **The freshness line is mandatory and non-negotiable** — built from `thom_sales_freshness()`, appended by the tool (not left to the model). For `today`/current windows it always carries the PARTIAL warning; for `backlog` it reads "backlog snapshot as of HH:MM ET" instead. Negative nets print as "net of returns/credits".
- **Unit labeling (CS10):** quantity sums are labeled with the class's unit of measure. For `per_ft` classes (tape, channel) unit sums are either printed as **feet** or **suppressed** — never presented as bare "units" alongside each-goods, where the number is meaningless.
- **Order counts (CS11):** `order_count` is flagged non-additive across groups in the output template (one billing document spans multiple categories; summing the column double-counts). The template carries the fixed footnote above.
- **Backlog scope (CS4):** every `backlog` answer AND the tool description state: "backlog covers WAC-family orders only; Schonbek backlog is not in this system."
- Guidance + description both state: figures are internal business data; never present them as real-time; never extrapolate a full day from partial data.

---

## C. Plane 3 — deals by category (stage 2; the aggregation-source audit)

**The question:** "how much downlight business is in the pipeline / did we win / did we lose this year?" needs deal lines (SKU-grade) joined to the same catalog map, with deal-level stage/amount context.

**Source audit — three candidates:**

| Option | Verdict |
|---|---|
| (a) HubSpot line-items API at question time | REJECTED for answering: search API caps + per-question latency over ~10⁵ line items; a chat turn cannot walk HubSpot |
| (b) Capture-forward mirror from the Worker push | ADOPTED for steady state: `hubspotPush.ts` already parses `payload.products` per deal (`material__ → hs_sku`, qty, values, `quote_product_name` line key) — a ~30-line hook upserts lines + deal header into a new `deal_quote_lines` table at push time. Zero new API traffic. Limitation: only quotes SAP touches post-deploy; the R2/`hubspot_sync_records` capture reaches back only to 2026-06-22 (31,741 deal payloads) — NOT history |
| (c) One-time (then weekly) **deals-first HubSpot walk** via `HUBSPOT_READ_TOKEN` (CS5) | ADOPTED for backfill + staleness repair, with the shape pinned below — **never a raw `line_items` object walk** |

**The walk shape (CS5, pinned):** the `line_items` object in this portal also holds the **1.76M turnover order lines** pushed by turnover-sync — a raw line-items walk is mostly wrong-object traffic and blows every budget. Instead: **deals first** — the deals *search* API sharded by `dealstage × createdate` windows so no shard exceeds the 10k search-offset cap → per-deal v4 associations to line items → batch-read the line items. Budget: **~60–80k calls weekly at ~120ms pacing ≈ a few hours** — acceptable for a weekly background job (prior art for the association/batch mechanics: `scripts/hubspot-dedup-lineitems.mjs`; the sharded-search discipline is this plan's addition).

**Capture-hook semantics (CS14, pinned):**
- Staging table PK = **`quote_product_name`** — the portal's line-item idProperty (`mapping.ts`), the same key the push itself upserts by. Deal key = **`sap_quote_number`**.
- An **empty or missing `payload.products` is a NO-OP — never a delete**. SAP payload shapes vary by transaction type; an absent array must not be read as "this quote now has no lines". Line removal happens only through the weekly walk's reconciliation, deliberately, with counts logged. (The HubSpot-line-items-zeroed lesson, applied to the mirror: SAP zeroes, never deletes — so neither do we.)

**Conventions (pinned, from hard-won memory):**
- qty-0 quote lines (~42%) are intentional quote text — excluded from unit counts and mix math, exactly like plane 1's qty≠0 rule (different reason, same filter).
- Dollar totals stay at **deal grain**: open = `amount` (may be legitimately $0 — SAP zeroes unreferenced quote lines; never "fix" it), won = `amount`, **lost = `max_amount` with `amount` fallback** — encode `lostValue()` exactly (`num(maxAmount) ?? num(amount)`, `dealRollups.ts:170,192`), not the max_amount-only shorthand (CS9). Category *attribution* of a deal's dollars uses its line-mix as weights; when a deal's line values are all zeroed, the tool reports line/qty mix only and says value attribution is unavailable for that slice — refusing beats inventing (the 0063 depth rule, applied to money).
- Freshness line: "pipeline mirror as of last SAP push HH:MM / last weekly reconcile <date>".

Plane 3 ships behind the same flag but as a separate build stage with its own migration (`deal_quote_lines` + RLS internal-only + indexes), after Davis picks (b)+(c) or defers.

---

## D. Prompt guidance (CRM_GUIDANCE extension, `internalSystem()` only — FLAG-GATED, CS6)

**The new guidance text is parameterized, never static.** `internalSystem()` already composes conditionally (the `hasSpecRank` idiom); the sales bullets render **only when `THOM_CATEGORY_SALES=1`** reaches the prompt builder. Static guidance while the tool is flagged off would advertise a tool that doesn't exist — the model would promise sales aggregates it cannot fetch, or hallucinate them. Flag off ⇒ zero mention anywhere in the prompt; flag on ⇒ guidance and tool appear together, atomically.

Appended (under the flag) to the existing block:
- "For PRODUCT-TYPE sales questions — 'sales of downlights today', 'top families this month', 'how much tape did we sell YTD', 'what's in the backlog for fans' — use `crm_sales_by_category` (window/file_brand/catalog_brand/class/category/family, grouped rollups). This is INVOICED sales history and open-order backlog (backlog = WAC family only), not real time: always keep the tool's as-of line, and never extrapolate a partial day."
- "It aggregates by product category; for a SPECIFIC customer's history keep using `crm_get_invoice_history`."
- Routing seam: `crm_top_companies` owns "top companies by sales"; this tool owns "sales by product type". One sentence in each description drawing that line, plus the `analyticsWords/analyticsSources` bucket mapping (the 0059 A10 lesson — otherwise the dashboard shows `Other (…)`).

## E. Tests

1. `salesTools.test.ts` (apps/api): schema shape (incl. enumerated class values + pinned week/quarter conventions, CS12); dispatch routing (`crm_sales_by_category` → sales dispatch, `crm_get_company` still → HubSpot dispatch); freshness line always present; `(unclassified)` row rendered when the RPC returns it; non-USD exclusion line rendered when share > 0 (CS2); order-count footnote + per-class unit labeling incl. per_ft suppression (CS10/CS11); backlog answers carry the WAC-family-only line (CS4); zero-rows-zero-total → "no access / no data" wording, never "$0 sales".
2. Window resolution unit tests (pure TS, `America/New_York`): today/yesterday across a DST boundary and across midnight ET vs UTC; Monday-start weeks; calendar qtd/ytd; explicit range passthrough + the ~2-year cap refusal (CS1); **`plane:'backlog'` + window → args dropped, RPC called date-less; backlog + explicit dates → plain-English snapshot explanation, RPC never called with dates** (CS17).
3. TS↔SQL value parity: the `groupOrders.test.ts` literals asserted in the 0064 verify block (SQL) and referenced from a comment beside `lineValue()` so neither side drifts alone.
4. `anonBoundary.test.ts` + `publicFilter` assertion: the tool name is absent from every public tool list and hard-rejected if injected. Prompt-composition test: sales guidance absent from `internalSystem()` output when the flag is off, present when on (CS6).
5. Plane-3 (stage 2): capture-hook NO-OP on empty/missing `payload.products` — table row count unchanged, no deletes issued (CS14); `lostValue()` fallback literals (CS9).
6. Migration verify block (recorded results, house style): coverage-by-brand-by-year counting SQL (the exact G.1 queries), disagreeing-parent collision share vs the 0.1% threshold (CS16), non-USD share, `explain analyze` of a YTD rollup **as an authenticated JWT** showing both the new index and the InitPlan hoist on all three rewritten policies (CS1), RLS probe as a non-internal user → zero rows.

## F. Rollout (gated, standard idiom)

- **Flag `THOM_CATEGORY_SALES`** — `ThomEnv` member (shared `env.ts`), read in `apps/api` `agent.ts` composition AND `internalSystem()` guidance (CS6); enabling = one committed `vars` edit in `apps/api/wrangler.jsonc`. **No `apps/thom-bot` edit exists in this plan at all** — internal-only by construction.
- G.1 Migration 0064 first, flag off: run the counting SQL (exact coverage per brand **per year**, disagreeing-parent collision share → apply the CS16 0.1% rule, non-USD share, class/category distribution of resolved value), record in the migration header (counts and rates only — no dollar figures, per the repo-public rule). Verify the InitPlan rewrite + index via authenticated-JWT `explain analyze` (CS1). If exact WAC-recent coverage lands materially below the sampled 92%/96%, stop and reconcile before any tool ships.
- G.2 Tool + guidance behind flag; internal soak; eyeball vs Power BI YTD for 2-3 known slices (the same reconciliation that blessed `lineValue()`). **Reconciliation results are recorded as pass/fail + relative deltas only — NO dollar figures in the PR body, migration header, this doc, or any other public file (CS15).**
- G.3 Enable in prod internal. Watch `thom_chat_analytics` for routing misses ("sales of X" turns that didn't call the tool) and for file-brand/catalog-brand confusion in tool args (CS3).
- G.4 Stage 2 (plane 3): `deal_quote_lines` migration + push hook (CS14 semantics) + deals-first walk script (CS5 shape), own verify block, same flag.

## G. Deferred

- **Monthly pre-aggregate table** — unlocks explicit ranges beyond the ~2-year cap without unbounded scans (CS1); build only when someone actually asks for deep history.
- `open_orders.business_unit` (product-line codes) as a free backlog grouping dimension (CS4).
- Plane-3 v2: quote→order conversion by category (join `quotation_ref` ↔ `sap_quote_number`).
- Showroom orders channel (21 Google Sheets → deals; no line items exist) and OA international (header-grain `oa_records`; lines only inside `raw_json`) — both out of scope until someone asks for them by name. (OA is also the main non-USD population — its exclusion is what CS2's share line surfaces.)
- Per-customer × category cross-cuts ("what does account X buy most") — needs the same rollup keyed by `sold_to` + the company-parents hierarchy; deliberately not in v1's schema so the tool surface stays small.
- Rep-code / territory × category cross-cuts; time-series ("monthly downlight trend") output shapes.
- Materialize `product_variant_map` if G.1's `explain analyze` says so.
- Currency conversion (needs an FX-rate source that does not exist in this warehouse; until then USD-only + disclosed exclusion share is the honest posture — CS2).

## Davis checklist (ratification)

- [ ] **Ratify v2** (CS1–CS17 resolutions adopted as written; ledger below).
- [ ] Ratify the value semantics: `lineValue()` mirror + qty≠0 dedup (24-pair live evidence) + USD-only with disclosed exclusion = parity with the HubSpot order totals and the Power BI reconciliation (§A.2). This is THE correctness decision.
- [ ] Confirm "today is PARTIAL" framing (vs refusing intraday windows outright).
- [ ] Accept the `(unclassified)` bucket + window-wide coverage sentence as mandatory output (esp. Schonbek ≈35% of lines, and per-year breakdown on any multi-year window).
- [ ] Default grouping `category` (not `class`) until 0063's wall/bath revision is applied — the G.1-measured class distribution stays out of this file per the repo-public rule (CS15).
- [ ] Plane 3: approve capture-forward mirror + deals-first walk backfill (§C options b+c, CS5/CS14 shapes), or defer plane 3 entirely.
- [ ] Confirm no SFTP-side cadence change is wanted (files land ad hoc; the tool only ever claims "as of last sync").
- [ ] Migration number 0064 — 0062/0063 merged as PRs #226/#227 but applied separately by Davis; re-check file list AND applied-state at build (CS13).

## Open questions from v1 — all closed in reconciliation

1. Collision rule → **CS16**: `distinct on` survives only under the <0.1%-of-value disagreeing-parent threshold; otherwise collisions route to `(unclassified)`.
2. Backlog as separate tool vs plane param → **plane param stays**; the date-args seam that motivated the question is dissolved by CS17's translate-don't-raise rule.
3. Weekly HubSpot walk load → **CS5**: deals-first sharded walk, ~60–80k calls at ~120ms pacing ≈ hours, acceptable weekly; it does NOT ride the daily reconcile.
4. `business_unit` / Schonbek backlog → **CS4**: prod-verified product-line codes, zero SCH; plane 2 is honestly WAC-family only and says so in every answer.

## Adjudication ledger

| Obj | Sev | Resolution |
|---|---|---|
| CS1 bare RLS policies + unproven plan + unbounded windows | BLOCKER | 0064 rewrites turnover_orders (0038:55) / open_orders (0025:60) / data_ingestions (0019:76) policies to the 0055 InitPlan form; explain-analyze gate runs as authenticated JWT, never service role; explicit ranges capped ~2y, monthly pre-agg deferred; SECURITY INVOKER + per-user RLS posture ratified (§A.0/A.6/G) |
| CS2 mixed-currency sums | MAJOR | USD-only aggregation; RPC returns excluded non-USD line/value share; tool prints it; never convert — no FX rates exist (§A.2/B) |
| CS3 one brand param, two brand concepts | MAJOR | split `p_file_brand` (WAC\|SCH file provenance) vs `p_catalog_brand` (SL-code label map → display names); both spelled out in the tool schema (§A.3/B) |
| CS4 Schonbek backlog silently absent | MAJOR | plane-2 output + description state WAC-family-only; `business_unit` prod-verified as product-line codes, zero SCH; codes noted as future grouping (§A.3/B/G) |
| CS5 raw line_items walk unworkable | MAJOR | deals-first walk: dealstage × createdate sharded search (10k offset cap) → v4 associations → batch line-item reads; ~60–80k calls weekly at ~120ms ≈ hours, acceptable (§C) |
| CS6 static guidance while tool flagged | MAJOR | CRM_GUIDANCE extension flag-gated via parameterized internalSystem() (hasSpecRank idiom); prompt-composition test both ways (§D/E) |
| CS7 coverage denominator vanishes under filters | MAJOR | denominators window-wide (post file-brand, pre category/class filter); multi-year windows get per-year coverage breakdown or explicit variance warning (§A.3/A.5) |
| CS8 index column order contradiction | MAJOR | pinned `(billing_date, brand)` — brand-leading cannot serve unfiltered window scans; audit-table line corrected to match (§A.4) |
| CS9 lostValue missing fallback | MINOR | encoded as max_amount WITH amount fallback (`num(maxAmount) ?? num(amount)`, dealRollups.ts:170,192) (§C) |
| CS10 meaningless mixed-UoM unit sums | MINOR | quantity sums labeled per class UoM; per_ft classes feet-labeled or suppressed (§B) |
| CS11 order_count summed across groups | MINOR | fixed non-additivity footnote in the output template (§B) |
| CS12 schema under-pins calendar + class vocab | MINOR | schema pins Monday-start weeks, calendar (not fiscal) qtd/ytd, and enumerates legal class values from the 0060/0063 CASE (§B) |
| CS13 migration-number race | MINOR | 0062/0063 reserved in-flight, now MERGED (PRs #226/#227) but applied by Davis separately; 0063 dependency contingent — join shape works from 0060 either way (§A header) |
| CS14 capture hook could mass-delete | MAJOR | empty/missing `payload.products` = NO-OP, never delete; staging PK = `quote_product_name` (portal line idProperty), deal key = `sap_quote_number`; removals only via the weekly walk, logged (§C) |
| CS15 mix disclosures in a public repo | MAJOR | both "dominated by other bucket" lines scrubbed to neutral wording; G.2 reconciliation records NO dollar figures in public files; rule added to the header (header/audit/G.2/checklist) |
| CS16 distinct-on hides real collisions | MINOR | keep distinct-on ONLY if G.1 shows disagreeing-parent collisions <0.1% of value; else collisions route to `(unclassified)`; threshold encoded in the G.1 gate (§A.1/F) |
| CS17 backlog window args raise on routine calls | MINOR | TS layer DROPS window args for `plane:'backlog'` unless explicitly dated — translate, don't raise; RPC raise kept as never-fires backstop (§B/E) |

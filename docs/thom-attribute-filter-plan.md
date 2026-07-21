# Thom Bot — Attribute-Filter Upgrade Plan (v2 — RECONCILED)

**Status:** v2 — RECONCILED, 2026-07-21. Architecture objections A1–A13 and behavior objections O1–O13 adjudicated — **all adopted**; ledger at the end of this doc. Awaiting Davis ratification, then build on the plan→counter-plan→build loop. Figures queried live against prod Supabase (service-role, read-only) 2026-07-21. Builds directly on the RATIFIED lighting-expert plan's Prong A (`docs/thom-lighting-expert-plan.md`, migrations 0059/0060, `rank_products_by_spec`, `THOM_SPEC_RANK` now enabled on both surfaces).

**Thesis.** A user asked for vanity lights **"no wider than 15 inches"** and Thom returned a **20-inch Slim Bath & Vanity**. Superlatives got fixed by Prong A's rank tool; *constraints* did not: there is still no way to FILTER the catalog by a numeric attribute, so on "less than 15 inches wide, more than 1000 lumens, no more than 4 inches deep" the model runs `search_products("vanity light")`, gets a semantically-plausible list, and guesses. Dimensions are not searchable anywhere — they ride inside `products.variants` jsonb (`dimensions_mm`, built by `variantDims()` in `apps/api/src/saleslayer.ts:759-770`) and neither `product_semantic_search` (0043) nor `product_spec_rank` (0059) can see them. Three gaps, three sections:

1. **No numeric attribute surface for dimensions/CCT/CRI/IP** — 0059's view parses only lumens/watts and aggregates to one row per product, destroying the per-variant sizing the filter needs. → **A: variant-grain BASE view + parsers (migration 0063), with `product_spec_view` rebuilt on top of it.**
2. **No filter capability** — rank answers "which is highest", not "which satisfy X ∧ Y ∧ Z". → **B: `product_spec_filter` RPC (filter-first, semantic-ordered); C: `filter_products` tool + `get_product` dimension surface.**
3. **No prompt contract for constraints** — nothing tells the model a stated numeric limit is a hard predicate it must enforce, not a preference. → **D: constraint bullet + rebuilt `CONSTRAINT_INTENT` escalation over recent history.**

## Data audit (live 2026-07-21)

| Fact | Value | Consequence |
|---|---|---|
| Products / non-accessory / variants (under non-accessory) | 4,390 / 3,884 / 36,308 | — |
| Variants with numeric `dimensions_mm.width` / `.height` / `.length` | 36,289 / 36,286 / 36,271 (**99.9% each**) | dimensions are the BEST-covered spec in the catalog — far better than product lumens (9% variant, see below) |
| `.diameter` / `.depth` | 4,377 (12.1%) / **0** | `depth` exists in the `DimsMm` type but NO Sales Layer field maps to it (`VARIANT_DIM_FIELDS`, `saleslayer.ts:70-76`) — "depth" must be DERIVED, never read |
| **`.diameter` provenance (A11)** | `VARIANT_DIM_FIELDS` maps BOTH `zbodydia` AND `zcnpydia` (canopy dia) → `diameter`, first-match-wins (`saleslayer.ts:70-76,765`) | for variants where only the canopy diameter is populated, `diameter` is the CANOPY, not the body — a pendant can read "wider" than it is. Documented in the 0063 migration header; G.1 runs a diameter-distribution probe by class to bound the contamination before trusting `width_in` on diameter-only rows |
| **Variants with numeric `lumens` (O2)** | **944 of 3,884 non-accessory products (24%)** carry ≥1 variant with a numeric `lumens` — concentrated exactly in multi-size vanity/linear families (e.g. Lightstick: 19 in variant = **1,268 lm** vs product-max **6,342 lm**) | the products where size-vs-brightness conjunction matters most are the ones that HAVE per-variant lumens; conjunction must use the variant's own row where present (B) |
| Non-accessory products with ≥1 dimensioned variant | 3,524 / 3,884 (**90.7%**) | honest-coverage line has a strong denominator |
| Brand skew (products with dims) | Signature/MOF/Beyond/DWEL/Forever ≈100%; **WAC 76.0%**, AISPIRE 79.7%, LIM 79.2%, MFF 82.2% | the gap is WAC-family + junk categories (`292` 10.0%, `0` 19.6%) — mostly retired/unclassified rows |
| Unit sanity (mm) | width p50 133 mm = 5.3 in, p95 914 mm = 36 in; diameter p50 5.0 in | values are genuinely mm (synced at `unitToMm("in")` = 25.4, `saleslayer.ts:224,746`); no unit drift found |
| Outliers | 355 widths <10 mm or >4,000 mm — ALL explainable: 8.13 mm = real tape cross-section; length max 30,480 mm = 100 ft tape reel | per-foot rows need special width/length handling (A.2) |
| **Axis semantics** | Slim Bath & Vanity (SKU 3554): **W=2.6 in, H=5.0 in, L=18/24 in** — Sales Layer `zwidth_fix` is the wall PROTRUSION for bath bars; the user's "width" is `zlength_fix`. Counter-example Remi (3210): W=4.8, **H=16/24**, L=3.9 (long axis recorded in height — a vertically-mounted bar) | filtering raw `width` would repeat the vanity failure in mirror image (Slim would pass "≤3 in wide"); user-facing width/depth must be DERIVED and CLASS-AWARE (A.2) — the central design problem |
| Per-product width spread across variants | 2,991 of 3,517 width-bearing products are multi-variant; 235 spread >5%, **48 spread >2×** (Fuse vanity 16/27/37 in; Interlace 5.5–26 in) | product-level filtering conflates sizes → predicates MUST evaluate per variant; note `products.dimensions_mm` is one representative variant's dims (`saleslayer.ts:432-433`), NOT an aggregate — never filter on it |
| `cct_desc` coverage / shapes (digits→#) | 29,237 (80.5%): `#K` 24,056; range `#K-#K`/`#K - #K` 2,332; selectable lists `#K/#K/#K…` ~1,970; `#K, #K, #K, #K` 201; `R, G, B, #K - #K` 239; prose (`Amber`, `Color Changing`) 237 | selectable LISTS parse to `cct_values int[]` (exact membership); ONLY true ranges/tunables get containment (A8/O7) — a `2700K/5000K` selectable must NOT match a 3000K request |
| `cri` coverage / shapes | 28,777 (79.3%), ALL plain `#` (literals: 90×18,469, 85×8,788, 98×1,384, 95×110, 80×52) | trivially parseable with the existing `product_spec_parse_num` |
| `ip_rating` coverage / shapes | 10,860 (**29.9%**): `IP#` 8,324; bare `#` 1,868 (20/44/65); `No/no/NO` 711; `Damp Location` 12 | low coverage — IP filter ships but its honesty line matters most; "No"/prose → null |
| `beam_desc` | 20,703 (57.0%) but CATEGORICAL prose (Flood/Spot/Narrow/…, three spellings of "Asymmetrical") — no numbers | not numerically filterable → deferred (H); numeric beam angle lives in `ies_metrics` |
| `volt_in` | 26,970 (74.3%): `#-# VAC`, `#V`, `# VAC`, `# VDC`, … | parseable but low ask-rate → deferred (H), decision for Davis |
| `products.raw_json` product-level dimension fields | **none** — the only dim-like keys in a 200-product scan are `zmatextim` ("N/A"), `dim_report` (`[]`), `zmatdimrep` (a PDF filename), `zdimm_type` (Interior/Exterior) | variants are the ONLY dimension source; no product-level rescue exists |
| Anon readability | 0052 whitelists `variants`, `dimensions_mm`, `embedding` on `products` to anon | the public surface works by construction; same VERIFY-AS-ANON posture as 0059 |
| Class buckets today (O9) | vanity/bath products land in class **`other`** under the 0060 CASE — there is NO wall/bath bucket | §B's v1 sample line labeled Slim "decorative"; that was wrong. 0063 adds a wall/bath bucket to the class CASE (now that the CASE lives in the new base view, this is a one-place edit) |

---

## A. Variant-grain spec surface — migration 0063

> **Numbering (A5):** the feedback plan took **0062**; this migration is **`supabase/migrations/0063_product_spec_filter.sql`**. Re-check `ls supabase/migrations` at build time — the number moves again if anything else lands first.

### A.1 The variant-grain view is the BASE; `product_spec_view` is rebuilt on top (A6b)

v1 had the variant view *join* `product_spec_view` — which means two independent `jsonb_array_elements(variants)` expansions (0059's view already expands variants to aggregate lumens) plus view-to-view join work on every scan. Rejected. Adopted inversion, all in 0063:

- **`create view public.product_variant_spec_view with (security_invoker = on)`** — one row per variant, and the ONLY place `jsonb_array_elements(variants)` runs. Everything lives here:
  - Guarded numeric reads of `dimensions_mm`: `width_mm, height_mm, length_mm, diameter_mm`; guarded numeric read of the variant's **`lumens`** (`variant_lumens`, O2); `sku, variant_sku, finish`.
  - **The class CASE** (moved from 0060's view body into this base view — still exactly one place, per the shipped plan's R4 no-TS-mirror rule), extended with a **wall/bath bucket** (O9) so vanities/sconces stop landing in `other`.
  - Product-level columns read directly off `products` (same row, no join): `name, brand, category, is_accessory`, **`per_ft` computed per variant row** (A10 — the per-foot flag is a row-level property of the variant's data shape, applied where the exception is applied, A.2), parsed `cri`, `ip`, CCT columns, product-level `lumens_max/watts_max/efficacy` via the 0059 parse/scope machinery. `security_invoker` composes: photometrics-derived lumens still respect the 0048 scope RLS for anon (same anon/internal divergence as 0059, same [DENY] check).
  - Derived user-facing columns (A.2): `width_in, depth_in, height_in`.
- **`product_spec_view` is DROPPED and REBUILT in the same migration** as a one-row-per-SKU aggregate over `product_variant_spec_view` (group by sku; max/min/bool_or as appropriate). Same output columns, same names, same grants — **`rank_products_by_spec` keeps working unchanged** and now does one expansion instead of its own. One expansion, one class CASE, zero view-to-view double work.
- **Composite parsers are invoked via `cross join lateral` ONCE per row** (A6a): `cross join lateral product_spec_parse_cct(cct_desc) cct, cross join lateral product_spec_parse_dims(...) d` — NEVER the `(fn(x)).a, (fn(x)).b` form, which re-executes the function once per referenced field.

New parsers, same IMMUTABLE-pure-SQL style as `product_spec_parse_num` (0059:98), conservative to a fault:

- **`product_spec_parse_cct(raw)` → `(cct_min int, cct_max int, cct_values int[], cct_multi boolean)`** (A8/O7):
  - `#K` (`3000K`) → min=max=3000, `cct_values = {3000}`.
  - **Selectable lists** `#K/#K/#K` and `#K, #K, #K` → `cct_values = {2700,3000,3500}`, `cct_multi = true`, min/max informational only. **Matching is exact membership against `cct_values`** — a `2700K/5000K` selectable does NOT satisfy a 3000K request; v1's containment-over-min/max was adjudicated lossy-and-wrong for lists.
  - **True ranges/tunables** `#K-#K` / `#K - #K` and the `R, G, B, #K - #K` tail → min/max set, `cct_values = null`. **Containment/overlap matching applies ONLY to these shapes.**
  - Prose (`Amber`, `Color Changing`) → all null.
- `product_spec_parse_ip(raw)` → `int`: `^IP\s*\d{2}$` or bare `^\d{2}$` → the number; `No`-ish and prose (`Damp Location`) → null (absence of a rating is NOT a rating).
- CRI: `product_spec_parse_num` as-is (audit: 100% plain integers).

**Migration header documents** (A11): the diameter column's dual provenance (`zbodydia`/`zcnpydia` first-match-wins) and its consequence — diameter-only rows may carry the canopy diameter.

### A.2 The width/depth/height mapping — class-aware, decided (A1 + O4)

Sales Layer's axes are fixture-local, not user-local: for bath bars and linears, `zwidth_fix` is the wall protrusion and `zlength_fix` the horizontal run (Slim: W=2.6, L=18/24); for rounds, width=length(=diameter); for the occasional vertically-mounted bar the long axis sits in height (Remi). A filter on raw `width_mm` would answer "no wider than 15 inches" with 24-inch fixtures and reject 2.6-inch-deep ones — wrong in both directions. Adopted mapping, computed per variant row in the base view:

- **`width_in = round(greatest(width_mm, length_mm, diameter_mm) / 25.4, 1)`** — the largest horizontal extent, treating height as vertical. This is what a person measuring across a mirror means. Fixes the thesis case: Slim's 18/24-inch variants get width_in 18/24 and fail "≤ 15".
- **`depth_in` is CLASS-AWARE** — v1's blanket `least(W,L)` was adjudicated wrong for ceiling fixtures (a 12×12 flush mount would report depth 12 in when its drop is 4 in) and for round faces (least = greatest = the face, not a projection):
  - **wall/sconce classes** → `least(width_mm, length_mm) / 25.4` — the wall projection, the ADA §307 question — **but NULL when the face is round or square** (`least/greatest > 0.8`, or `width = length = diameter`): on those rows least-of-W/L is the face dimension, not the projection, and pretending otherwise is the thesis failure in a new coat.
  - **flush/ceiling/fan classes** → `height_mm / 25.4` — the true drop from the ceiling, which is what "how deep/low does it hang" means there.
  - **all other classes** → **NULL**, and the tool says depth is not defined for that fixture type — a pendant's "depth" is not a real question; refusing beats inventing.
- **`height_in = round(height_mm / 25.4, 1)`** — vertical, untouched.
- **Per-foot exception, applied per row (A10):** for `per_ft` rows (tape/strip), `length_mm` is the REEL length (audit: up to 100 ft) — excluded from both derivations on that row; width_in comes from the cross-section `width_mm` only, and the tool labels tape widths as cross-section.
- **Raw recorded axes are ALWAYS printed alongside derived values** — in `filter_products` output AND in `get_product` (O1). The model presents real geometry, never just the derived number.
- **ADA posture:** any answer touching the 4-inch protrusion rule carries a verify-projection-on-the-spec-sheet line — the AHJ interprets §307, not the catalog; our derived depth is a screen, not a certification.
- **Documented limitation, not silently papered over:** axis-swapped rows (Remi-type: the 16–24 in run recorded in height) read as narrow-and-tall. That is *correct if the bar is mounted vertically*, which is exactly what those records describe — but v1's "eyeball top-30 rows" was adjudicated non-evidence (A12/O5): there are **8+ wall categories**, and 30 eyeballed rows bound nothing. G.1 replaces it with **systematic counting flags over ALL wall/ceiling categories** (see G.1), with the numbers recorded in the migration's verify block.

Users speak inches; storage is mm (synced ×25.4 from Sales Layer's inch fields — `SALES_LAYER_DIMENSION_UNIT` default `"in"`, `saleslayer.ts:224`). The RPC takes INCHES and converts internally; nothing user-visible is metric.

### A.3 RPC `product_spec_filter(...)`

SECURITY INVOKER, pinned `search_path`, all-nullable predicate args, clamped `match_count` (cap 25) — the 0059 posture throughout. **All predicate args carry a `p_` prefix** (A3): v1's `width_max_in`-style names collide with view column names inside the function body, and PL/pgSQL resolves the ambiguity silently in favor of whichever the planner prefers — a class of bug that passes tests and fails in refactors. Adopted signature:

```
product_spec_filter(
  p_width_max_in numeric default null,  p_width_min_in numeric default null,
  p_depth_max_in numeric default null,  p_depth_min_in numeric default null,
  p_height_max_in numeric default null, p_height_min_in numeric default null,
  p_lumens_min numeric default null,    p_lumens_max numeric default null,
  p_watts_max numeric default null,     p_watts_min numeric default null,
  p_efficacy_min numeric default null,
  p_cct_min_k int default null,         p_cct_max_k int default null,
  p_cri_min int default null,           p_ip_min int default null,
  p_brand text default null, p_category text default null,
  p_class text default null,
  p_query_embedding vector(1024) default null, p_query_text text default null,
  p_match_count int default 10
)
```

- **Predicate semantics — same-row conjunction at variant grain:** a variant qualifies when it satisfies EVERY stated dimension/CCT/CRI/IP predicate *on its own row*; a product qualifies when ≥1 variant qualifies. A NULL in a constrained attribute FAILS that predicate: **missing data excludes; it never passes as "probably fine"** — the inverse of the guessing that produced the thesis failure.
- **Lumens/watts conjunction (O2 + A4 — ship-gate):** when a lumens/watts predicate co-occurs with a dimension predicate, lumens is evaluated **on the qualifying variant's own row** where the variant carries `variant_lumens` (24% of non-accessory products do — and they are concentrated exactly in the multi-size vanity/linear families where it matters: Lightstick's 19 in variant is 1,268 lm against a product-max of 6,342 lm; v1's product-level-only fallback would have certified the 19 in size as a 6,342 lm fixture). Where the variant has no lumens, the predicate falls back to product-level `lumens_max` and the row is flagged `lumens_source = 'product_level'` — which the tool converts into a MANDATORY output sentence (B), never a bare tag.
- **CCT (A8/O7):** requests arrive as **`p_cct_min_k` / `p_cct_max_k` with overlap semantics** — a single requested kelvin is expressed as equal bounds. A row matches when the requested band overlaps the row's capability: exact membership of any `cct_values` element in the band for selectable lists; band-overlap against min/max for true ranges/tunables. This delivers v1's deferred band-vs-band item now, correctly, instead of the lossy single-kelvin + containment.
- **Ordering — exact post-filter sort (A7):** the qualifying set is ordered by `products.embedding <=> p_query_embedding` as a plain ORDER BY over the filtered rows. **The HNSW index is irrelevant here and must not be "optimized" back in**: HNSW accelerates approximate top-K over the WHOLE table; after hard predicates the candidate set is small and an ANN scan would silently drop qualifiers — the exact recall-loss this plan exists to kill. Guard `embedding is not null`, sort `nulls last`, and fall back deterministically: **distance → `ts_rank` on `p_query_text` → name** — every branch total-ordered so results are stable across calls.
- **`in_scope_screened` — pinned (A9):** a product counts as screened iff it has **≥1 variant row that is non-null on EVERY constrained variant-grain attribute** AND **non-null product-level values for every constrained product-level predicate**. Not "has any data", not per-attribute counts summed. The 0063 verify block carries a literal SQL test: a two-variant fixture where variant 1 has width-only and variant 2 has cct-only is **NOT screened** for a width+cct query (no single row carries both), and IS screened for width-only.
- **Returns product-rollup rows:** `sku, name, brand, category, class, qualifying_variants, variant_count_with_dims, example_variant_sku, min/max qualifying width_in/depth_in/height_in, raw dims of the example variant, cct summary, cri, ip, lumens (value + lumens_source), per_ft, score` — plus the windowed honest counts on every row: `in_scope_total`, `in_scope_screened`, `matched`.
- **Latency budget (A6):** G.1 runs `explain analyze` **as anon** on a representative multi-predicate call. Budget: p95 < 2 s on the public surface. **If p95 > 2 s, that triggers materialization** of the base view (the H item stops being "only if" hand-waving and becomes a numbered gate); below budget, plain views stand.

### A.4 Semantic composition — filter-first, rank-second (the crux; unchanged, both reviews verified clean)

Two orders were considered:

- **Post-filter `search_products` results (REJECTED):** run `product_semantic_search` (top-K ≤ 20, `0043:328-387`), then check dims in TS. Fatal: hard predicates applied to a semantically-truncated candidate set. The catalog has ~30 bath/vanity products; a K=20 semantic slice can drop half the ≤15-inch qualifiers before the filter ever sees them, and the tool would report "2 match" when 9 do. Constraint queries are recall-critical; semantic top-K is a recall limiter.
- **Filter-first, semantic-ordered (ADOPTED):** the RPC applies the attribute predicates to the WHOLE catalog (36k variant rows of pre-parsed numerics — the same full-scan shape `product_spec_rank` already runs fine), then orders the qualifying set exactly (A.3). The tool computes the embedding with the existing `embedQuery` (`packages/shared/src/thom/embed.ts`), exactly as `searchProducts` does (`tools.ts:171`).

So "vanity lights no wider than 15 inches" becomes: `product_spec_filter(p_width_max_in: 15, p_query_embedding: embed("vanity light"), p_query_text: "vanity light")` — every returned product genuinely fits, ordered vanity-first. `search_products` itself is untouched; the prompt (D) routes constraint-bearing queries to the filter tool with the descriptive part passed as `query`.

Also in 0063: grants (`select` on BOTH views, `execute` on the RPC, to anon + authenticated — a view has its own ACL, 0059's lesson), the 0052-style VERIFY-AS-ANON checklist ([PASS] filter with dims as anon; [DENY] a SKU whose only photometrics link is internal-scoped must show no IES-derived lumens in anon filter output; [DENY] out-of-whitelist args raise), the `explain analyze`-as-anon latency gate (A.3), and the G.1 systematic counts recorded in the verify block.

## B. Tool `filter_products` + `get_product` dimensions — one PR (O1 ship-gate)

Argued both ways (unchanged from v1, both reviews verified clean):

- **Extending `rank_products_by_spec` with min/max args (REJECTED):** the rank schema is superlative-shaped (`metric` + `direction`); bolting predicates onto it yields a schema where a router-tier model must understand that `metric` becomes optional-when-filtering, grouping doesn't apply, and the output contract flips from "top-3 per class" to "everything that fits". The shipped plan's own R15a lesson is that the router model echoes whatever the tool shape suggests. The rank tool is also live on both surfaces; regressing a shipped, prompt-referenced tool to add an orthogonal capability is bad rollout hygiene.
- **New `filter_products` (ADOPTED), sharing the machinery:** same view family, same `SPEC_RANK_CLASSES` enum for `class` (now including the wall/bath bucket, O9), same name-first formatting helpers and honest-coverage pattern, one new dispatch branch.

`FILTER_TOOLS: ClaudeTool[]` in `packages/shared/src/thom/tools.ts`, mirroring `SPEC_RANK_TOOLS` (`tools.ts:126-160`):

- **Inputs (user units):** `query` (free-text description for semantic ordering), `max_width_in/min_width_in/max_depth_in/min_depth_in/max_height_in/min_height_in`, `min_lumens/max_lumens`, `max_watts/min_watts`, `min_efficacy`, `cct_min_k/cct_max_k` (single kelvin = equal bounds, O7), `min_cri`, `min_ip`, `brand`, `category`, `class` (enum), `limit`, and an **optional `unit` parameter (`"in" | "ft" | "cm" | "mm"`)** (O10) — **conversion happens in TS in the tool handler, never by the model**; router-tier models multiply by 25.4 about as reliably as they compare 15 to 20. Description states: dimensions default to inches; "wide/long" = width, "deep/projection/extension" = depth; always pass EVERY constraint the user stated; **and the rank-tool-style routing sentence (O3b): "Use this for ANY question that states a numeric limit (a maximum or minimum size, brightness, wattage, color temperature, CRI, or IP rating) instead of `search_products`."**
- **Output, name-first with real geometry** (persona forbids leading with catalog numbers): `- Slim Bath & Vanity Light (SKU 3554, WAC Lighting, wall/bath): 18.0 in wide, 2.6 in deep, 5.0 in tall (recorded W 2.6 × H 5.0 × L 18.0 in); 2 of 6 sizes meet your limits; 3000 K, CRI 90` — v1's sample said "decorative", which was wrong twice (vanities are class `other` today, and the plan adds wall/bath — O9). Raw recorded axes always ride alongside derived values (A.2). Depth-undefined classes print "depth is not defined for this fixture type" rather than a number (A1/O4).
- **Product-level lumens fallback sentence (O2 — tested output contract, not a tag):** whenever any returned row has `lumens_source = 'product_level'` under a lumens predicate, the output MUST contain the sentence *"brightness figures are for the product's highest-output configuration, which may not be the size that fits"* — asserted verbatim in `tools.test.ts`. A bare `[product-level]` tag was adjudicated insufficient: the router model drops tags; it repeats sentences.
- **Honest-coverage line from the windowed counts:** *"Screened the {in_scope_screened} of {in_scope_total} {scope} products that carry data for every stated constraint; {matched} matched. Products missing catalog data for a constraint are excluded, not confirmed to fit."* (`in_scope_screened` per the pinned A9 definition.) The audit says this line will usually read well (dims ≈ 90.7%) but must exist for IP (29.9%).
- **Zero-match protocol — pinned (A13 + O11):** if a brand/category filter produced `in_scope_total = 0`, re-run without it and explain (free-text-category R16a idiom, `tools.ts:748-759`). If constraints produced zero: **keep the FULL scope and all other predicates; relax ONLY dimension predicates, one at a time, in stated order (width → depth → height); report the near-miss for the FIRST predicate whose relaxation yields a row** — *"No product with recorded dimensions fits; the narrowest vanity with data is X at 16.0 in wide."* If a NON-dimension predicate (lumens/CCT/CRI/IP) caused the zero, say plain "nothing fits" — a near-miss on brightness or color temperature is not a meaningful "almost". **Never emit a product card for a near-miss**; presenting near-misses as matches is the thesis failure with extra steps.
- **`get_product` prints per-size dimensions (O1 — ship-gate, SAME PR):** `getProduct` reads `product_variant_spec_view` for its SKU and prints, per size: the **recorded W×H×L (+diameter)** AND **the same derived width/depth the filter uses** — single source, zero drift between what the filter screened on and what the product card says. Adds a **"Sizes: …"** line, and when the catalog has no dimensions for the product, an explicit **"No recorded dimensions in the catalog for this product"** line. This fixes the description/implementation mismatch behind the original screenshot failure (the tool description implied dimensions; the implementation never printed them, so the model improvised) and enables the **O8 honesty split**: the model can now distinguish *unknown* ("no recorded dimensions — check the spec sheet") from *violating* ("recorded at 20 in, exceeds your 15 in limit"), with **spec-sheet dimensions via `search_docs` as the stated escape hatch** for the unknown case.
- **Plumbing that ships with it (the A10/A11 lessons from the shipped plan):** dispatch branch + `PUBLIC_TOOL_NAMES` entry (`tools.ts:1037-1047`); analytics bucket — add `filter_products` to the PIM regex in `packages/shared/src/thom/analyticsSources.ts:30` + test, so Davis's dashboard never shows `Other (…)`.

**Flag: new `THOM_SPEC_FILTER` (recommended), same dark-launch idiom as `THOM_SPEC_RANK`** (`env.ts` ThomEnv member; composed in `agent.ts` beside `specRankEnabled` at lines 58-63/93-100; enabling = committed `vars` edits in `apps/api/wrangler.jsonc:256` and `apps/thom-bot/wrangler.jsonc:61` — two commits, internal then public). Reusing `THOM_SPEC_RANK` was considered (one less flag; the tools are siblings) and rejected: rank is already live on both surfaces, and coupling would make the filter's internal-first soak impossible without turning rank off in public. Davis may overrule (checklist). The O1 `get_product` dimension surface ships behind the SAME flag (it reads the 0063 view).

## C. Prompt guidance — a constraint is a contract

`LIGHTING_EXPERTISE_FILTER_BULLET` in `packages/shared/src/thom/prompts.ts`, composed ONLY when `THOM_SPEC_FILTER=1` (exactly the spec-rank bullet mechanism, `prompts.ts:104-116` — commanding an unadvertised tool re-creates the original failure). Authored to the public copy lints (no em dashes, "WAC Group", passes `normalizeCopy` unchanged and the `promptsPublic.test.ts` negative lints). Content (~9 lines):

- When the user states ANY numeric constraint (a maximum or minimum width, depth, height, lumens, wattage, CCT, CRI, or IP rating), you MUST call `filter_products` with every stated constraint, and you MUST NOT present any product that violates a stated constraint. A stated limit is a requirement, not a preference.
- **When a numeric constraint is active, only products returned by `filter_products` may be recommended** (O12 — closes the "call the filter, then recommend from a stale `search_products` result" leak).
- **Numeric constraints stated earlier in the conversation remain binding until the user changes them** (O6 — pairs with the history-window escalation below).
- Pass the descriptive part of the request ("vanity light", "outdoor sconce") as the query so results are ordered by fit; pass the user's unit via the `unit` parameter instead of converting yourself (O10).
- The tool excludes products that have no recorded data for a constrained attribute. Say that products without confirmed dimensions were not considered rather than guessing a size; if the tool reports a closest option that exceeds the limit, present it only as an alternative that does NOT meet the stated requirement, never as a match.
- When you recommend a product from the results, state its recorded dimensions so the user can verify the fit; for ADA projection questions, tell the user to verify the projection on the spec sheet (A.2).
- Superlatives stay with `rank_products_by_spec`; use `filter_products` when the user gives numeric bounds; use both in sequence for "the brightest one under 15 inches" (filter first, then compare the survivors).

**`search_products` back-pointer, flag-respecting (O3 + O12):** the sentence pointing constraint queries away from `search_products` is added to the `search_products` tool description **dynamically, only when `THOM_SPEC_FILTER=1`** — a static description edit would advertise an unavailable tool with the flag off, violating the shipped plan's R3 rule.

## D. Routing — `CONSTRAINT_INTENT`, rebuilt (A2 + O3 + O6)

A `CONSTRAINT_INTENT` regex beside `SUPERLATIVE_INTENT` in `agent.ts:161-176`, escalating at `toolCallCount >= 0` — multi-predicate composition is precisely the shape a router-tier model fumbles, and the failing turn is the first turn (the R6 lesson). v1's draft regex was adjudicated leaky in both directions (missed "narrower than", "15 in or less", bare "ADA"; false-fired on "under-cabinet"). Rebuilt:

- **Digit-adjacent-unit anchoring:** units match only adjacent to digits — `(?<=\d)\s?(in|"|mm|cm|ft|feet|foot)\b` — so "under-cabinet lighting", "over the island", "up to code" cannot fire the comparator+unit pair.
- **Widened comparators:** `more/less/bigger/smaller/narrower/wider/shorter/taller/shallower than`, `no bigger than`, `within`, `at most/at least`, `under/over/between/max(imum)/up to`, **trailing forms** (`15 in or less`, `15 inches max`), lumens/watts/kelvin/CRI/`ip\s?\d`, and **`\bADA\b`** (an ADA mention IS a 4-inch depth constraint), plus fits-in forms (`fit(s)? (in|into|within|under|over)` + digit-unit).
- **Both corpora ship as tests** in `agent.test.ts`: the false-positive corpus (under-cabinet / over-the-island / up-to-code / "over 100 products" style) asserted NOT to match, and the miss corpus (narrower-than / or-less / max-trailing / bare-ADA / fits-in) asserted to match. The regex is not "draft, to be tuned" — the corpora ARE the spec.
- **Overlap with `SUPERLATIVE_INTENT` is explicitly allowed** — "the brightest one under 15 inches" legitimately matches both, both escalate, and that is correct. v1's non-overlap test requirement is DROPPED (it would force one regex to blind itself).
- **History window (O6):** the regex is evaluated over the **last N user turns of history, not just the current turn** — "no wider than 15 inches" in turn 1 followed by "what about in black?" in turn 3 is still a constraint conversation; v1 would have de-escalated exactly when the model was about to re-guess. Paired with the prompt line "numeric constraints stated earlier remain binding until changed" (C).
- **Tuning source (O13):** regex tuning and rollout monitoring read **`thom_messages` / `thom_source_usage`** (0057/0058) — v1 said "`thom_chat_analytics` logs"; that is a migration filename, not a table. No table named `thom_chat_analytics` exists.

Pure, tested in `agent.test.ts`.

## E. Tests

- **Parsers (G.1 SQL literals, 0063 header):** `"3000K"` → {3000}; `"1800K-3000K"` → range 1800/3000, values null; `"2700K/3000K/3500K"` → values {2700,3000,3500} + multi, and **3000 matches but 2800 does NOT** (exact membership); `"2700K/5000K"` does NOT match a 3000K request (the A8 case); `"R, G, B, 2200K - 6500K"` → range 2200/6500; `"Amber"`/`"Color Changing"` → null; `"IP65"` → 65; `"20"` → 20; `"No"`/`"Damp Location"` → null; `"90"` (cri) → 90.
- **Derived dims (SQL literals):** Slim-shaped wall row (W 66mm/H 127/L 457) → width_in 18.0, depth_in 2.6; **flush-mount row** → depth_in = height (the drop), not least(W,L); **round sconce face** (W=L) → depth_in NULL; **pendant** → depth_in NULL; per_ft row with 30,480 mm length → length excluded, width_in = cross-section, per_ft computed on that row.
- **Conjunction (SQL literals, the O2 ship-gate):** a Lightstick-shaped product (19 in/1,268 lm variant; larger/brighter variants) with `p_width_max_in 20, p_lumens_min 2000` returns NO qualifying variant at 19 in — the variant's own lumens governs; the same query on a no-variant-lumens product falls back to product-level with `lumens_source = 'product_level'`.
- **`in_scope_screened` (SQL literal, A9):** the split-attribute two-variant fixture is NOT screened for width+cct, IS screened for width-only.
- **Tool unit tests (`tools.test.ts` idiom):** predicate arg assembly with `p_` names; **`unit: "cm"` converted in TS before the RPC call** (O10); name-first formatting with sizes line + raw recorded axes; coverage line from windowed counts; **the mandatory product-level-lumens sentence asserted verbatim** (O2); zero-match relaxation order width→depth→height, near-miss labeled and never carded, plain "nothing fits" on a lumens-caused zero (A13/O11); free-text-scope fallback; public dispatch allowlist entry; analytics bucket mapping; **`getProduct` prints recorded + derived dims from the view, the Sizes line, and the no-recorded-dimensions line** (O1).
- **Prompts:** filter bullet (incl. the O12 only-from-filter line and the O6 still-binding line) passes `normalizeCopy` unchanged + public lints; composed only under the flag; the `search_products` back-pointer present ONLY when the flag is on (O3/R3); tail cache breakpoint still on the last block (both `internalSystem` and `publicSystem`).
- **Agent:** `CONSTRAINT_INTENT` escalation at zero tool calls; **false-positive corpus and miss corpus both in `agent.test.ts`** (A2); **multi-turn: constraint in an earlier user turn still escalates** (O6); superlative+constraint overlap allowed (non-overlap test dropped).
- **Regression conversations (manual, BOTH surfaces — anon and internal may diverge by photometrics scope, which is correct):** (1) the verbatim failing chat — "vanity lights no wider than 15 inches" → every named product ≤ 15.0 in derived width, no Slim/Metro/Fuse 16-plus sizes, coverage line present; (2) the three-predicate query — "less than 15 inches wide, more than 1000 lumens, no more than 4 inches deep" → same-row conjunction honored, product-level-lumens sentence present where the fallback fired; (3) a missing-data probe — IP on indoor wall/bath → data-not-confirmed, no guessing; (4) **`get_product` on Slim** → per-size recorded + derived dims, matching the filter's numbers exactly; (5) **turn-3 follow-up** ("what about in black?") after a turn-1 constraint → constraint still enforced.

## G. Rollout (gated, in order)

1. **Migration 0063.** No user-visible change; `product_spec_view` rebuild is output-compatible (rank regression: one `rank_products_by_spec` smoke call pre/post, identical rows). Verify block, all results RECORDED in the migration file:
   - VERIFY-AS-ANON checklist incl. the photometrics DENY case.
   - **`explain analyze` as anon** on a multi-predicate filter call; **p95 > 2 s triggers materialization** of the base view (A6).
   - Parser literals (E) + `in_scope_screened` literal (A9).
   - **Systematic axis-semantics counts (A12/O5), replacing v1's top-30 eyeball, over ALL wall AND ceiling categories** (8+ wall categories exist): (a) count of wall-class rows with derived depth > 6 in (suspicious protrusions); (b) count of ceiling-class rows where derived depth == diameter (face leaking into depth); (c) count of rows with height > 2× width (Remi-type candidates: vertical mounting vs data-entry swap). Numbers recorded; anomaly clusters route to the H "axis healing upstream" item, not to SQL heuristics.
   - **Diameter-contamination probe (A11):** distribution of `diameter` by class for rows where `zcnpydia` was the source (diameter present, `zbodydia` absent in raw), to bound how often width_in rides on a canopy diameter.
2. **PR: A + B + C + D in ONE PR** — view/RPC ride the migration; tool + **`get_product` dimension surface (O1 ship-gate: the filter must not ship without it)** + prompt + escalation + plumbing, flag off — safe by construction.
3. Enable `THOM_SPEC_FILTER` **internal** (`apps/api/wrangler.jsonc` vars commit), run all five regression conversations, watch **`thom_messages` / `thom_source_usage`** (O13) for a few days of real constraint queries; tune the corpora (which are tests, so tuning = PR).
4. Enable **public** (`apps/thom-bot/wrangler.jsonc` vars commit); re-run regressions (1) and (5) anonymously.
5. Housekeeping: the lighting-expert plan's Deferred row "CRI/IP/CCT rank filters" is partially delivered by this plan — annotate it there; add this plan to the Thom docs index/memory.

## H. Deferred

- **Beam filtering** — `beam_desc` is categorical prose (57%, three spellings of "Asymmetrical"); numeric beam angle exists in `ies_metrics` for photometrics-covered SKUs. Either normalize the categories or filter on IES beam angle; both need their own audit.
- **`volt_in` filter** (74.3%, `#-# VAC`/`# VDC` shapes) — parseable; waiting on evidence people ask Thom voltage-constrained catalog questions.
- ~~CCT band-vs-band overlap~~ — **delivered in v2** (`p_cct_min_k`/`p_cct_max_k` overlap semantics, O7).
- **Full per-variant lumens coverage** — v2 uses variant lumens where present (24% of products); if Sales Layer coverage or per-variant IES mapping improves, the fallback sentence fires less. Nothing further to build; this is a data-coverage watch item.
- **Filter + rank combined in one call** (`order_by: metric` on the filter RPC) — v1 lets the model chain the two tools; a fused arg is a small v1.1 if chaining proves clumsy.
- **Axis healing upstream** — if G.1's systematic counts show real Remi-type data-entry swaps (not vertical mounting), fix at Sales Layer, not in SQL heuristics.
- **Materializing the base view** — no longer open-ended: gated on the G.1 latency budget (p95 > 2 s as anon). Weight/canopy dimensions; min/max sliders in the widget UI (this plan is chat-tool-only).

## Davis decisions

- [ ] Ratify the v2 filterable set: width/depth/height (derived, class-aware, inches) + lumens/watts/efficacy (variant-row where available, product-level fallback with mandatory sentence) + CCT band + CRI + IP; beam and voltage deferred.
- [ ] New flag `THOM_SPEC_FILTER` (recommended) vs reusing `THOM_SPEC_RANK` (couples filter rollout to the live rank tool).
- [ ] Approve the class-aware width/depth mapping (width = largest horizontal extent incl. diameter; depth = wall projection for wall classes with round/square-face NULL guard, drop for ceiling classes, NULL elsewhere; per-foot cross-section exception) pending the G.1 systematic counts.
- [ ] Zero-match protocol as pinned (dimension-only relaxation in width→depth→height order, near-miss labeled, never carded; plain "nothing fits" for non-dimension zeros).
- [ ] `CONSTRAINT_INTENT` pre-escalation on from day one over the last-N-user-turns window (recommended — same rationale as SUPERLATIVE_INTENT) vs router-first.

---

## Objection ledger (v2 adjudication — all adopted)

| Obj | Sev | Resolution |
|---|---|---|
| A1 | high | Depth is class-aware: wall/sconce → least(W,L) with NULL on round/square faces (least/greatest > 0.8 or W=L=diameter); flush/ceiling/fan → height_mm (the true drop); all other classes → NULL + tool says depth is not defined for that fixture type. Merged with O4. (A.2) |
| A2 | high | CONSTRAINT_INTENT rebuilt: digit-adjacent-unit anchoring, widened comparators (narrower/shallower/no-bigger-than/within/trailing "or less"/"max", \bADA\b, fits-in), false-positive AND miss corpora shipped as agent.test.ts tests; corpora are the spec. (D) |
| A3 | med | RPC predicate args renamed with `p_` prefix — kills the PL/pgSQL arg-vs-column name collision. (A.3) |
| A4 | ship-gate | Lumens conjunction unsound at product level — evaluated on the qualifying variant's own row where variant lumens exists (944/3,884 products, 24%, concentrated in multi-size vanity/linear families; Lightstick 19 in = 1,268 lm vs product-max 6,342 lm). Merged with O2. (A.3, B) |
| A5 | med | Migration renumbered 0062 → **0063** (feedback plan took 0062); re-check `ls supabase/migrations` at build. (A header) |
| A6 | med | Latency budget stated: `explain analyze` as anon in G.1; p95 > 2 s triggers materialization of the base view — no open-ended "only if" deferral. (A.3, G.1, H) |
| A6a | med | Composite parsers (cct/dims) invoked via `cross join lateral` ONCE per row — never `(fn(x)).a, (fn(x)).b` double execution. (A.1) |
| A6b | high | View inversion: the variant-grain view is the BASE (single jsonb expansion; class CASE + all parsers live there); `product_spec_view` REBUILT on top in the same migration; rank RPC unchanged. No view-to-view double expansion. (A.1) |
| A7 | med | Ordering = exact post-filter sort; HNSW explicitly irrelevant and must not be "optimized" back in; `embedding is not null` guard + `nulls last` + deterministic fallback distance → ts_rank → name. (A.3) |
| A8 | high | Selectable CCT lists parse to `cct_values int[]` with exact-membership matching; containment/overlap ONLY for true range/tunable shapes. Merged with O7. (A.1, A.3) |
| A9 | med | `in_scope_screened` pinned: ≥1 variant row non-null on EVERY constrained variant-grain attribute + non-null product-level values for product-level predicates; literal SQL test in the 0063 verify block. (A.3) |
| A10 | med | `per_ft` computed per variant row in the base view; the reel-length exception applied per row, not product-wide. (A.1, A.2) |
| A11 | med | Diameter dual provenance (`zbodydia`/`zcnpydia` first-match-wins, saleslayer.ts:70-76) documented in the migration header; G.1 diameter-distribution probe bounds canopy contamination. (audit, A.1, G.1) |
| A12 | high | Top-30 eyeball replaced with systematic counting flags over ALL wall/ceiling categories (8+ wall categories): wall depth > 6 in, ceiling depth == diameter, height > 2× width — numbers recorded in the migration verify block. Merged with O5. (G.1) |
| A13 | med | Zero-match relaxation pinned: full scope kept; ONLY dimension predicates relaxed, one at a time, width → depth → height; near-miss reported for the first yielding predicate; never carded. Merged with O11. (B) |
| O1 | ship-gate | `get_product` reads the variant-grain view: per-size recorded W×H×L (+diameter) AND the same derived width/depth the filter uses (single source, zero drift), "Sizes:" line, explicit "No recorded dimensions in the catalog for this product" line. Ships in the SAME PR as the filter. Fixes the description/implementation mismatch behind the original screenshot failure. (B) |
| O2 | ship-gate | Size-vs-brightness conjunction: lumens evaluated on the qualifying variant's own row where present; product-level fallback carries the MANDATORY tested sentence "brightness figures are for the product's highest-output configuration, which may not be the size that fits" — never a bare tag. Merged with A4. (A.3, B, E) |
| O3 | high | Routing hardened: `filter_products` description carries the rank-tool-style "Use this for ANY question that states a numeric limit … instead of search_products" sentence (O3b); `search_products` back-pointer added dynamically only when the flag is on (R3 rule). (B, C) |
| O4 | high | Ceiling-fixture depth wrong under blanket least(W,L) — resolved by the class-aware depth mapping. Merged into A1. (A.2) |
| O5 | high | Eyeball insufficient across 8+ wall categories — resolved by the systematic G.1 counts. Merged into A12. (G.1) |
| O6 | high | Constraints from earlier turns: CONSTRAINT_INTENT evaluated over the LAST N USER TURNS, not just the current turn; prompt line "numeric constraints stated earlier remain binding until changed"; multi-turn regression (5). (C, D, E) |
| O7 | high | CCT request shape: `cct_min_k`/`cct_max_k` with overlap semantics (single kelvin = equal bounds); delivers v1's deferred band-vs-band now. Merged with A8. (A.3, B) |
| O8 | med | Unknown-vs-violating honesty split enabled by O1's get_product surface; spec-sheet dims via `search_docs` is the stated escape hatch for the unknown case. (B) |
| O9 | low | §B's "decorative" sample corrected (vanities are class `other` today); wall/bath bucket added to the class CASE, now a one-place edit in the 0063 base view. (audit, A.1, B) |
| O10 | med | Optional `unit` parameter ("in"/"ft"/"cm"/"mm"), converted in TS by the tool handler, never by the model; prompt tells the model to pass the unit through. (B, C, E) |
| O11 | med | Zero-match near-miss protocol pinned (order, labeling, no cards, plain "nothing fits" for non-dimension zeros). Merged into A13. (B) |
| O12 | high | Prompt bullet "when a numeric constraint is active, only products returned by filter_products may be recommended" — closes the stale-search_products recommendation leak; flag-gated composition. (C) |
| O13 | low | Table names fixed: regex tuning + rollout monitoring reference `thom_messages`/`thom_source_usage` (0057/0058); `thom_chat_analytics` is a migration filename, not a table. (D, G.3) |

**Verified clean by both reviews and preserved unchanged:** filter-first architecture (A.4), variant-grain same-row conjunction, null-excludes-never-passes, injection posture (SECURITY INVOKER + pinned search_path + clamped counts), anon grants + VERIFY-AS-ANON, the `THOM_SPEC_FILTER` dark-launch flag idiom, honest windowed counts, and the per-foot reel exclusion.

## Addendum (2026-07-21, pre-ratification — metric answers, per Davis)

Metric **inputs** were already covered (O10: `unit` parameter, TS-side conversion). This addendum pins metric **outputs**:

- **Tool output renders dual units on every dimension**: `18.0 in (457 mm)` — both the filter tool's rows and `get_product`'s Sizes/recorded-axes lines (O1). Sales Layer exports dimensions in INCHES (per Davis, confirmed in code: `dimFactor = unitToMm(SALES_LAYER_DIMENSION_UNIT ?? "in")` = 25.4, `saleslayer.ts:223,744-752`); the sync converts and the app's `dimensions_mm` column stores mm. Inches are therefore the round-trip-exact source figures and mm the stored conversion; the tools emit both, and no model arithmetic occurs in either system.
- **Prompt line (B bullet):** "Answer dimensions in the unit system the user used, using the tool's dual-unit values; both are always available." A user asking in cm gets cm-converted-from-mm by the model ONLY as display formatting of the emitted mm value (divide by 10) — never unit math on inches.
- Tests (E): dual-unit rendering asserted in the tool formatting tests; a metric-question regression added to G's internal checklist ("vanity lights no wider than 380 mm").

## Addendum 2 (2026-07-21, pre-ratification — unit-suffixed auxiliary lengths, per Davis)

Sales Layer variants carry auxiliary length fields whose values embed their OWN unit as a string — e.g. `zwire_length = "6 Feet"` (screenshot-verified on 5011-27BBR_G3_B) — unlike the bare-numeric-inches `z*_fix` fields. These are variant-level only and are DROPPED by the sync today (`VARIANT_DIM_FIELDS` maps just the five fixed-dim fields; unmapped variant fields do not survive; nothing wire/cord-like exists at product level — audited). Cord/suspension length is a real filter axis ("pendant with at least 10 feet of cord", tall-ceiling questions), so v1 adds:

- **Build-gate audit (G.0-style, connector feed):** inventory the 297-field variant schema for dimension-like unit-suffixed fields (`zwire_length` + siblings: chain/rod/stem/cable candidates), measure population by brand, and collect value shapes before writing the parser. (The shapes seen so far: `"<number> Feet"`; expect `"72\""`/`"72 in"` variants.)
- **Sync capture:** map the audited fields into a new `aux_lengths` entry on the variant (stored mm, like dims) via a **unit-aware string parser** — accepts `<number> (feet|foot|ft|'|inches|inch|in|")` with the unit REQUIRED (a bare number in these fields is ambiguous and parses to null; contrast the `z*_fix` fields where inches are the declared unit). Pure, tested, in `packages/shared`.
- **Exposure:** `wire_length_mm` (and audited siblings) join the 0063 variant view; the filter tool gains `min_wire_length`/`max_wire_length` honoring the `unit` parameter; `get_product` prints it dual-unit ("Wire/cord length: 6 ft (1.83 m)"). Same missing-data-excludes + honest-coverage semantics as every other attribute.

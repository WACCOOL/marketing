# Thom Bot — Product Compatibility & Accessories Plan (v2 — RECONCILED; objections AA1–AA14 + PL1–PL11 + the zmataccess discovery folded in; awaiting Davis ratification)

**Status:** v2.1, APPROVED by Davis 2026-07-21. v1 → two-lens counter-plan (AA*/PL*) → v2 reconcile → Davis approval → G.0 connector audit (addendum below). Companion: `docs/thom-lighting-expert-plan.md` (shipped: PRs #215/#216/#217).

## G.0 audit addendum (2026-07-21 — connector feed audited: 46 pages, 7,674 products, 66,840 variants; amends §A's field list; where it conflicts with the v2 text below, the addendum wins)

- **Capture list (final):** product-level `zmataccess` (1,000 feed products: WAC 607, LIM 153, LANDSCAPE 153, Home 53, VENTRIX 18, Colorscaping 10, AISPIRE 6) + `zmataccesstyp2` (215) — comma-joined parent **PPIDs, 100% resolve to `products.sku`** (0% to sl_id): store as product→product refs with `related_product_sku` set directly. Product-level `zacc1/zacc2(_1.._10)`/`zcomp1..10` (AISPIRE: both are CODE lists, zacc2 continues zacc1) and `matnracc1..3,_5` (66 products, AISPIRE/WAC). **VARIANT-level (new — fans):** MFF `zacc1_N` = accessory SKU with `zacc2_N` = **PAIRED human label** ("F-RCBT-WT" / "Bluetooth Remote Control"; ~78% of MFF variants) — semantics differ from product level; capture as `related_sku` + a new `label text` column, never as a second code. Variant `matnracc1..5` (MFF 538, FAN 160, LIM 6 variants) = orderable **replacement-part** SKUs → new kind `replacement_part` (extend the kind check). Variant `zcomp1..3` marginal (10 LIM variants) — capture cheaply.
- **Drop (empty everywhere):** bare variant `zacc1`/`zacc2`, variant `zacc1_6/_7`, variant `zacc2_3..10`, variant `matnracc6`, product `matnracc4`.
- **Schema deltas vs §A:** add `label text null`; kind check becomes `('accessory','component','replacement_part')`.
- **Brand vocabulary (prod):** WAC 1052, Signature 926, AISPIRE 481, MOF 463, DWEL 394, LIM 274, Beyond 240, LANDSCAPE 154, VENTRIX 112, MFF 108, Forever 62, Home 50, FAN 43, Colorscaping 29, plus a **Home/HOME case-duplicate** — case-normalize any brand-keyed logic. Capture itself is field-driven, not brand-keyed.
- Feed (7,674) ⊃ prod (4,390): refs may target non-synced products → kept unresolved, counted in the sync report.
- Fan replacement parts + MFF zacc pairs materially serve the fan-accessory question class (Wynd XL downrods etc.) from Sales Layer data; Phase 2's PDP harvest remains committed for what the feed still lacks.
- Migration renumbered **0061** (0059/0060 shipped by the lighting-expert build).

**Thesis (corrected).** Thom does not know accessories; today's tools approximate by family/category. The Sales Layer export carries TWO explicit reference systems the sync drops on the floor, not one:

- **`zmataccess` / `zmataccesstyp2`** — comma-separated **product-PPID** accessory lists on **569 products**, including the core WAC Lighting catalog (WAC 334, LIM 81, LANDSCAPE 68, Home 27, VENTRIX 18, Colorscaping 9, AISPIRE 32). Track heads list their track accessories, housings list trims, Solorail lists its transformer. *(Found post-v1; v1's "aiSpire-only" premise was wrong.)*
- **`zacc1/zacc2` (+`_1.._10`) / `zcomp1..10`** — variant-SKU-level accessory/component codes, essentially aiSpire (~417 products, 3,639 values, 71% resolve to variant SKUs, 0% to PPIDs). `zacc2_*` **continues** `zacc1_*` (verified: one overflow list, weakly slot-typed positions — NOT two groups, NOT name/code pairs); `"0"`/`N/A` are empty slots, safe to skip (PL6).
- **Unaudited:** the connector schema also defines `zacc*`/`zcomp*`/`matnracc1..6` at the **variant** level (product-level audits cannot see them — variant raw fields are discarded at stitch), and `matnracc1..5` at product level. Coverage unknown → G.0 audit gate.

And v1's "no source exists for other brands" was also wrong (PL4): **waclighting.com PDPs have a structured "Components" section** (h3#components + product-belt slug links — housing→trims, head→track) and **modernforms.com PDPs a "Curated For You" section** (downrods, remotes, sloped-ceiling kits for each fan), both static HTML, harvestable via the existing crawl §E evidence machinery + `pdp_urls` slug inversion. That is promoted from "scout" to **committed Phase 2** — it is the only source answering the top public accessory questions (fan downrods; trim/housing across brands). Schonbek excluded (JS-injected PDPs).

## A. Capture (v1 build): migration 0060 + sync writer

**Migration 0060 — `product_accessories`:**
- Columns: `id, product_sku text not null, related_sku text not null` (raw code as exported), `related_product_sku text` (resolved parent PPID; null = unresolved), `kind text not null check (kind in ('accessory','component'))`, `source_system text not null default 'sales_layer'`, `source_field text` (`zmataccess`|`zmataccesstyp2`|`zacc`|`zcomp`|…), `position int` (global slot index — zacc1_1..10→1–10, zacc2_1..10→11–20; ordering NOT display-ranked, promise nothing (PL6)), `synced_at timestamptz not null` (AA2), `created_at`.
- `unique (product_sku, related_sku, kind, source_system)` (AA10) + indexes on `(related_sku)` and `(related_product_sku)` for reverse-fit (AA3). No `resolved` column — it's `related_product_sku is not null` (AA9).
- RLS: **0048 posture** — `for select using (true)`, service-role writes only; NOT the 0043 scope machinery (this table has no internal rows, and the bare per-row `is_active_*()` form is the diagnosed 0055 timeout incident) (AA4). Add to the anon-boundary test surface.
- No FK to products (prunable denormalized cache, house idiom). Numbering: 0059 is claimed by the lighting plan; coordinate that BOTH are applied whatever merges first (AA14).

**Sync writer (`apps/api/src/saleslayer.ts`):**
- Collect refs **at map time from the mapped rows** inside the product loop (like `collectDocs`), not from `raw_json` (AA-verified: no field whitelist exists, but arrays would be stripped) — `zmataccess`/`zmataccesstyp2` comma-split → PPID refs (`related_product_sku` set directly after existence check against the product map); `zacc*`/`zcomp*` per PL6 semantics.
- Variant-code resolution via an index built from **RAW pre-filter `variantsByProduct`** (zusage N/P variants are dropped from `products.variants` but resolution is identity, not visibility), with trim/uppercase normalization on both sides; raw code stored regardless (AA7).
- In-payload dedup before upsert (`linkSeen` idiom) (AA8).
- Runs as a **post-success, try/catch-wrapped step** like `captureDocs` — it can never fail the catalog sync, and the sync's 0-rows/0-variants abort guards run first (AA6). Prune: `.eq('source_system','sales_layer').lt('synced_at', runStamp)` (AA2) **behind a mass-delete guard** — abort the accessory prune (and warn) if captured refs collapse toward zero while previously-referenced products are still in the feed (connector-regen wipe hazard, same philosophy as the zero-variants guard) (PL7).
- Sync report: extend the adapter's return (`accessories`, `accessories_unresolved`) and BOTH log sites (cron + manual route) (AA11).

## B. Expose (v1 build): tools

- **`get_product`, forward:** accessories fetch folded into the existing `Promise.all` (AA13). Render **grouped by resolved parent** with variant-code collapse — "Colored Lens Accessory (WAC Lighting) — amber, blue, green, red, frosted…" never 11 rows of the same parent (PL5; note the cross-brand hop is real: aiSpire fixtures reference a WAC-brand lens product). Cap rendered lines at 30 + "+N more" (MAX_FAMILY_MEMBERS idiom) (AA13). Text-only; no ProductCard change (two renderers would need work — confirmed no `related` field exists) (AA/PL open-q).
- **`get_product`, reverse ("what does this lens fit?") — restructured (AA1/PL1):** on a products-row MISS, before returning "not found": (1) match `product_accessories.related_sku = input` (normalized); (2) resolve input as a variant SKU against `products.variants` and retry both directions; only then "not found". On a products-row HIT that is itself referenced (accessory PPID, e.g. 528): also query by `related_product_sku = sku`. Fan-in is real (measured: `A2C01` → 187 parents, `LENS-16-AMB` → 89): **roll up by family with counts** ("fits 89 aiSpire fixtures across the QUARTUS, Adjusto, … families"), cap enumeration, name-first — never a PPID list (PL1b).
- **`get_related_products`:** two sections — explicit rows first ("confirmed accessories/components"), then family/category expansion under "same family or category, verify fitment"; separate counts; tool description updated so the model knows explicit data exists. `get_family` untouched in v1 — noted asymmetry: system questions routed there won't see explicit rows (AA12).
- No new tool; no analytics-bucket work needed (no new tool/doc_type) (PL9). `get_product`/`get_related_products` already public — no allowlist change.

## C. Guidance (v1 build): `COMPATIBILITY_GUIDANCE`

Both surfaces, before the tail block, authored to the copy lints (no em dashes, no bare "WAC") (PL8d), sequenced AFTER the lighting-expert prompt block lands (§G):
- Source ordering for compatibility claims: explicit accessory/component rows (authoritative) → spec sheets via `search_docs` → family/category expansion **labeled** "same family, verify fitment". Never invent or infer fitment from name similarity.
- **Track fitment gets the TRUE rule, not a table that can't answer it** (PL2): WAC track heads carry their systems in the product name ("H/J/L Track Luminaire") and letter-prefixed variant SKUs; enumerate heads for a track type via `search_products` on those markers; `track_systems`/`plan_layout` size and BOM a *known* system but cannot list heads-for-a-track. (Seeding head rows into `track_components` stays with the track doc's open item H — not this plan.)
- **Spec-sheet caveat** (PL3): accessory tables in spec sheets survive extraction with mangled column pairings (verified: Straight Edge) — name the accessory codes and cite the sheet; do NOT reconstruct code↔description↔finish pairings from a retrieved chunk.
- **Existence vs fitment split** (PL8c): existence questions ("is there a lens for X?") follow the existing never-assert-absence rule and keep searching; fitment questions ("does X fit Y?") require honest non-confirmation when no source confirms.
- **Public shape** (PL8a/b): unresolved raw codes are surfaced publicly only as "available through your WAC Group sales rep", never as bare codes (internal may see codes); aiSpire accessory/component answers note custom-integrator availability.
- Dimmer compatibility → `search_docs` on the spec sheet/manual, cite.

## D. Phase 2 (committed, separate build): PDP accessory harvest

Sampling already done (PL4). Crawl §E-style harvest of waclighting `#components` product-belt links and modernforms "Curated For You" links; slugs → SKUs by inverting `pdp_urls`; rows written with `source_system='web_crawl'`, a distinct `kind` or `source_field` so guidance can label them "listed together on the product page" vs confirmed accessory until MF's curated-scope is verified (algorithmic cross-sell risk). Schonbek: excluded (JS PDPs). Flagship regression: "which downrod fits the Wynd XL?" — unanswerable by v1 (fan accessories are a family-less grab-bag product), answered by the PDP. Also in phase 2's decision scope: variant-level capture if G.0 shows meaningful variant-only coverage.

## E. Tests

Shared parser (zmataccess comma-split incl. spaced values, zacc continuation semantics + global slot positions, N/A/`0` skip, normalization, dedup, resolution incl. raw-variant index); tools (grouped-parent collapse + caps, reverse-fit both branches + family rollup, explicit-first sections, public unresolved-code framing); guidance copy lints; sync (mass-delete guard, report counts); migration anon-boundary addition.

## G. Rollout (gated)

0. **G.0 audit gate (pre-build, one session):** (a) fetch connector variant rows and measure variant-level `zacc/zcomp/matnracc` population by brand (schema defines them; no audit has seen the data); (b) product-level `matnracc1..5`/`zmataccess` value-resolution check (do all PPIDs resolve to `products.sku`?); (c) confirm `AISPIRE` brand keying for the writer (481 products total; 417 with zacc refs) (PL11). Findings amend A's field list before code is written.
1. Migration 0060 (empty table, no behavior change; anon verify).
2. Sync-writer PR → deploy via `pnpm deploy:web` → trigger `POST /api/products/sync` (admin; the fire-and-forget 202 — watch `wrangler tail`, there is NO GitHub Actions run for this) (AA5) → verify counts (zmataccess ~569 products; zacc ~417; unresolved ≈ expectation from G.0) + spot-check 5 zmataccess products and 5 aiSpire products against their PDPs.
3. Tools + guidance PR — **after** the lighting-expert PRs land (shared prompts.ts/tools.ts; rebase, expect the one-time prompt-cache invalidation) (AA14/PL9). No feature flag: empty-table = natural dark launch; the data lands in step 2 only after step 1's verification.
4. Regressions, both surfaces (PL10): aiSpire lens forward; "what does LENS-16-AMB fit" (reverse, fan-in rollup); a zmataccess track-head accessory question; "which heads fit J track" with expected-source assertion (the C rule, not luck); Straight Edge spec-sheet-table question; Wynd XL downrod (documents the v1 gap → phase 2 flagship); public unresolved-code rendering.
5. Phase 2 build decision (D) with G.0's variant findings.

## Davis to decide

- [ ] Ratify v2 (v1 build = A+B+C after G.0; Phase 2 committed as a follow-on build).
- [ ] Confirm Phase 2 appetite now vs after v1 ships (it is where fan/downrod + cross-brand trim questions get answered).
- [ ] LIM/VENTRIX/Colorscaping/Home/LANDSCAPE brand rows: expected in catalog as distinct brand values (LIM alone has 274 products) — any brand-normalization wishes before the writer keys on them?

## Adjudication ledger

| Obj | Sev | Resolution |
|---|---|---|
| AA1/PL1 reverse-fit dead + fan-in | BLOCKER | two-branch miss-fallback + family rollup w/ caps (B) |
| AA2 prune/schema mismatch | MAJOR | synced_at + source-scoped prune (A) |
| AA3 missing indexes | MAJOR | related_sku + related_product_sku indexes (A) |
| AA4 RLS idiom | MAJOR | 0048 `using(true)` posture + anon test (A) |
| AA5 wrong rollout trigger | MAJOR | API worker cron / POST sync + tail (G.2) |
| AA6 failure posture | MAJOR | post-success try/catch step (A) |
| AA7 raw-variant resolution index | MAJOR | pre-filter index + normalization (A) |
| AA8 in-payload dupes | MINOR | linkSeen dedup (A) |
| AA9 resolved col redundant | MINOR | dropped (A) |
| AA10 unique key vs provenance | MINOR | source_system in key (A) |
| AA11 report plumbing | MINOR | adapter return + both log sites (A) |
| AA12 get_related underspec | MINOR | two sections + desc update + get_family note (B) |
| AA13 output bounds | MINOR | caps + Promise.all fold (B) |
| AA14/PL9 sequencing w/ lighting build | MINOR | Prong A parallel; B/C after; 0060 coordination (G) |
| PL2 track-table overstatement | MAJOR | true H/J/L convention rule in C + expected-source regression; head-seeding stays with track doc |
| PL3 spec-sheet table mangling | MAJOR | caveat in C + Straight Edge regression + phase-2 extraction note |
| PL4 PDP harvest is the main event | MAJOR | promoted to committed Phase 2, sampling cited (D) |
| PL5 finish-variant explosion | MAJOR | grouped-parent collapse + dedup tests (B) |
| PL6 zacc semantics | MINOR | continuation model documented, global slots (A) |
| PL7 prune wipe hazard | MAJOR | mass-delete guard (A) |
| PL8 public-surface conflicts | MAJOR | unresolved-code framing, aiSpire availability line, existence/fitment split, copy lints (C) |
| PL10 regression list | MINOR | adopted in full (G.4) |
| PL11 brand facts | MINOR | G.0c + Davis brand question |
| (self) zmataccess/zmataccesstyp2 missed | BLOCKER-scale | first-class capture source (thesis/A); variant-level + matnracc audit gate G.0 |

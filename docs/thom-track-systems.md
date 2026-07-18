# Thom Bot — Track Systems Seed (DRAFT, needs verification)

This documents the DRAFT seed in `supabase/migrations/0050_track_systems_seed.sql`,
which populates `track_systems` + `track_components` (created by `0049`) for the
Thom Bot track-BOM feature.

**Status: DRAFT.** Segment lengths and per-section wattage are trustworthy.
Circuit capacity, per-run head limits, head spacing, and head↔track
compatibility are UNVERIFIED — several are seeded `NULL` on purpose (no
fabrication). See the "DAVIS TO VERIFY" checklist at the end.

**Update — migration `0051` resolved the circuit-capacity and low-voltage feed
questions** (checklist items A, B, and the derating question). Highlights:
`circuit_va` (1920 / 4432) confirmed as the *usable* "Max Per Circuit" figure;
the double-derate bug in `trackBom` removed; **Flexrail1 reclassified low → line
(120V, transformer-less)**; X gets 4 inferred SKU-92 outdoor transformer rows.
See the "Resolved in 0051" section below the checklist for the full record.

## Sources used

| Source | What it gave | Confidence |
|---|---|---|
| Marketing `products` table (live read via `apps/api/.dev.vars` `SUPABASE_SERVICE_ROLE_KEY`, read-only REST select) | Track-section SKUs, segment lengths (from `variants[].dimensions_mm.length` + variant names like `HT4`, `WT12`, `LM-T8`), per-circuit wattage (`variants[].watts` e.g. "Max Per Circuit: 1920W"), all infrastructure SKUs (feeds/connectors/joiners/endcaps/transformers) as `is_accessory` / family rows | HIGH for lengths+wattage |
| `kb_chunks` spec_sheet text (same live DB) | Cross-checked segment matrices (JT2/JT4/JT6/JT8, WT4/WT8/WT12 + WHT 277V) and the Quick-Connect adapter head↔track mapping (`EN-HQ50AR` = H, `EN-JQ50AR` = J/J2, `EN-LQ50AR` = L) | HIGH for lengths; MED for J/J2 head compat |
| WAC domain knowledge | voltage class, proprietary-head assumptions | LOW where noted |

**Yes — I was able to query the live marketing DB read-only** for both the
`products` catalog and `kb_chunks` spec text. Component SKUs below are REAL
catalog SKUs, not placeholders (representative finish variant, usually `-BK`).

## Systems seeded (8)

Enumerated H, J, J2, L, W, Flexrail, Solorail, X. **A "Flexrail2 / dual" and a
separate legacy "X Track" were NOT found in the current catalog.** The only "X"
system present is the **Outdoor 12V Low-Voltage Track** (SKU prefix `XT` / `X-FE`),
seeded as `key='x'`. If a legacy dual Flexrail or indoor X track must be modeled,
it needs a source Davis can point me at.

### Per-system field table

Legend — Source: `PIM`=products variant data, `spec`=kb_chunks spec text,
`derived`=inferred from SKU/voltage, `GUESS`=domain assumption, `—`=seeded NULL.

| key | track_type | voltage_class | segment_lengths_ft | circuit_va | feed_capacity_w | max_heads_per_run | default_head_spacing_ft | compatible_head_track_types |
|---|---|---|---|---|---|---|---|---|
| h | H | line | [2,4,6,8] **HIGH** PIM+spec | 1920 **MED** PIM | NULL | NULL | NULL | ['H'] **LOW** GUESS |
| j | J | line | [2,4,6,8] **HIGH** PIM+spec | 1920 **MED** PIM | NULL | NULL | NULL | ['J'] **LOW** GUESS |
| j2 | J2 | line | [4,8] **HIGH** PIM | 1920 (per circuit) **MED** PIM | NULL | NULL | NULL | ['J','J2'] **MED** spec (EN-JQ50AR "J/J2") |
| l | L | line | [2,4,6,8] **HIGH** PIM | 1920 **MED** PIM | NULL | NULL | NULL | ['L'] **LOW** GUESS |
| w | W | line | [4,8,12] **HIGH** PIM+spec | 1920 **MED** PIM (120V) | NULL | NULL | NULL | ['W'] **LOW** GUESS |
| flexrail | FLEXRAIL | ~~low~~ **line** (0051) | [8] **LOW** derived | **1920** (0051) | NULL | NULL | NULL | ['FLEXRAIL'] **LOW** GUESS |
| solorail | SOLORAIL | low | [8] **HIGH** PIM (LM-T8) | NULL | NULL | NULL | NULL | ['SOLORAIL'] **LOW** GUESS |
| x | X | low | [4,8] **HIGH** PIM (XT4/XT8) | NULL | NULL | NULL | NULL | ['X'] **LOW** GUESS |

### Notes on specific values

- **circuit_va = 1920** (H/J/J2/L/W): comes from the PIM variant `watts` field
  reading "Max Per Circuit: 1920W" / "1920W". It is structured data, not prose,
  so it is more reliable than a typical prose pull — but it drives limiter/feed
  math in the BOM, so it is on the verify list. **W at 277V** carries a
  different per-circuit max (**4432W**) — captured on the `WHT*` component rows;
  `circuit_va` at the system level is the 120V figure only.
- **J2 is DUAL-circuit**: 1920W is *per circuit*. The BOM must treat J2 as two
  independent circuits (Circuit Selecting Clip SKU 998 chooses which one a head
  taps). Confirm the engine models this.
- **feed_capacity_w = NULL everywhere**: line systems are transformer-less;
  low-voltage systems (Flexrail/Solorail/X) have transformer-DEPENDENT capacity.
  For Solorail the per-transformer capacity is on component rows (`capacity_w`
  = 75/150/250/300/600 W). There is no single system-level feed capacity to seed
  honestly.
- **max_heads_per_run / default_head_spacing_ft = NULL everywhere**: not found
  in any structured source and not derivable from watts alone (depends on head
  wattage + circuit limit). NOT fabricated.
- **compatible_head_track_types**: seeded to each system's own type (proprietary
  assumption). Only J/J2 sharing is spec-backed (Quick-Connect adapter naming).
  Everything else is a reasonable-but-unverified default and MUST be confirmed.

## Components seeded

Real catalog SKUs per system, by role:

- **H**: 4 channel sections (HT2/4/6/8, cap 1920W), 3 feeds, 6 connectors, 1 joiner, 1 endcap.
- **J**: 4 channel sections (JT2/4/6/8), feed canopy + cord&plug. *J-specific
  connector set is thin in the data — J reuses many H fittings; confirm.*
- **J2**: 2 channel sections (J2-T4/T8), T-Bar end feed, feed canopy, circuit-selecting clip, wire-way cover.
- **L**: 4 channel sections (LT2/4/6/8), live-end feed, feed canopy.
- **W**: 8 channel sections — surface 120V (WT4/8/12), surface 277V (WHT4/8/12, cap 4432W), + recessed variants; quick-connect feed; flexible connector.
- **Flexrail1**: rail sections (1010, length unconfirmed) + 8' starter (1009), 2 feeds, 3 connectors, joiner, 2 endcaps. **No transformer row** (remote LV supply, not in the FLEXRAIL family).
- **Solorail**: 8' section (LM-T8), 4 feeds, 4 connectors, 3 endcaps, **7 transformers with real capacity_w (75–600W)**.
- **X (Outdoor 12V)**: 4'/8' channel (XT4/XT8), feed end, 2 connectors, joiner, endcap. **No transformer row** (remote 12V supply + 10AWG feeder cable SKU 4647).

**No `head` rows are seeded** in this DRAFT. Head SKUs + `head_watts` exist in
the catalog (e.g. Silo X10/X20, Summit, Reflex for Flexrail; the full H/J/L/W
luminaire families) but mapping every head to its system + wattage is a larger
pass — flagged below.

---

## DAVIS TO VERIFY

### A. Circuit capacity — ✅ RESOLVED in 0051 (see "Resolved in 0051" below)
- [x] **H / J / J2 / L** `circuit_va = 1920` (120V) — confirmed usable "Max Per Circuit"
- [x] **W** `circuit_va = 1920` (120V) + **277V = 4432W** on the WHT rows — confirmed
- [x] **J2** dual-circuit (1920 W *per circuit*) — noted; head-side circuit-selection is a
      configurator concern, not a BOM count (the solver sizes total circuits)
- [x] Derating basis confirmed: 1920/4432 are ALREADY 80%-derated (20A×V×0.8); the
      `trackBom` double-derate was removed

### B. Low-voltage feed capacity — ✅ RESOLVED in 0051
- [x] **Flexrail1** — it is NOT low voltage; reclassified to **line** (120V, transformer-less),
      `circuit_va=1920`, `feed_capacity_w=NULL`
- [x] **Solorail** — transformer ladder (75–600 W) already seeded in 0050; `feed_capacity_w`
      stays NULL by design — the solver selects a transformer row by capacity
- [x] **X (Outdoor 12V)** — 4 remote transformer rows added (9075/9150/9300/9600-TRN-SS =
      75/150/300/600 W); `feed_capacity_w` stays NULL. **SKU-92 mapping is INFERRED** — still
      needs product confirmation (moved to the OPEN list below)

### C. Max heads per run — seeded NULL everywhere (by design)
- [ ] Provide `max_heads_per_run` (or confirm it should stay computed via circuit/transformer
      math) for all 8 systems

### D. Default head spacing — seeded NULL everywhere
- [ ] Provide `default_head_spacing_ft` per system, or confirm it is a UI concern not a data value

### E. Head↔track compatibility — LOW confidence
- [ ] **H = ['H']**, **L = ['L']**, **W = ['W']** — confirm proprietary (no cross-fit)
- [ ] **J2 = ['J','J2']** — confirm J-series heads mount on J2 dual-circuit (spec adapter EN-JQ50AR suggests yes)
- [ ] **Flexrail / Solorail / X** = own type only — confirm
- [ ] Are there any legacy/adapter cross-compatibilities the bot should know?

### F. Segment lengths — HIGH confidence, quick sanity check
- [ ] **Flexrail1** section nominal length (seeded [8] as LOW — 1010 had no structured length; confirm)
- [ ] All others (H/J/J2/L/W/Solorail/X) match spec sheets — spot check only

### G. Component SKUs marked "to confirm"
- [ ] **J** connector set — the data only surfaced shared H/J fittings; confirm the full J-specific connector list
- [ ] **Flexrail** — no transformer SKU seeded (remote supply); confirm the correct LV transformer(s)
- [ ] **X (Outdoor)** — no transformer SKU seeded; confirm the remote 12V supply + whether cable SKU 4647 should be a component

### H. Missing/ambiguous systems
- [ ] Confirm there is **no** "Flexrail2 / dual Flexrail" to model (none in catalog)
- [ ] Confirm the "X" the feature needs = **Outdoor 12V Low-Voltage Track**, not a separate legacy indoor X track
- [ ] Should **head SKUs + head_watts** be seeded (currently omitted)? If yes, it's a follow-up extraction pass from the luminaire families.

---

## Resolved in 0051

Migration `supabase/migrations/0051_track_systems_capacities.sql` (data-only)
plus a `trackBom` code fix closed the circuit-capacity + low-voltage feed gaps.

- **`circuit_va` = usable "Max Per Circuit", NOT raw VA.** 1920 (120V) and 4432
  (277V, W-track WHT rows) are the published spec-sheet "Max Per Circuit"
  figures, which are ALREADY the 80%-derated continuous-load numbers
  (20A×120×0.8 = 1920; 20A×277×0.8 = 4432). This is now recorded as a SQL
  `comment` on `track_systems.circuit_va`.
- **Double-derate bug removed.** `trackBom` previously computed
  `circuits = ceil(totalW / (circuit_va × 0.8))`, derating a second time
  (1920 → 1536 effective). It now does `circuits = ceil(totalW / circuit_va)`.
  Because `circuit_va` is stored as usable watts, the code no longer applies any
  ×0.8. Do not re-add one.
- **Flexrail1 reclassified low → line.** SKU 1010 raw catalog copy: "Bendable
  120V monorail with 1920W maximum", "flexible line voltage system", "powered
  directly through a junction box or 120V source"; Zendesk: "rated at 20
  amps ... 2400 watts ... de-rate to 80% ... 1920 watts." It is a 120V LINE
  voltage, transformer-less system. 0050 misclassified it as `low`. 0051 sets
  `voltage_class='line'`, `circuit_va=1920`, `feed_capacity_w=NULL`, and it
  keeps **no transformer rows** (correct).
- **X (Outdoor 12V) transformer rows added.** Four remote WAC landscape magnetic
  transformers — `9075/9150/9300/9600-TRN-SS` = 75/150/300/600 W (the SKU-92
  family). The BOM solver picks the smallest transformer whose `capacity_w`
  covers the connected load (multiples of the largest when none fits). **The
  SKU-92 → X mapping is INFERRED** and remains on the human-verify list.
- **Solorail unchanged.** Its 7 transformer rows (75–600 W) from 0050 are
  already correct; 0051 does not touch them.
- **`feed_capacity_w` NULL for solorail + x by design.** Low-voltage supply is
  sized from the per-transformer `capacity_w` component rows, not a single
  system-level feed capacity.
- **`max_heads_per_run` NULL for all 8 by design.** No catalog source; the
  electrical ceiling is enforced by the circuit / transformer math in the BOM.

### Still OPEN on the human list
- [ ] **X → SKU-92 transformer mapping** — confirm `9075/9150/9300/9600-TRN-SS`
      are the right remote supplies for the Outdoor 12V track (currently inferred).
- [ ] **X outdoor rail ampacity ceiling** — is there a per-run current limit on the
      12V outdoor channel beyond transformer capacity?
- [ ] Items **C** (`max_heads_per_run`), **D** (`default_head_spacing_ft`), **E**
      (head↔track compatibility), and head SKUs / `head_watts` remain unaddressed.

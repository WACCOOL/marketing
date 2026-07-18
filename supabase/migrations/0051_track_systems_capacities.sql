-- =============================================================================
-- Thom Bot — track systems CAPACITY fills + Flexrail reclassification (0051)
--
-- Data-only follow-up to the 0050 DRAFT seed. Resolves checklist items A
-- (circuit_va), B (low-voltage feed capacity), and the derating question from
-- docs/thom-track-systems.md, grounded in live catalog + spec-sheet data.
--
-- USABLE-WATTS CONVENTION
--   circuit_va stores the published "Max Per Circuit" figure, which is ALREADY
--   the 80%-derated continuous-load number (20A × V × 0.8):
--       120V → 20 × 120 × 0.8 = 1920 W
--       277V → 20 × 277 × 0.8 = 4432 W (W-track WHT rows)
--   trackBom therefore treats circuit_va as usable continuous watts and does
--   NOT re-apply a ×0.8 derate. Do not re-add one, and do not store the raw
--   20A×V VA figure here.
--
-- FLEXRAIL RECLASSIFICATION
--   Flexrail1 (SKU 1010) is a 120V LINE-voltage, transformer-less monorail
--   ("Bendable 120V monorail with 1920W maximum", "flexible line voltage
--   system", "powered directly through a junction box or 120V source";
--   Zendesk: "rated at 20 amps ... 2400 watts ... de-rate to 80% ... 1920
--   watts"). The 0050 seed misclassified it as voltage_class='low'. It is
--   line voltage with the standard 1920 W usable-per-circuit figure and has
--   no transformer rows (correct — none are added).
--
-- LOW-VOLTAGE TRANSFORMER SELECTION
--   Solorail + X are genuinely low-voltage. trackBom sizes their supply from
--   the per-transformer capacity_w on component rows (not a system-level
--   feed_capacity_w), so feed_capacity_w stays NULL for both. Solorail already
--   has its 7 transformer rows in 0050; X gets 4 outdoor magnetic transformer
--   rows here (SKU-92 family — mapping INFERRED, still on the human-verify
--   list).
--
-- max_heads_per_run stays NULL for all 8 systems by design (no catalog source;
-- the electrical ceiling is enforced by the circuit / transformer math).
-- =============================================================================

comment on column public.track_systems.circuit_va is
  'Usable continuous watts per circuit — the published "Max Per Circuit" (already 80%-derated from 20A×V). trackBom does NOT re-derate; do not re-add a ×0.8.';

-- Flexrail1: low → line (120V, transformer-less), usable 1920 W per circuit.
update public.track_systems
   set voltage_class = 'line',
       circuit_va = 1920,
       feed_capacity_w = null
 where key = 'flexrail';

-- Line-voltage systems: circuit_va already 1920 in 0050 — reasserted here for
-- explicitness / idempotency (harmless; no value change).
update public.track_systems
   set circuit_va = 1920
 where key in ('h', 'j', 'j2', 'l', 'w');

-- Low-voltage systems size their supply from per-transformer capacity_w rows,
-- so the system-level feed_capacity_w is NULL by design (idempotent no-op).
update public.track_systems
   set feed_capacity_w = null
 where key in ('solorail', 'x');

-- X / Outdoor 12V transformer rows — remote WAC landscape magnetic transformers
-- (SKU 92 family: 9075/9150/9300/9600-TRN-SS = 75/150/300/600 W). Mapping is
-- INFERRED — flagged in notes and on the human-verify list. No unique
-- constraint exists on track_components (0049 = id PK + system_key index only),
-- so these are plain inserts.
insert into public.track_components (system_key, role, sku, description, capacity_w, notes) values
  ('x','transformer','9075-TRN-SS','12V Magnetic Transformer (Outdoor) 75W',75,'remote outdoor 12V supply, SKU 92 variant — mapping inferred, confirm with product'),
  ('x','transformer','9150-TRN-SS','12V Magnetic Transformer (Outdoor) 150W',150,'remote outdoor 12V supply, SKU 92 variant — inferred, confirm'),
  ('x','transformer','9300-TRN-SS','12V Magnetic Transformer (Outdoor) 300W',300,'remote outdoor 12V supply, SKU 92 variant — inferred, confirm'),
  ('x','transformer','9600-TRN-SS','12V Magnetic Transformer (Outdoor) 600W',600,'remote outdoor 12V supply, SKU 92 variant — inferred, confirm');

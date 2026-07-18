-- =============================================================================
-- DRAFT SEED — WAC track systems + components (for the Thom Bot track-BOM feature)
--
-- DRAFT SEED — capacity + compatibility values pending Davis verification
-- (see docs/thom-track-systems.md).
--
-- Populates the two tables created by 0049 (track_systems, track_components).
--
-- WHAT IS TRUSTWORTHY here vs. what a human must confirm:
--   * segment_lengths_ft, per-section SKUs, per-head/section watts  → HIGH
--     confidence. Sourced from the marketing `products` table variant matrices
--     (SKUs 931/932/933/934/843 etc.), which mirror the spec-sheet order
--     matrices, and cross-checked against ingested spec_sheet text in kb_chunks
--     (JT2/JT4/JT6/JT8, WT4/WT8/WT12/WHT*, HT2..HT8 all confirmed).
--   * circuit_va (line-voltage systems)  → MEDIUM. Taken from the PIM variant
--     "Max Per Circuit: 1920W" / "1920W" field. Plausible and structured, but
--     it drives limiter/feed counts in the BOM, so it is on the verify list.
--   * feed_capacity_w, max_heads_per_run, default_head_spacing_ft,
--     compatible_head_track_types  → LOW / NOT SOURCED. Left NULL where not
--     confidently sourced (NO fabrication). Every one of these is on the
--     "DAVIS TO VERIFY" checklist in docs/thom-track-systems.md.
--
-- NOTE on systems: H, J, J2, L, W (line, 120V; W also 277V) and FLEXRAIL(1),
-- SOLORAIL, X (Outdoor 12V low-voltage) are seeded. A "Flexrail2 / dual" and a
-- distinct legacy "X Track" from the original ask were NOT found in the current
-- catalog — the only "X" system present is the Outdoor 12V Low-Voltage Track
-- (SKU prefix XT / X-FE), seeded here as key 'x'. See the doc.
--
-- Component rows use a representative finish variant SKU (usually -BK/-BN);
-- finishes are cosmetic and do not change the BOM structure.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- track_systems
-- -----------------------------------------------------------------------------
insert into public.track_systems
  (key, label, track_type, voltage_class, segment_lengths_ft, circuit_va,
   feed_capacity_w, max_heads_per_run, default_head_spacing_ft,
   compatible_head_track_types)
values
  -- H Track — 120V single-circuit line voltage
  ('h', 'H Track (120V Single-Circuit)', 'H', 'line',
   ARRAY[2,4,6,8]::numeric[], 1920, NULL, NULL, NULL,
   ARRAY['H']::text[]),

  -- J Track — 120V single-circuit line voltage
  ('j', 'J Track (120V Single-Circuit)', 'J', 'line',
   ARRAY[2,4,6,8]::numeric[], 1920, NULL, NULL, NULL,
   ARRAY['J']::text[]),

  -- J2 Track — 120V DUAL-circuit line voltage (accepts J-series heads via the
  -- EN-JQ50AR "J/J2 Track" Quick-Connect adapter — confirmed in spec text).
  ('j2', 'J2 Track (120V Dual-Circuit)', 'J2', 'line',
   ARRAY[4,8]::numeric[], 1920, NULL, NULL, NULL,
   ARRAY['J','J2']::text[]),

  -- L Track — 120V single-circuit line voltage
  ('l', 'L Track (120V Single-Circuit)', 'L', 'line',
   ARRAY[2,4,6,8]::numeric[], 1920, NULL, NULL, NULL,
   ARRAY['L']::text[]),

  -- W Track — heavy-duty 2-circuit line voltage; 120V (1920W/circuit) OR
  -- 277V (4432W/circuit, SKU prefix WHT). circuit_va seeded at the 120V value;
  -- the 277V option is captured on the component rows + flagged in the doc.
  ('w', 'W Track (2-Circuit, 120V/277V)', 'W', 'line',
   ARRAY[4,8,12]::numeric[], 1920, NULL, NULL, NULL,
   ARRAY['W']::text[]),

  -- Flexrail1 — low-voltage field-bendable rail. Segment length not exposed as
  -- a structured variant (parent SKU 1010 has no variant rows); the 8' Starter
  -- Kit (1009) implies an 8' nominal section. feed_capacity_w depends on the
  -- (remote) LV transformer and is NOT in the marketing data → NULL.
  ('flexrail', 'Flexrail1 (Low-Voltage Bendable Rail)', 'FLEXRAIL', 'low',
   ARRAY[8]::numeric[], NULL, NULL, NULL, NULL,
   ARRAY['FLEXRAIL']::text[]),

  -- Solorail — low-voltage 12V/24V monorail. 8' rail sections (LM-T8).
  -- feed_capacity_w is transformer-dependent (75W–600W options) → NULL at the
  -- system level; per-transformer capacity_w lives on the component rows.
  ('solorail', 'Solorail (12V/24V Monorail)', 'SOLORAIL', 'low',
   ARRAY[8]::numeric[], NULL, NULL, NULL, NULL,
   ARRAY['SOLORAIL']::text[]),

  -- X / Outdoor Low-Voltage Track — 12V outdoor system (SKU prefix XT / X-FE).
  -- 4' and 8' channel. feed_capacity_w not in marketing data → NULL.
  ('x', 'Outdoor 12V Low-Voltage Track (X)', 'X', 'low',
   ARRAY[4,8]::numeric[], NULL, NULL, NULL, NULL,
   ARRAY['X']::text[])
on conflict (key) do update set
  label                      = excluded.label,
  track_type                 = excluded.track_type,
  voltage_class              = excluded.voltage_class,
  segment_lengths_ft         = excluded.segment_lengths_ft,
  circuit_va                 = excluded.circuit_va,
  feed_capacity_w            = excluded.feed_capacity_w,
  max_heads_per_run          = excluded.max_heads_per_run,
  default_head_spacing_ft    = excluded.default_head_spacing_ft,
  compatible_head_track_types = excluded.compatible_head_track_types;

-- -----------------------------------------------------------------------------
-- track_components
--   role ∈ channel|head|feed|connector|joiner|endcap|transformer
--   segment_length_ft: set on channel rows (HIGH conf, from variant matrices)
--   capacity_w:        set on transformer rows (from product name wattage)
--   head_watts:        left NULL — head SKUs not seeded in this DRAFT (see doc)
-- -----------------------------------------------------------------------------

-- ===== H Track (line, 120V, single circuit) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('h','channel','HT2-BK','H Track 2ft section (w/ 2 endcaps)',2,NULL,1920,'Max per circuit 1920W (from PIM variant) — verify'),
  ('h','channel','HT4-BK','H Track 4ft section (w/ 2 endcaps)',4,NULL,1920,NULL),
  ('h','channel','HT6-BK','H Track 6ft section (w/ 2 endcaps)',6,NULL,1920,NULL),
  ('h','channel','HT8-BK','H Track 8ft section (w/ 2 endcaps)',8,NULL,1920,NULL),
  ('h','feed','943','H Track "I" Power Connector',NULL,NULL,NULL,'live/power feed'),
  ('h','feed','979','H Track Live End Connector',NULL,NULL,NULL,NULL),
  ('h','feed','3523','H/J/L/J2 Track Feed Canopy with Cable Suspension',NULL,NULL,NULL,'shared feed canopy'),
  ('h','connector','935','H Track "I" Connector',NULL,NULL,NULL,NULL),
  ('h','connector','951','H Track "L" Connector - Right',NULL,NULL,NULL,NULL),
  ('h','connector','947','H Track "L" Connector - Left',NULL,NULL,NULL,NULL),
  ('h','connector','955','H Track "T" Connector',NULL,NULL,NULL,NULL),
  ('h','connector','959','H Track "X" Connector',NULL,NULL,NULL,'4-way cross'),
  ('h','connector','968','H Track Flexible Track Connector',NULL,NULL,NULL,NULL),
  ('h','joiner','990','H Track Line Voltage Track Extension',NULL,NULL,NULL,NULL),
  ('h','endcap','939','H Track "I" Dead-End Connector',NULL,NULL,NULL,NULL);

-- ===== J Track (line, 120V, single circuit) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('j','channel','JT2-BK','J Track 2ft section (w/ 2 endcaps)',2,NULL,1920,'Max per circuit 1920W (from PIM variant) — verify'),
  ('j','channel','JT4-BK','J Track 4ft section (w/ 2 endcaps)',4,NULL,1920,NULL),
  ('j','channel','JT6-BK','J Track 6ft section (w/ 2 endcaps)',6,NULL,1920,NULL),
  ('j','channel','JT8-BK','J Track 8ft section (w/ 2 endcaps)',8,NULL,1920,NULL),
  ('j','feed','3523','H/J/L/J2 Track Feed Canopy with Cable Suspension',NULL,NULL,NULL,'shared feed canopy'),
  ('j','feed','963','H/J Track Cord & Plug',NULL,NULL,NULL,'cord-and-plug feed'),
  ('j','connector','963','H/J Track Cord & Plug',NULL,NULL,NULL,'J shares many H-series fittings — verify full J connector set');

-- ===== J2 Track (line, 120V, DUAL circuit) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('j2','channel','J2-T4-BK','J2 Track 4ft dual-circuit section',4,NULL,1920,'1920W PER circuit; two independent circuits — verify'),
  ('j2','channel','J2-T8-BK','J2 Track 8ft dual-circuit section',8,NULL,1920,'1920W PER circuit — verify'),
  ('j2','feed','995','J2 Track T-Bar End Feed',NULL,NULL,NULL,NULL),
  ('j2','feed','3523','H/J/L/J2 Track Feed Canopy with Cable Suspension',NULL,NULL,NULL,'shared feed canopy'),
  ('j2','connector','998','J2 Track Circuit Selecting Clip',NULL,NULL,NULL,'selects which of the 2 circuits a head draws from'),
  ('j2','connector','997','J2 Track Wire Way Cover',NULL,NULL,NULL,NULL);

-- ===== L Track (line, 120V, single circuit) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('l','channel','LT2-BK','L Track 2ft section (w/ 2 endcaps)',2,NULL,1920,'Max per circuit 1920W (from PIM variant) — verify'),
  ('l','channel','LT4-BK','L Track 4ft section (w/ 2 endcaps)',4,NULL,1920,NULL),
  ('l','channel','LT6-BK','L Track 6ft section (w/ 2 endcaps)',6,NULL,1920,NULL),
  ('l','channel','LT8-BK','L Track 8ft section (w/ 2 endcaps)',8,NULL,1920,NULL),
  ('l','feed','982','L Track Live End Connector',NULL,NULL,NULL,NULL),
  ('l','feed','3523','H/J/L/J2 Track Feed Canopy with Cable Suspension',NULL,NULL,NULL,'shared feed canopy');

-- ===== W Track (line, 2-circuit, 120V + 277V) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('w','channel','WT4-BK','W Track 4ft surface 2-circuit (120V)',4,NULL,1920,'120V: 1920W max per circuit — verify'),
  ('w','channel','WT8-BK','W Track 8ft surface 2-circuit (120V)',8,NULL,1920,NULL),
  ('w','channel','WT12-BK','W Track 12ft surface 2-circuit (120V)',12,NULL,1920,NULL),
  ('w','channel','WHT4-BK','W Track 4ft surface 2-circuit (277V)',4,NULL,4432,'277V option: 4432W max per circuit — verify'),
  ('w','channel','WHT8-BK','W Track 8ft surface 2-circuit (277V)',8,NULL,4432,NULL),
  ('w','channel','WHT12-BK','W Track 12ft surface 2-circuit (277V)',12,NULL,4432,NULL),
  ('w','channel','WT4-RT-BK','W Track 4ft flanged recessed 2-circuit (120V)',4,NULL,1920,'recessed variant'),
  ('w','channel','WT4-RTL-BK','W Track 4ft flangeless recessed 2-circuit (120V)',4,NULL,1920,'flangeless recessed variant'),
  ('w','feed','116','W Track Quick Connect Adapter',NULL,NULL,NULL,'power/quick-connect adapter'),
  ('w','connector','848','W Track Flexible Connector',NULL,NULL,NULL,NULL);

-- ===== Flexrail1 (low voltage, bendable) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('flexrail','channel','1010','Flexrail1 Rail Sections',NULL,NULL,NULL,'section length not in structured variant data — confirm nominal 8ft'),
  ('flexrail','channel','1009','Flexrail1 8ft Starter Kit',8,NULL,NULL,'8ft starter kit implies 8ft nominal section'),
  ('flexrail','feed','1007','Flexrail1 Flexible Ceiling Power Feed',NULL,NULL,NULL,NULL),
  ('flexrail','feed','1008','Flexrail1 Stem Power Feed',NULL,NULL,NULL,NULL),
  ('flexrail','connector','1015','Flexrail1 "I" Connector',NULL,NULL,NULL,NULL),
  ('flexrail','connector','1012','Flexrail1 "I" Variable Angle Connector',NULL,NULL,NULL,NULL),
  ('flexrail','connector','1006','Flexrail1 Quick Connect Adapter',NULL,NULL,NULL,NULL),
  ('flexrail','joiner','1030','Flexrail1 Field Shortening Adapter',NULL,NULL,NULL,NULL),
  ('flexrail','endcap','1005','Flexrail1 End Cap',NULL,NULL,NULL,NULL),
  ('flexrail','endcap','1016','Flexrail1 "I" Dead-End Connector',NULL,NULL,NULL,NULL);
  -- Flexrail LV transformer is a separate/remote supply not in the FLEXRAIL 1
  -- product family — transformer role intentionally omitted (NULL), see doc.

-- ===== Solorail (low voltage 12V/24V monorail) =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('solorail','channel','LM-T8-BN','Solorail 8ft monorail section',8,NULL,NULL,NULL),
  ('solorail','feed','192','Solorail Single Power Feed',NULL,NULL,NULL,NULL),
  ('solorail','feed','195','Solorail Dual Power Feed',NULL,NULL,NULL,NULL),
  ('solorail','feed','210','Solorail Cable Power Feed',NULL,NULL,NULL,NULL),
  ('solorail','feed','221','Solorail Wall Power Feed',NULL,NULL,NULL,NULL),
  ('solorail','connector','203','Solorail "I" Connector',NULL,NULL,NULL,NULL),
  ('solorail','connector','219','Solorail "T" Connector',NULL,NULL,NULL,NULL),
  ('solorail','connector','220','Solorail Variable Angle Connector',NULL,NULL,NULL,NULL),
  ('solorail','connector','1081','Solorail "L" Connector',NULL,NULL,NULL,NULL),
  ('solorail','endcap','196','Solorail End Cap',NULL,NULL,NULL,NULL),
  ('solorail','endcap','204','Solorail "I" Dead-End Connector',NULL,NULL,NULL,NULL),
  ('solorail','endcap','223','Solorail "X" Dead-End Connector',NULL,NULL,NULL,NULL),
  ('solorail','transformer','201','Solorail 75W 12V Integrated Electronic Transformer',NULL,NULL,75,'12V'),
  ('solorail','transformer','197','Solorail 150W 12V Integrated Electronic Transformer',NULL,NULL,150,'12V'),
  ('solorail','transformer','198','Solorail 250W 12V Integrated Electronic Transformer',NULL,NULL,250,'12V'),
  ('solorail','transformer','199','Solorail 300W 12V Integrated Magnetic Transformer',NULL,NULL,300,'12V'),
  ('solorail','transformer','200','Solorail 300W 24V Integrated Magnetic Transformer',NULL,NULL,300,'24V'),
  ('solorail','transformer','517','Solorail Dual Tap 600W 12V Integrated Magnetic Transformer',NULL,NULL,600,'12V dual tap'),
  ('solorail','transformer','202','Solorail Dual Tap 600W 24V Integrated Magnetic Transformer',NULL,NULL,600,'24V dual tap');

-- ===== X / Outdoor 12V Low-Voltage Track =====
insert into public.track_components
  (system_key, role, sku, description, segment_length_ft, head_watts, capacity_w, notes)
values
  ('x','channel','XT4-BK','Outdoor 12V Track Channel 4ft',4,NULL,NULL,'12V'),
  ('x','channel','XT8-BK','Outdoor 12V Track Channel 8ft',8,NULL,NULL,'12V'),
  ('x','feed','X-FE-BK','Outdoor 12V Track Feed End',NULL,NULL,NULL,NULL),
  ('x','connector','4649','Outdoor Track L-Connector',NULL,NULL,NULL,NULL),
  ('x','connector','4650','Outdoor Track Flex Connector',NULL,NULL,NULL,NULL),
  ('x','joiner','4652','Outdoor Track Joiner',NULL,NULL,NULL,NULL),
  ('x','endcap','4651','Outdoor Track End Cap',NULL,NULL,NULL,NULL);
  -- 12V supply for the outdoor system is a separate remote transformer + the
  -- 10AWG feeder cable (SKU 4647) — capacity not in marketing data (NULL).

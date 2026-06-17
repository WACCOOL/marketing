-- =============================================================================
-- Seed the UTM source -> medium mapping (post-review).
--
-- 0023 seeded only the social-channel rule. This fills in the agreed mapping for
-- the remaining sources, adds the `poster` medium, and retires `qr` as a
-- selectable medium: every printed piece carries a QR code, so QR is a delivery
-- mechanism, not a channel. Deleting the vocab row only drops it from the builder
-- dropdown — already-tagged URLs keep whatever value was baked in, and the
-- UTM & QR table still renders any legacy `utm_medium=qr` value.
-- =============================================================================

-- Vocab: add `poster`, retire `qr`.
insert into public.utm_vocab (type, value) values
  ('medium', 'poster')
on conflict (type, value) do nothing;

delete from public.utm_vocab where type = 'medium' and value = 'qr';

-- Mapping (the six social channels are already mapped to organic_social /
-- paid_social by 0023).
insert into public.utm_source_medium (source, medium) values
  ('print',     'postcard'),
  ('print',     'vignette'),
  ('print',     'poster'),
  ('tradeshow', 'postcard'),
  ('tradeshow', 'vignette'),
  ('tradeshow', 'poster'),
  ('email',     'email'),
  ('email',     'paid_media'),
  ('search',    'paid_media'),
  ('display',   'banner'),
  ('display',   'paid_media')
on conflict (source, medium) do nothing;

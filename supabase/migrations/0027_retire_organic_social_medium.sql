-- =============================================================================
-- Retire `organic_social` as a selectable medium.
--
-- Mirrors how 0024 retired `qr`: deleting the vocab row only drops it from the
-- builder dropdown and the social fan-out — already-tagged URLs keep whatever
-- value was baked in, and the UTM & QR table still renders any legacy
-- `utm_medium=organic_social` value. 0023 mapped the six social channels to
-- organic_social / paid_social; we drop the organic_social half of that here.
-- =============================================================================

delete from public.utm_source_medium where medium = 'organic_social';

delete from public.utm_vocab where type = 'medium' and value = 'organic_social';

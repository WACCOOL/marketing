-- =============================================================================
-- Seed data
-- =============================================================================

insert into public.approved_domains (domain) values
  ('waclighting.com'),
  ('wacgroup.com'),
  ('modernforms.com'),
  ('schonbek.com'),
  ('waclighting.com.cn')
on conflict (domain) do nothing;

-- UTM vocab from the existing reference sheets.
insert into public.utm_vocab (type, value) values
  ('source', 'print'),
  ('source', 'tradeshow'),
  ('source', 'email'),
  ('source', 'search'),
  ('source', 'display'),
  -- social channels are valid sources too (used by the fan-out tool)
  ('source', 'youtube'),
  ('source', 'tiktok'),
  ('source', 'linkedin'),
  ('source', 'facebook'),
  ('source', 'instagram'),
  ('source', 'x')
on conflict (type, value) do nothing;

insert into public.utm_vocab (type, value) values
  ('medium', 'postcard'),
  ('medium', 'vignette'),
  ('medium', 'paid_media'),
  ('medium', 'social'),
  ('medium', 'organic_social'),
  ('medium', 'paid_social'),
  ('medium', 'email'),
  ('medium', 'banner'),
  ('medium', 'qr')
on conflict (type, value) do nothing;

insert into public.utm_vocab (type, value) values
  ('content', 'aia'),
  ('content', 'ce_pro'),
  ('content', 'product_launch'),
  ('content', 'newsletter')
on conflict (type, value) do nothing;

-- HubSpot campaigns: dev seed. The live sync (hubspot-live milestone) replaces
-- this from the HubSpot API. The id+slug pair encodes deterministically as
-- "{hubspot_id}_{slug}" — matching the PRD's reference format.
insert into public.hubspot_campaigns (hubspot_id, slug, name) values
  ('39174698', 'hd_expo_2026', 'HD Expo 2026'),
  ('39174699', 'lightovation_2026', 'Lightovation 2026'),
  ('39174700', 'spring_launch_2026', 'Spring Product Launch 2026'),
  ('39174701', 'always_on', 'Always-on / Evergreen')
on conflict (hubspot_id, slug) do nothing;

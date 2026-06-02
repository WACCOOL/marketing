-- =============================================================================
-- Drop placeholder HubSpot campaign seeds
-- =============================================================================
--
-- The four rows seeded in 0005_seed.sql were dev placeholders with fake numeric
-- ids (3917xxxx). Now that the live HubSpot sync is enabled (HUBSPOT_TOKEN set),
-- the `hubspot_campaigns` cache is populated from the Marketing Campaigns v3 API
-- using real UUID ids. Remove the placeholders so they don't appear alongside
-- live campaigns in the UTM builder dropdown.
--
-- Note: the live sync also prunes stale rows on each refresh (any row whose
-- synced_at predates the latest successful pull), so this is belt-and-suspenders
-- for the window before the first sync runs. Safe to no-op if already gone.

delete from public.hubspot_campaigns
where hubspot_id in ('39174698', '39174699', '39174700', '39174701');

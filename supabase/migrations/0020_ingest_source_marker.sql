-- =============================================================================
-- Marketing data ingestion — source change marker (for the Graph pullers)
--
-- The scheduled Microsoft Graph pullers (Territory SharePoint file, Open Orders
-- mailbox attachment) run on a cron and must avoid re-ingesting unchanged files.
-- Each ingestion records the upstream source's change marker:
--   - Territory:   the SharePoint driveItem eTag (changes only when the file does)
--   - Open Orders: the email's receivedDateTime (a per-message cursor)
-- The puller compares the latest stored marker for the source against the
-- current upstream marker and skips (Territory) or only pulls newer messages
-- (Open Orders). Null for files that arrive via the push endpoint.
-- =============================================================================

alter table public.data_ingestions
  add column if not exists source_marker text;

create index if not exists data_ingestions_source_marker_idx
  on public.data_ingestions (source, created_at desc);

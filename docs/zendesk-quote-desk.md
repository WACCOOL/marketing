# Zendesk ↔ HubSpot ticket mirror + Quote Desk card

What ships in the Worker (`apps/api`) + the HubSpot UI extension (`apps/quote-desk`):

- **Quote Desk card** on deal records — one front door for all quote request
  types. Reads deal props directly (no prefill workflows), enforces the
  required-field contract (`@wac/shared` `quoteDesk.ts`, served at
  `GET /api/quote-desk/spec`), files the Zendesk ticket per the quoting team's
  lifecycle rule, writes corrected values back to the deal, and mirrors the
  ticket into HubSpot. Replaces the HubSpot form + prefill/trigger workflows +
  make.com scenario.
- **Generic Zendesk → HubSpot mirror** (`zendeskSync.ts`) for every allowlisted
  customer-facing group: HubSpot ticket per Zendesk ticket (pipeline per
  group), requester → contact (create-if-missing, **fake-email guard**), deal
  adoption for the Quotes group (deal-ID field, else SAP quote number), and a
  full public-comment mirror (one Note on the HubSpot ticket + the deal for
  quote tickets), all idempotent via `zendesk_tickets` /
  `zendesk_ticket_comments` (migration 0041).
- Webhook: `POST /api/zendesk/webhook` (HMAC-verified, enqueues onto the serial
  `wac-zendesk-sync` queue) + `/webhook/sync` inline sibling, `/backfill`,
  `/reconcile` (admin token), and a daily 08:45 UTC reconcile cron.

## Lifecycle rule (Janelle)

- Active ticket (new/open/pending/hold) → append a public comment.
- Solved + revision/follow-up → comment (reopens the same task); solved + a
  NEW quote ask → fresh ticket.
- Closed → fresh ticket; revisions/follow-ups link via `via_followup_source_id`.

## Manual setup

### Cloudflare — DONE 2026-07-14

- Queues `wac-zendesk-sync` + `wac-zendesk-sync-dlq` created.
- Prod secrets set: `ZENDESK_SUBDOMAIN` (**modernforms** — the one Zendesk
  instance for all brands), `ZENDESK_EMAIL` (Davis; swap to a dedicated
  integration agent later if audit noise matters), `ZENDESK_API_TOKEN`
  (Zendesk token named "Hubspot_Sync").
- Still pending: `ZENDESK_WEBHOOK_SECRET` (after the webhook is created) and
  `QUOTE_DESK_CLIENT_SECRET` (after `hs project upload`).

Migration 0041: applied 2026-07-14.

### HubSpot — pipeline/properties DONE 2026-07-14

1. Scopes: `tickets` added; notes + contacts write were already covered by the
   existing grants (verified empirically — note create/delete round-trip).
2. **One-pipeline reality**: the portal allows a single ticket pipeline
   (Service Hub free tier), so per-group pipelines are out. The default
   pipeline (id `0`) was repurposed to **"Zendesk Tickets"** with stages:
   New = `1`, In Progress = `1399042079`, Waiting on Requester = `1399042080`,
   Solved = `1399042081` (closed state), Closed = `4`. All synced groups share
   it; segment views/reports by the `zendesk_group` ticket property. If
   Service Hub is ever upgraded, split into per-group pipelines and update
   `ZD_SYNC_GROUPS`.
3. Ticket properties created: `zendesk_ticket_id` (unique), `zendesk_ticket_url`,
   `zendesk_group`, `quote_request_type`.
4. Quote Desk app: `cd apps/quote-desk && hs project upload` (see its README);
   copy the app's client secret into `QUOTE_DESK_CLIENT_SECRET`.

### Zendesk (Admin Center, modernforms.zendesk.com)

1. ~~API token~~ — done ("Hubspot_Sync", under Davis's account).
2. Webhook (`Apps and integrations → Webhooks → Create webhook`): pick
   **"Trigger or automation"** (NOT "Zendesk events"), then:
   - Name: `Mirror to HubSpot`
   - Endpoint URL: `https://marketing.gowac.cc/api/zendesk/webhook`
   - Request method: `POST` · Request format: `JSON`
   - Authentication: **None** (every webhook is HMAC-signed automatically;
     that signature IS the auth)
   - After creating: open the webhook → reveal the **signing secret** →
     `wrangler secret put ZENDESK_WEBHOOK_SECRET` (from `apps/api`).
   - Note: "Test webhook" returns 401 until the secret is set AND the PR is
     deployed — expected.
3. Trigger (`Objects and rules → Business rules → Triggers → Create trigger`):
   - Name: `Mirror to HubSpot`
   - Conditions, **Meet ALL**: `Group` · `Is` · `Quotes`
     (add more groups later as a Meet-ANY group block when expanding scope)
   - Conditions, **Meet ANY**: `Ticket` · `Is` · `Created` — `Comment` · `Is` ·
     `Public` — `Status` · `Changed`
   - Actions: `Notify active webhook` → `Mirror to HubSpot`, JSON body:
     `{"ticket_id": {{ticket.id}}}` (ids only; the Worker re-fetches the
     ticket + comments).
   - **Create the trigger only after the PR is deployed and
     ZENDESK_WEBHOOK_SECRET is set** — otherwise every quote update piles up
     401s and Zendesk's circuit breaker may disable the webhook.

### Worker vars

`ZD_SYNC_GROUPS` is set in `wrangler.jsonc` (Quotes → pipeline `0` with the
real stage ids). Add more group entries as they're brought into the mirror.

## Rollout (dark launch)

1. Deploy with `ZENDESK_SYNC_WRITE` **unset** — webhook + trigger live, the
   sync logs `[zendesk-sync] would …` and maintains the Supabase mapping only.
   Watch ~a week of traffic; validate deal/contact matches and tune
   `isFakeZendeskEmail` (`@wac/shared`) against `requester_email_fake` rows.
2. Set `"ZENDESK_SYNC_WRITE": "1"` in wrangler vars → live writes.
3. Backfill per group (Quotes first):
   `POST /api/zendesk/backfill?group=1500002309801` (open-ish tickets) or
   `&days=N` to include recently solved/closed. Admin token. Idempotent.
4. Upload the card; pilot with the quoting team + a few sales users (the old
   form can coexist — the open-ticket check dedupes).
5. Cutover: disable HubSpot workflows **1747807529** (prefill) and
   **1747841352** (trigger → make.com), unpublish the quote-request form,
   pause → delete the make.com scenario.

## Open items

- Confirm required-vs-optional field split + `how_can_we_help` /
  `hs_priority` option lists with quoting (SOP) — `@wac/shared` `quoteDesk.ts`.
- Real `(Quotes) Category` tag values for custom/international (v1 files
  everything as `quotes_category_quotations`; type carried in subject + body) —
  `REQUEST_TYPE_ROUTING` in `apps/api/src/quoteDesk.ts`.
- Confirm the solved-tier reopen behavior with Janelle after the pilot.
- OA integration for custom/Schonbek/international (separate project; plugs
  into `REQUEST_TYPE_ROUTING`).

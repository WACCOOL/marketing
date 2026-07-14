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

### Cloudflare

```bash
npx wrangler queues create wac-zendesk-sync
npx wrangler queues create wac-zendesk-sync-dlq
wrangler secret put ZENDESK_SUBDOMAIN     # e.g. waclighting
wrangler secret put ZENDESK_EMAIL         # dedicated integration agent's login
wrangler secret put ZENDESK_API_TOKEN
wrangler secret put ZENDESK_WEBHOOK_SECRET
wrangler secret put QUOTE_DESK_CLIENT_SECRET   # after the app exists (below)
```

Apply `supabase/migrations/0041_zendesk_tickets.sql`.

### HubSpot

1. Private app (HUBSPOT_TOKEN): add ticket + note read/write scopes
   (`crm.objects.tickets`, notes/engagements as named in the scope picker) and
   contact write.
2. Ticket pipelines: create "Quote Requests" (suggested stages: New → In
   Progress → Waiting on Requester → Quoted → Closed) plus one pipeline per
   additional synced group. Record every pipeline + stage id.
3. Ticket properties (single-line text unless noted): `zendesk_ticket_id`
   (enable "require unique values"), `zendesk_ticket_url`, `zendesk_group`.
4. Quote Desk app: `cd apps/quote-desk && hs project upload` (see its README);
   copy the app's client secret into `QUOTE_DESK_CLIENT_SECRET`.

### Zendesk (Admin Center)

1. API token for a dedicated integration agent (`Apps and integrations → APIs`).
2. Webhook → `https://marketing.gowac.cc/api/zendesk/webhook`, auth "none"
   (the HMAC signature is the auth); reveal the signing secret →
   `ZENDESK_WEBHOOK_SECRET`.
3. Trigger "Mirror to HubSpot": conditions — Group is one of the allowlisted
   customer-facing groups AND (comment is public OR status changed); action —
   notify the webhook with body `{"ticket_id": {{ticket.id}}}` (ids only; the
   Worker re-fetches the ticket + comments).

### Worker vars (at rollout)

`ZD_SYNC_GROUPS` (JSON, keyed by Zendesk group id — the allowlist AND the
pipeline map; internal groups excluded by omission):

```json
{
  "1500002309801": {
    "name": "Quotes",
    "pipelineId": "<Quote Requests pipeline id>",
    "stages": { "new": "…", "open": "…", "pending": "…", "hold": "…", "solved": "…", "closed": "…" }
  }
}
```

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

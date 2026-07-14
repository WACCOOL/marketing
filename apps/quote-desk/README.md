# Quote Desk (HubSpot UI extension)

CRM card on **Deal** records — one front door for every quote request type
(new / revision / follow-up change / custom / Schonbek / international). The
card reads deal properties directly, enforces the required-field contract
served by the Worker (`GET /api/quote-desk/spec`, source of truth in
`@wac/shared` `quoteDesk.ts`), and submits to `POST /api/quote-desk/requests`,
which files the Zendesk ticket, mirrors it to a HubSpot ticket, and writes
corrected values back onto the deal.

This is a **HubSpot developer project**, not a Worker — it deploys with the
HubSpot CLI, never with wrangler/CI:

```bash
npm i -g @hubspot/cli
hs init            # once: link the CLI to the portal (46455872)
cd apps/quote-desk
hs project upload  # build + deploy the app/card
```

Setup notes:

- **Private app**: on first upload the project creates the `wac-quote-desk`
  private app. Copy its **client secret** into the Worker:
  `wrangler secret put QUOTE_DESK_CLIENT_SECRET` (the Worker verifies
  `X-HubSpot-Signature-v3` on every card request and only then trusts the
  server-appended `userEmail` as the submitting user).
- **permittedUrls**: `hubspot.fetch` may only call URLs allowlisted in
  `src/app/app.json` (`https://marketing.gowac.cc`).
- The card requires an **Enterprise** portal (private-app app cards).
- `platformVersion` is pinned to `2023.2`; if `hs project upload` prompts to
  migrate to a newer platform version, follow the CLI migration — the extension
  code is version-agnostic, only the `*.json` config shapes change.

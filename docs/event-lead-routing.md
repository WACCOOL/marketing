# Marketing-Event Lead Routing — Reference

How a marketing-event attendee becomes one or more HubSpot **Leads**, who owns them,
and everything that gets written along the way. This is the behavior of
`POST /api/hubspot/event-lead` (code: `apps/api/src/eventLead.ts` +
`packages/shared/src/hubspot/leadOwnership.ts`).

**Last updated:** 2026-07-02 (PRs #95–#106).

---

## 1. Trigger

A HubSpot workflow (trigger = attendee **static list membership**; re-enrollment must
be ON) runs a custom-code action that POSTs the contact id to the webhook. The
workflow does **not** need to pass a campaign — but if it passes
`campaignName`/`campaignId`/`campaignBrand`/`campaignChannel`, those win.

**Campaign & event are auto-resolved** from the contact's marketing-event history:
most recent participation (by occurrence, skipping cancellations) whose event has a
campaign → that event + its campaign. The event date also anchors the notes-freshness
check (§6).

---

## 2. Routing order (first match wins)

```
1. Competitor gate      → no leads at all
2. Inside-sales (ISR)   → lead(s) to the inside sales person(s)
3. National account     → Sara Kruid
4. Decision tree        → rep-code owners / fixed people (may fan out)
   … then, always: contact-owner notification (§5)
```

### 2.1 Competitor gate

Contact is in dynamic list **1966 "Competitor Contacts Based on Domain"** **and** has
no associated company with an account number → **no lead is created**
(`skippedReason: "competitor"`). An account-numbered company (a real customer)
exempts them. The list is checked live, so editing the list changes behavior
immediately. A lists-API failure fails **open** (lead still created).

### 2.2 Inside-sales override

Every associated company (not just the primary) with an **account number** and an
**inside sales person** routes the lead to that ISR, replacing all other routing.

- ISR source: `inside_sales_rep_from_sap`; fallback `inside_sales_manager_1` + `_2`.
- **One lead per distinct ISR** — the same person on several accounts gets one lead
  (accounts merged in the label, e.g. `Inside sales (acct MF10375, 2010375)`).
  Different ISRs on different accounts → one lead each; every lead's co-owners field
  and the timeline note (§7) tell each ISR who else got one.
- **Brand narrowing:** when a brand is known (campaign brand, else a fresh-notes
  brand ask, §6) and the contact spans both families, only the matching family's
  accounts keep leads — `MF…` account numbers = Modern Forms/Schonbek family,
  everything else = WAC family.
- **National account + ISR:** the ISR owns the lead, and **Sara Kruid also gets her
  own lead** labeled "National account (notified)".

### 2.3 National account (no ISR)

Email domain in the national-account domain mirror (synced daily from
`national_account = true` companies) **or** the primary company flagged → single lead
to **Sara Kruid**.

### 2.4 Decision tree

#### Location (first switch)

| Location | Route |
|---|---|
| **Canada** (country code CA) | Lana (manual) |
| **Latin America** — Americas outside US/Canada: Mexico, Central America, Caribbean, South America (country name or ISO code; overrides `global_region`) | Lana (manual — the international team only covers outside N+S America) |
| **International** (rest of world) | By brand: Schonbek → Angela Yost · Modern Forms → Navita Phagoo · WAC → by country (HK/Macao/Taiwan → Wilson Tson · Thailand → Wijitporn · Australia/NZ → Rebekah Thompson · Indonesia → Budi · India/Sri Lanka → Hemanth · rest → Betty Luo) |
| **North America** (US) | Company-type switch below |
| **Unknown** | Lana |

#### Company type (North America)

Company type comes from the primary company's `company_sub_type_simplified`, falling
back to the legacy `company_sub_type`, falling back to the **contact's own "Contact
Type" (`lead_type`)** when there's no company (so a solo designer on gmail still
routes as a designer). Free-text variants like "Interior Design Firm: Residential"
map to Interior Designer, and the `: Residential/Commercial` suffix supplies the
project focus directly.

| Company type | Route |
|---|---|
| **National Accounts** | Sara Kruid |
| **Specifier** (A&D / engineer / architect / lighting designer) | WAC brand → WAC Spec rep · MF/Schonbek/MF Fans → MF Spec rep |
| **Showroom / Distributor** | By **product focus** (AI decorative-vs-functional, §4): **Functional** → WAC Showroom rep-code owner · **Decorative** → by brand (WAC → WAC Showroom · MF/Schonbek → MF Showroom **RSM** (Nick/Dhane) · MF Fans → WAC Fans) · **Both** → a lead down each branch · blank → Functional |
| **Interior Designer** | By **project focus** (§4): **Residential** → WAC → WAC Showroom · MF/Schonbek → **Kalin Scott** · MF Fans → WAC Fans; **Commercial** → MF/Schonbek → **Rudy Soni** (Hospitality/Contract) · WAC → WAC Spec · MF Fans → MF Spec |
| **Contractor / Builder** | Residential → WAC Showroom owner · Commercial → spec split (WAC → WAC Spec, decorative brands → MF Spec) |
| **E-Retailer** (Wayfair, internet retail) | Harry Moshos |
| **Hospitality** | Rudy Soni (Contract WAC/MF by brand) |
| **Landscape** | Landscape channel rep |
| **Integrator** | Integration channel rep |
| **Other / unknown** | By project focus + role: residential designer → designer path · residential contractor → WAC Showroom · commercial designer → commercial designer path · commercial other → spec split · residential other → **Lana** |

**Rep-code leaves** resolve through the contact's `rep_code_<channel>` properties
(set by ZIP) → the Rep Code object's owner (or its Regional Sales Manager for
RSM leaves). A blank rep code or unresolvable owner falls back to **Lana**.

---

## 3. Brand resolution (order)

1. **Campaign brand** passed by the workflow (a Schonbek event wins over everything)
2. **Fresh at-show notes** mentioning exactly one brand (§6)
3. Showroom/Distributor only: **product focus** (Decorative → Modern Forms, Functional → WAC)
4. Contact's **per-brand lead scores** (highest wins)
5. Still unknown → **fan-out**: the tree evaluates *every* brand branch and creates
   one lead per distinct owner (deduped; blind fallbacks dropped when a real owner
   exists)

---

## 4. AI classifiers (just-in-time)

Two company multi-selects are filled by Gemini website crawls the first time an
unclassified company's attendee comes through (also available as backfills/webhooks):

- **`project_focus`** (Residential/Commercial) — interior designers. Commercial only
  when it's a genuine focus. Blank when the company has no website.
- **`product_focus`** (Functional/Decorative) — showrooms/distributors. Electrical
  business names ("… Electric Supply/Co/Contractors") are always at least
  Functional; `MF…` account numbers and curated names (Ferguson, CED, Graybar)
  short-circuit deterministically. A company can be both → both routing branches.

Values are written to the company once and reused for every later attendee.

---

## 5. Contact-owner rules

- **Notification lead:** if the contact already has an owner (and it isn't Lana, the
  fallback), that owner **also** gets a lead — "Existing contact owner (notified)" —
  in addition to the routed owner(s). Deduped if they're already a routed owner.
- **Setting the owner:** if the contact has *no* owner and routing produced exactly
  one owner, that owner is written onto the contact. Fan-outs (multiple owners)
  leave the contact owner untouched.

---

## 6. At-show notes (`lead_notes` on the contact)

- Included on the lead **only when fresh**: the contact property's last write
  (via property history) is within **±14 days of the event date**. Old notes from
  previous shows never leak forward.
- The note is **date-stamped** on the lead: `[2026-07-02] Asked about …`.
- A fresh note mentioning **exactly one brand** (Schonbek / Modern Forms / MF Fans /
  WAC) acts as the brand ask: it narrows ISR account selection and feeds the tree's
  brand. Ambiguous notes (multiple brands) are included but don't steer routing.

---

## 7. What gets created

For **each** resulting owner, one Lead:

| Field | Value |
|---|---|
| `hs_lead_name` | `<Contact name> — <Campaign>` (e.g. "Jane Doe — Lightovation 2026 Summer") |
| Owner | The routed owner |
| Pipeline / stage | Leads pipeline, **New** |
| `hs_lead_type` | **Re-attempting** if *any* associated company has an account number, else **New business** |
| `marketing_event_source` | The campaign name |
| `rep_code_routing` | The overseeing rep code (when routed via a rep-code channel) |
| `lead_co_owners` | Names of the other owners who also got a lead for this attendee |
| `lead_notes` | Fresh at-show notes, date-stamped (§6) |

**Associations on each lead:** the contact (Primary) · the **campaign** (0-35) · the
**marketing event** (0-54) · the routing **Rep Code object** ("Routing Rep Code"
label).

**Timeline note (visible everywhere):** when leads are shared across owners — or
there are at-show notes — a Note is logged on the **contact**:

> **Event lead routing — Lightovation 2026 Summer**
> Leads created for:
> • Kamila Rutkowska — Inside sales (acct MF10375)
> • Stephen Henriquez — Inside sales (acct 2010375)
> • Navita Phagoo — Existing contact owner (notified)
>
> **At-show notes** [2026-07-02] Asked about WAC track lighting pricing

It's attached to the contact (HubSpot leads can't hold their own engagements) and
therefore shows on the contact record **and on every lead record** for that attendee.

---

## 8. Worked examples

| Attendee | Situation | Outcome |
|---|---|---|
| Contact with accounts `#MF10375` + `#2010375`, different ISRs, owner = Navita | ISR override | 3 leads: Kamila (MF acct), Stephen (WAC acct), Navita (notified) — all Re-attempting, shared-with note |
| Same, but fresh note says "WAC track lighting" | Brand ask narrows | Stephen only (+ Navita notified), note on the lead |
| Decorative lighting showroom, no accounts w/ ISR, no campaign brand | Tree | MF Showroom RSM (Decorative → Modern Forms) |
| Electrical supply house | Tree | WAC Showroom owner (Functional) |
| Residential interior designer, brand unknown | Fan-out | WAC Showroom owner + Kalin Scott |
| Contact in Brazil / Mexico (no ISR accounts) | Latin America | Lana (manual routing) |
| acuitybrands.com contact, no account | Competitor gate | **No lead** |
| Wayfair contact | E-Retailer | Harry Moshos |

---

## 9. Ops notes

- **Queue-based processing:** the webhook only *enqueues* (onto the Cloudflare Queue
  `wac-event-leads`) and acks — so enrolling an entire attendee list at once is safe.
  A **serial** consumer (`max_concurrency: 1`) drains contacts one at a time within
  HubSpot's API rate limit, retrying failures up to 3× with delays. Expect a large
  list to finish over ~10–30 minutes, not instantly.
- **Idempotent:** an owner who already has a lead for this contact + campaign is
  skipped, so retries and workflow re-enrollments never create duplicates — they only
  fill in what's missing.
- **Outcome audit:** every processed contact gets a row in the Supabase table
  `event_lead_outcomes` (status: `done` / `skipped_competitor` / `skipped_existing` /
  `no_owner` / `error`, plus the created leads, lead type, and any error). "Why didn't
  X get a lead?" is a query against that table.
- **Testing:** `POST /api/hubspot/event-lead/sync` with `{"contactId": "...", "dryRun": true}`
  returns the full decision (owners, paths, campaign, lead type, notes) without
  creating anything.
- HubSpot workflow: re-enrollment must be enabled for repeat attendees; **no workflow
  rate limit needed** (the queue does the pacing).
- Required private-app scopes: CRM objects (contacts/companies/leads/notes read+write),
  **lists read**, **marketing-events read**.
- Owner ids, channel names, association type ids, windows (±14d notes) live at the
  top of `apps/api/src/eventLead.ts`; the routing tree lives in
  `packages/shared/src/hubspot/leadOwnership.ts` (unit-tested — `pnpm test`); the
  queue consumer is `apps/api/src/eventLeadQueue.ts`.

# Thom Bot — Response Feedback Plan (v2 — RECONCILED)

**Status:** v2 RECONCILED, 2026-07-21. Counter-plan objections F1–F15 adjudicated and folded in (ledger at end); **awaiting Davis ratification**. No code has been written.

**Migration number:** this plan takes **`0062_thom_feedback.sql`**. `docs/thom-attribute-filter-plan.md` also claims 0062 (`0062_product_spec_filter.sql`); per the reconcile, **feedback gets 0062 and the attribute-filter plan renumbers to 0063**. Re-verify `supabase/migrations/` at build time regardless (0061 `product_accessories` is the last shipped number today).

**Thesis.** Davis wants to learn from good and bad answers. Every assistant response on both surfaces gets thumbs up / thumbs down; a thumbs-down opens an optional "why" free-text. Ratings land in a new `thom_feedback` table that snapshots the rated question/answer pair, keys back to `thom_messages` where an id exists, and surfaces in the admin Analytics page (counts, positive rate, per-day trend, and a browsable list of Q/A/rating/reason) plus inline in the Chats thread viewer. The public surface's "session-only history" posture is preserved: feedback is an explicit, user-initiated act that stores only the rated pair, with disclosure copy — and in practice public turns are *already* persisted admin-side via the 0057 log bridge, so feedback adds a rating dimension, not a new class of retention.

## Audit — what exists today

| Fact | Where | Consequence for this design |
|---|---|---|
| Internal chat logs every turn as two `thom_messages` rows (user + assistant) with uuid `id`s | `apps/api/src/routes/thom.ts:159-184` (`logTurn`), `supabase/migrations/0044_thom_conversations.sql:61-83` | A DB identity for every internal answer already exists… |
| …but `logTurn` never returns the inserted ids, and the SSE `done` frame carries only `{usage}` | `thom.ts:169-183`, `thom.ts:229-233` | the client cannot key a rating today → B.1 returns the assistant message id in `done` |
| Internal client `Turn` has no id; meta frame carries only `conversationId` | `apps/web/src/pages/ThomChat.tsx:30-36`, `apps/web/src/lib/thom.ts:160,186` | add `messageId?` to `Turn`; hide thumbs when absent (old persisted transcripts) |
| Reloaded conversations drop message ids (`mapMessagesToTurns` maps role/text/cards only) | `thom.ts:51-67`, select at `thom.ts:326-331` | select `id` and carry it through so history reloads stay ratable |
| **`prepareTurn` loads any client-supplied `conversationId` with the service client and NO ownership check** — history from someone else's conversation would be read into the model context | `thom.ts:121-133` (service `admin` client, no `user_id` filter) vs the owner-scoped GET at `thom.ts:317-324` | pre-existing hole, in scope per F5: PR 1 adds the same ownership 404 the GET uses, *before* any history load |
| PostgREST `onConflict:` emits a bare `ON CONFLICT (cols)`, which Postgres can only resolve against a **non-partial** unique index — partial unique indexes break every upsert with "no unique or exclusion constraint matching the ON CONFLICT specification" | `supabase/migrations/0046_product_documents_conflict_index.sql` (the docs-ingest outage this exact mistake caused) | F1/F2: the v1 two-partial-index dedup design is unbuildable as specced → single total `dedup_key` column (A) |
| Public worker persists NO history itself, by design ("session-only history… never persisted server-side") | `apps/thom-bot/src/index.ts:26-28`, memory `thom-public-surface` | feedback must not quietly change this posture → snapshot-at-feedback-time + disclosure (C.2) |
| BUT completed public turns are already POSTed (best-effort, `waitUntil`) to the API worker's shared-secret bridge, which writes `thom_conversations`/`thom_messages` under `public_session_key` (SHA-256 of the session token, 24h grouping) | `apps/thom-bot/src/index.ts:159-195,225`, `apps/api/src/routes/thomPublicLog.ts:33-91`, `0057:27-32` | the bridge pattern is the proven "anon worker → service-role write" path; feedback reuses it (confirmed sound by the counter-plan). Linkage to the logged conversation is possible via the same `public_session_key` |
| The widget client never learns any server id: `meta` is ignored, `done` is `{usage}` only; turns live in localStorage | `apps/thom-bot/widget/src/stream.ts:36-53`, `widget/src/session.ts:114-148`, `widget/src/types.ts:22-28` | public needs a **client-minted synthetic key** (`client_turn_id` uuid per assistant turn, persisted with the turn) — B.2 |
| Public chat is gated: allowed Origin → Turnstile-minted, IP-bound session (`verifySession`) → KV rate caps (`checkAndIncrRate`, default 20/min, 300/day) | `apps/thom-bot/src/index.ts:91-149`, `apps/thom-bot/src/limits.ts:37,68-95` | the feedback endpoint sits behind the same session + a dedicated (smaller) KV rate key (namespacing confirmed sound) |
| Widget runtime config endpoint exists and returns only `turnstileSiteKey` | `apps/thom-bot/src/index.ts:47-53`, `widget/src/config.ts:3-16` | natural place to expose a `feedbackEnabled` flag for dark launch (G) — but the flag is UI-only; the route itself also gates (F8) |
| Admin analytics = 0057/0058 RPCs (`thom_chat_daily`, `thom_top_queries`, `thom_top_products`, `thom_source_usage`, SECURITY INVOKER, own-or-admin RLS) fanned out by `GET /api/thom-admin/analytics` | `0057:54-150`, `0058:22-104`, `apps/api/src/routes/thomAdmin.ts:111-134` | feedback follows the same shape: one new RPC for daily counts, PostgREST list read under admin RLS |
| Analytics UI: stat tiles + hand-rolled SVG daily chart + BarList, all on CSS variables | `apps/web/src/pages/ThomAnalytics.tsx:81-171,186-271` | Feedback view composes from the same primitives |
| Chats viewer renders each message with `m.id` available, and already renders `tool_calls` / citation doc_types as tag chips | `apps/web/src/pages/ThomChats.tsx:152-185`, `thomAdmin.ts:97-103` | rating chips join cleanly by `message_id`; the same chip idiom serves F13's source context in Analytics |
| RLS posture precedent: transcripts are own-or-admin select, service-role-only write (no insert policy at all) | `0057:34-48`, `0044:88-102` | `thom_feedback` mirrors it exactly; anon gets nothing |
| Anon-boundary suite lives at `apps/api/src/thom/anonBoundary.test.ts` (NOT under `packages/shared`) | `apps/api/src/thom/anonBoundary.test.ts` | v1 cited a wrong path (F9); the DENY case extends this file |
| Public copy rules | memory `wac-group-copy-style`; `WARNING_COPY` is sign-off-locked (`widget/src/app.ts:28-32`) | feedback microcopy: no em dashes, "WAC Group" never bare "WAC"; new disclosure line needs Davis sign-off (checklist). Copy lints confirmed sound |

**The public-persistence question, answered.** The "no persisted history" promise (memory `thom-public-surface`) is visitor-facing: no login, no server-side history the widget reads back, transcript lives in localStorage. Admin-side turn logging was separately agreed and shipped (0057; Chats/Analytics live 2026-07-21). Feedback therefore does **not** need to — and does not — store whole conversations: a feedback row stores ONLY the rated Q/A pair (preferentially snapshotted from the *matched DB rows*, F3), the rating, the optional reason, and the same anonymous `public_session_key` the log bridge already uses. If the log bridge is dark (THOM_LOG secrets unset), public feedback is dark too (G). Disclosure microcopy at the point of submission makes the sharing explicit (C.2).

---

## A. Schema — migration 0062

`supabase/migrations/0062_thom_feedback.sql` (this plan owns 0062; the attribute-filter plan moves to 0063 — see header):

```sql
create table public.thom_feedback (
  id uuid primary key default gen_random_uuid(),
  -- 'internal' | 'public' — which surface the rating came from.
  surface text not null check (surface in ('internal', 'public')),
  -- ONE total unique dedup key (F1/F2). PostgREST's bare ON CONFLICT cannot
  -- target partial unique indexes (see 0046 — that exact mistake broke every
  -- docs-ingest upsert), so instead of two partial indexes we derive:
  --   internal rows: 'msg:' || message_id
  --   public rows:   'pub:' || public_session_key || ':' || client_turn_id
  -- ALL writers upsert with onConflict: "dedup_key". Stable even if
  -- message_id is later nulled by ON DELETE SET NULL.
  dedup_key text not null unique,
  -- Linkage, all nullable: internal rows carry message_id (+conversation_id,
  -- user_id); public rows carry public_session_key + client_turn_id (+site_key),
  -- and conversation_id/message_id only when the bridge could match them.
  conversation_id uuid references public.thom_conversations(id) on delete set null,
  -- Plain nullable pointer with NO uniqueness (F1/F2): a plain (non-unique)
  -- index only. Public rows may ALSO set it on bridge match — under the v1
  -- partial-unique design that would have collided; here it cannot.
  message_id uuid references public.thom_messages(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  public_session_key text,
  client_turn_id text,
  site_key text,
  -- +1 = thumbs up, -1 = thumbs down.
  rating smallint not null check (rating in (1, -1)),
  -- Optional thumbs-down free text. Hard-capped (also enforced in zod), and
  -- structurally impossible on a thumbs-up (F14):
  reason text check (char_length(reason) <= 1000),
  check (rating = -1 or reason is null),
  -- Snapshot of the rated pair. Never null: ratings must survive message
  -- deletion (internal users can delete conversations, thom.ts:337-353
  -- cascades messages) and a dark log bridge. Server/DB-sourced text may use
  -- the full cap; UNMATCHED public rows store client-supplied text capped at
  -- 16k by the bridge zod (F3/F12).
  question_text text not null check (char_length(question_text) <= 8000),
  answer_text text not null check (char_length(answer_text) <= 64000),
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- **One vote per answer (both surfaces), change-of-mind allowed via upsert:** the single `unique` on `dedup_key` is the only conflict arbiter (F1/F2). A hostile client can mint fresh `client_turn_id`s; volume abuse is handled by the KV rate cap (B.2), not uniqueness.
- Query indexes: `(created_at desc)`, `(surface, created_at desc)`, plain `(message_id) where message_id is not null` (index may be partial — it is never a conflict target), `(conversation_id) where conversation_id is not null`.
- **Matched vs unverified (F3):** no extra column — a **public** row with `message_id is null` is *unmatched*: its snapshots are visitor-supplied probe text, rendered as "unverified, visitor-supplied text" in analytics and **excluded from the positive-rate tile**. Matched public rows and all internal rows are verified (snapshots came from DB rows).
- `updated_at` touch trigger, same pattern as `thom_conversations_touch` (0044:40-51).
- **RLS:** enable; select policy `using ((select public.is_admin()))` (InitPlan form per 0055); **no insert/update/delete policies** — writes are service-role only, exactly the transcript posture (0044:88-102). No anon path of any kind: the public worker never touches this table directly (B.2). Extend **`apps/api/src/thom/anonBoundary.test.ts`** (F9 — corrected path) with a DENY case.
- **RPC** `thom_feedback_daily(days int default 30, scope_filter text default null)` returns `(day date, up bigint, down bigint, unverified bigint)` — SECURITY INVOKER, `generate_series` day spine like `thom_chat_daily` (0057:67-100), filtered by `surface` when `scope_filter` is not null. `up`/`down` count **verified rows only**; `unverified` counts unmatched public rows (either rating) so the tile denominator is honest (F3). Best-effort dedupe of session re-mint duplicates: count one row per `(client_turn_id)` within the day for public rows (F7 — see D). `grant execute … to authenticated;` (RLS makes it empty for non-admins; the API route is admin-gated anyway, mirroring 0057's note). The list view needs no RPC — plain PostgREST select under the admin's own JWT (B.3).
- Migration header carries a short VERIFY checklist: anon select/insert both DENY; authenticated non-admin select returns 0 rows; **upsert with `onConflict: "dedup_key"` succeeds via PostgREST** (the 0046 failure mode, exercised, not assumed); `reason` on a `rating = 1` row rejected by the F14 check.

## B. API routes

### B.1 Internal — message ids to the client, then a feedback endpoint

1. **Return ids from `logTurn`** (`apps/api/src/routes/thom.ts:159-184`): add `.select("id, role")` to the insert; return `{ assistantMessageId }`. Stream route (`:229-233`) already awaits `logTurn` before the terminal frame (done-frame timing confirmed sound by the counter-plan) — emit `done` as `{ usage, messageId }`. Non-streaming `/chat` (`:200-202`) adds `messageId` to its JSON. Client: `apps/web/src/lib/thom.ts` `onDone` gains the optional `messageId` (dispatch at `:186`-region); older servers/frames without it degrade gracefully.
   - **Also in PR 1 (F5): close the pre-existing `prepareTurn` ownership hole.** `thom.ts:121-133` loads history for any client-supplied `conversationId` via the service client with no `user_id` check. Add the same owner-scoped lookup the GET uses (`thom.ts:317-324`): load the conversation, `404` unless `conversation.user_id === caller.id`, *before* reading messages. This is a fix on its own merits and a precondition for trusting `conversationId`-adjacent flows.
2. **Ids on reload:** `thom.ts:326-331` selects `id` too; `mapMessagesToTurns` (`:51-67`) attaches each assistant row's `id` as `messageId` on the turn (interface `StoredTurn` gains `messageId?: string`). Also return existing feedback for the conversation (`select message_id, rating` from `thom_feedback`). **Access-path rule (F6, pinned):** this feedback read goes through the **service client, strictly AFTER the route's owner check has passed** — no second RLS select policy is added for end users (admin-only select stands, per A). A test asserts the ordering (owner-check failure ⇒ no feedback query issued). **Best-effort (F11):** the feedback join is wrapped so any error (e.g. 0062 not yet applied) is swallowed and an empty map returned — PR 1 must never 500 a conversation reload because the migration lags the deploy.
3. **`POST /api/thom/feedback`** (new handler in `thom.ts`, gated `requireAuth + requireFeature("thom") + requireInternal` like every sibling): body `{ messageId, rating: 1 | -1, reason? }` (zod). Server-side:
   - Load the message via the service client; join its conversation; **verify `conversation.user_id === caller.id`** (404 otherwise — same owner-scoping as `GET /conversations/:id`). Reject non-assistant rows.
   - **Snapshot server-side, never trusting client text:** `answer_text` = the message's `content`; `question_text` = the nearest prior `role='user'` row in the same conversation — `created_at <=` the assistant row's, order desc, limit 1, excluding the assistant row itself. **The `<=` is deliberate and gets a code comment (F10):** `logTurn` inserts both rows in one transaction, so the user row's timestamp can *equal* the assistant row's; a strict `<` would miss it. An equal-timestamp test pins this (E).
   - Upsert with **`dedup_key = 'msg:' + messageId`**, `onConflict: "dedup_key"`, setting `surface='internal'`, `message_id`, `conversation_id`, `user_id`, `rating`, `reason` (reason kept only when rating = -1; a flip to thumbs-up nulls it — also DB-enforced by the F14 check).
   - Returns `{ ok: true }`. A `DELETE`/"unvote" is deliberately out of v1 (Deferred).

### B.2 Public — worker endpoint → log-bridge subroute

The public worker holds only the anon key (env-boundary test, `apps/thom-bot/src/env.ts`) and `thom_feedback` has no anon insert policy, so the insert must ride the existing shared-secret bridge, exactly like turn logging (bridge reuse confirmed sound):

1. **`POST /api/feedback` on the public worker** (`apps/thom-bot/src/index.ts`): body `{ session?, turnId, rating, reason?, question, answer }` (session token also accepted via the same headers as `/api/chat/stream`, `:107-113`). Guards, in order, all reusing existing machinery:
   - **Dark-launch gate first (F8): if `THOM_FEEDBACK` is not `"1"`, the route returns 404** — the server-side gate, not just client-side hiding. Hiding thumbs via `/api/config` is UX; the 404 is the actual control.
   - Origin allowlist (`originAllowed`) → 403.
   - `verifySession` (Turnstile-scoped, IP-bound) → 401. Feedback is therefore exactly as bot-gated as chat.
   - KV rate cap via `checkAndIncrRate` (`limits.ts:68-95`) under a **feedback-specific key namespace** (add an optional `keyPrefix`/`kind` to the helper, or a thin wrapper) with its own small caps, env-overridable: default **10/min, 40/day per IP** (`THOM_FEEDBACK_PER_MIN`/`_PER_DAY`) → 429. Chat counters untouched (namespacing confirmed sound).
   - Input caps in the worker before forwarding: `reason` ≤ 1,000, `question` ≤ 8,000, `answer` ≤ **16,000** (aligned with the bridge zod, F3/F12), `turnId` ≤ 64 chars. These are hygiene only — the bridge re-enforces everything (F12).
   - Compute `session_key` = SHA-256 of the session token, the identical derivation `sendTurnLog` uses (`index.ts:171-175`) — factor that hash into a small shared helper rather than duplicating.
   - Forward to `${THOM_LOG_URL (trailing-slash-trimmed)}/feedback` with the `x-thom-log-token` header. Unlike turn logging this is **not** fire-and-forget: await it and return its ok/failure to the widget so the UI can confirm. If `THOM_LOG_URL`/`THOM_LOG_TOKEN` are unset → 503 "feedback not available" (and the widget will not have shown thumbs, see G).
2. **`POST /feedback` subroute on `thomPublicLogRoutes`** (`apps/api/src/routes/thomPublicLog.ts`, mounts as `/api/thom/public-log/feedback` per `apps/api/src/index.ts:104`): shared-secret check identical to the turn route (`:34-38`); then **zod `FeedbackInput` with explicit bounds (F12 — the shared secret must not rely on worker pre-caps):** `session_key` string 16–128 chars, `site_key?`, `client_turn_id` ≤ 64, `rating` literal `1 | -1`, `reason?` ≤ 1,000, `question` ≤ 8,000, `answer` ≤ 16,000, `model?`. Then:
   - **Best-effort linkage:** find the session's conversation exactly as the turn route does (`public_session_key` + 24h window, `:44-53`) → `conversation_id`; within it, match `message_id` as the most recent assistant row whose `content` equals `answer` (exact match).
   - **Snapshot source depends on the match (F3):** on a hit, `question_text`/`answer_text` are copied **from the matched DB rows** (the assistant row's content + its nearest-prior user row, same `<=` rule as B.1.3) — the client-sent text served only as the probe. On a miss (feedback can land before the `waitUntil` turn log does), store the client text as the snapshot with `message_id` null — that null IS the unverified flag (A) — capped at 16k.
   - Upsert with **`dedup_key = 'pub:' + session_key + ':' + client_turn_id`**, `onConflict: "dedup_key"`, with `surface='public'`, `rating`, `reason` (thumbs-down only), snapshots, `site_key`, and `conversation_id`/`message_id` when matched.
3. **Widget-side identity:** `Turn` (`widget/src/types.ts`) gains `turnId?: string` (minted with the same `randomId()` used by `getSessionId`, `session.ts:108-112`, when the assistant turn is pushed in `send()`, `app.ts:304`) and `feedback?: 1 | -1`. Both persist through `saveHistory`, so votes survive widget reopen within the session. `boundTurns`/`toRequestHistory` are unaffected (`toRequestHistory` already strips to role/content).

### B.3 Admin reads (`apps/api/src/routes/thomAdmin.ts`)

- `GET /api/thom-admin/feedback?days&surface&rating&limit&offset` — PostgREST select on `thom_feedback` under the admin's own JWT (`userSupabase`, RLS suffices — same stance as the conversations list, `thomAdmin.ts:36-49`), `order created_at desc`, `count: "exact"`, filters mapping straight to columns. Returns rows with `question_text`, `answer_text`, `reason`, `rating`, `surface`, `site_key`, `conversation_id`, `message_id`, `created_at`, plus `user_email` resolved via the existing service-client email join (`:54-59`).
- **Source context for matched rows (F13):** for returned rows with a `message_id`, a second service-client select on `thom_messages` (0044) fetches `tool_calls` and citation `doc_types` for those ids (single `in()` query, best-effort like F11); the route attaches them so the UI can render ThomChats-style tag chips + an "Open in Chats" link. A per-feedback source-detail RPC was considered and **explicitly rejected as overreach** for v1 (Deferred).
- `GET /analytics` (`:111-134`) adds `thom_feedback_daily` to the existing `Promise.all` fan-out and returns `feedbackDaily` + computed totals (`up`, `down`, `unverified`, positive rate over verified rows only — F3) in the bundle.
- `GET /conversations/:id` (`:87-104`) additionally selects this conversation's `thom_feedback` rows so the Chats thread view can chip rated messages (join client-side by `message_id`, fallback display at conversation level for unmatched public rows). **Best-effort (F11):** errors from this join are swallowed and an empty map returned — the thread view must keep working if 0062 has not been applied yet.

## C. UI

### C.1 Internal chat (`apps/web/src/pages/ThomChat.tsx`)

- `Turn` gains `messageId?: string` and `feedback?: 1 | -1`; both persist through the existing localStorage transcript (`STORAGE_KEY` v1 shape is forward-compatible — old entries simply lack the fields; **do not** bump the key). `onDone` stores the `messageId` on the just-finished assistant turn; `loadConversation` gets ids + prior votes from B.1.2.
- `TurnView` (`:346-419`): completed assistant turns that have a `messageId` and no `error` render a `thom-feedback` row after citations — lucide `ThumbsUp`/`ThumbsDown` icon buttons (library already imported at `:2-14`). Never rendered while `streaming`.
- Thumbs-up: POST immediately, mark selected. Thumbs-down: mark selected and open a small inline reason box (`thom-feedback-reason`): textarea (maxLength 1000), "Send" + "Skip" — both submit the -1 vote (Skip with empty reason); the box also closes on outer click. Re-clicking the other thumb re-submits (upsert). Voted state = filled/accented icon.
- Styling: class-based in `apps/web/src/styles.css` next to the existing `.thom-*` block (`:1770+`), tokens only (`--muted`, `--accent`, `--panel`, `--border`, `--radius`) — no hardcoded colors per CLAUDE.md.

### C.2 Public widget (`apps/thom-bot/widget/src/app.ts` + `style.css`)

- `turnView` (`app.ts:235-250`) appends the same thumbs row to completed, non-error assistant turns **when `feedbackEnabled`** (from `/api/config`, see G) and the turn has a `turnId`. Pure-DOM buttons via the existing `el()`/`svgEl()` builders; thumbs drawn as inline lucide-path SVGs like `robotIcon` (`:198-220`).
- **Disclosure line (F4): renders STATICALLY whenever the thumbs row renders** — a small `thom-muted` line accompanying the thumbs, visible before *either* vote is cast. Tooltip-only disclosure was rejected: mobile has no hover/tooltips, and both vote directions store the pair, so the reader must see it before tapping either thumb. Draft copy:

  > "Sending feedback shares this question and Thom's answer with WAC Group so we can improve Thom."

  Copy-linted (no em dashes, "WAC Group"); **both the exact wording AND the placement are Davis sign-off items** like `WARNING_COPY` (checklist).
- Thumbs-down additionally opens the inline reason box under the bubble (textarea, Send/Skip), same behavior as C.1.
- Submit path: `POST /api/feedback` same-origin with the session token; on 401, reuse the existing re-challenge flow (`ensureSession` → retry once, mirroring `runStream`'s `allowRechallenge` at `:338-361`); on failure show a quiet inline "Couldn't send feedback" note — never an error bubble. On success set `turn.feedback`, `persist()`.
- The `question` sent is the nearest preceding user turn's text; `answer` is the turn's own text — but both are **probes**: when the bridge matches the logged rows, the stored snapshot comes from the DB (F3). Cards/citations are NOT included in the snapshot — the linked `thom_messages` row has them when matched (and F13 surfaces them); noted as a Deferred enhancement for unmatched rows.
- Styles in `widget/src/style.css` following its existing `thom-btn`/`thom-muted` class conventions.

### C.3 Admin surfacing

- **`ThomAnalytics.tsx` — Feedback section** (new cards under the existing grid):
  - Two stat tiles join the top row: "Feedback received" and "Positive rate" (`up / (up + down)` over **verified rows only** — F3 — with the denominator shown, "of N rated"; en-dash-free "–" placeholder when zero).
  - A compact per-day up/down chart from `feedbackDaily`, reusing the `DailyChart` pattern (`:186-271`) generalized or duplicated small (two series: up = `--chart-1`, down = `--chart-2`); respects the existing `days`/`surface` selects (`:61-72`) — `scope_filter` flows through like the other RPCs.
  - **Feedback list**: rating filter (All / Thumbs up / Thumbs down), rows = when · surface tag · rating icon · question (truncated, ellipsized) · reason (when present). Unmatched public rows carry a muted **"unverified, visitor-supplied text"** badge (F3). Row click expands full question + answer (answer in a scrollable, `white-space: pre-wrap` block); matched rows additionally show their `tool_calls` + citation doc_type **tag chips (ThomChats style)** and an **"Open in Chats"** link when `conversation_id` is present (F13). Paged like ThomChats (`:129-141`).
  - **Plain-text rule (F15, explicit):** feedback snapshots and reasons are rendered **only** as plain React children inside `pre-wrap` blocks — **never through ReactMarkdown** (or any HTML/markdown renderer). Visitor-typed and probe text must not gain formatting, links, or table rendering anywhere in the admin UI. This is a review checklist item on the PR.
  - **PII note in the UI**, muted, above the list: public reasons are visitor-typed free text and may contain contact info typed by the visitor; treat as customer data. (The repo is public — never paste feedback rows into PRs/commits; memory `repo-is-public`.)
- **`ThomChats.tsx` thread view**: rated assistant messages get a small chip (thumb icon + reason on title/expand — reason text plain-only per F15) next to the model line (`:154-157`), joined by `message_id` from B.3; conversation-level unmatched public feedback renders as a chip in the thread header.

## D. Analytics semantics notes

- Feedback counts are **per rated answer**, not per turn — coverage will be sparse; the positive-rate tile must show its denominator ("of N rated") to avoid reading 3-vote days as trends.
- **Session re-mint duplication (F7 — accepted limitation, documented):** a visitor whose session expires and re-mints gets a new session token → new `public_session_key` → a *different* `dedup_key` for the same on-screen turn (the widget keeps its `turnId` in localStorage). A re-vote after re-mint therefore creates a second row rather than upserting. This is accepted for v1: the KV rate cap bounds volume, and the analytics daily RPC dedupes **best-effort** by counting one public row per `client_turn_id` per day (a "session-key family" is not reliably reconstructible, so this is heuristic, not a guarantee). No schema complexity is spent on it.
- Unverified (unmatched public) rows appear in the list with their badge but never in the positive-rate numerator/denominator (F3).
- `thom_feedback` is never pruned, matching the transcript retention note (0058:17-19).
- No change to `analyticsSources.ts` — feedback is not a source bucket. (Verified: nothing new flows into `thom_source_usage`.)

## E. Tests

- **Shared/pure:** widget turn-id minting + persistence round-trip (`session.test.ts` style); reason length caps; `mapMessagesToTurns` id passthrough (`thom.test.ts` already covers the mapper); `dedup_key` derivation helpers (both prefixes).
- **API (internal):** feedback route — owner-scoping 404, non-assistant reject, upsert flip up→down→up via `dedup_key`, reason nulled on flip-to-up, snapshot correctness (question = nearest prior user row), **equal-timestamp case: user and assistant rows sharing one `created_at` still resolve the question (the `<=`, F10)**. `prepareTurn` ownership: foreign `conversationId` → 404, own → history loads (F5). Reload path: feedback read only happens after the owner check passes (F6), and a failing feedback join still returns the conversation (F11).
- **API (bridge):** shared-secret 403; **zod bounds each individually enforced (session_key 16–128, client_turn_id ≤64, rating literal, reason ≤1k, question ≤8k, answer ≤16k — F12)**; conversation/message match hit stores **DB-row snapshots, not the client probe** (F3); miss stores client text with `message_id` null; upsert on `dedup_key`.
- **Worker (public):** **`THOM_FEEDBACK` unset → 404 (F8)**; origin 403; missing/expired session 401; feedback rate-cap 429 with isolated KV keys (chat counters untouched); 503 when log URL/token unset; payload caps enforced pre-forward (`limits.test.ts` / `index`-level tests exist as patterns).
- **Anon boundary:** `thom_feedback` select + insert DENY as anon — extends **`apps/api/src/thom/anonBoundary.test.ts`** (F9).
- **UI-adjacent pure logic:** vote-state reducer (which turns show thumbs: completed + id'd + non-error only); analytics row shaping (unverified badge iff public + null `message_id`).
- **Copy lints:** disclosure microcopy passes the public copy checks (no em dashes, no bare "WAC") — same lints the widget warning has (`warning.test.ts`).

## G. Rollout (gated, in order)

1. **Migration 0062.** Additive, no behavior change. Verify checklist in the header (A): anon DENY probes, PostgREST `onConflict:"dedup_key"` round-trip, F14 check. (Coordinate with the attribute-filter plan: it renumbers to 0063.)
2. **PR 1 — internal path** (B.1 incl. the F5 ownership fix + C.1 + B.3 + C.3): ships fully live for internal users on merge (`pnpm deploy:web` via CI). The `done`-frame change is backward-compatible (extra field). Admin pages render zeros until votes arrive; the F11 best-effort joins mean the deploy is safe even if 0062 lags.
3. **PR 2 — public path** (B.2 + C.2), **dark by default**: the worker's `/api/feedback` route 404s and `/api/config` omits `feedbackEnabled: true` until `THOM_FEEDBACK="1"` **plus** configured `THOM_LOG_URL`/`THOM_LOG_TOKEN` (F8: the route gate is server-side; config-driven hiding is UX only). Enabling = a committed `vars` edit in `apps/thom-bot/wrangler.jsonc` (CI clobbers dashboard vars on every push — the two-commit lesson from the lighting plan A11; `wrangler.jsonc:48-61` is the block; idiom confirmed sound). `ThomEnv`/`PublicEnv` gain the optional var; env-boundary test updated.
4. Enable: internal soak ~a few days → flip `THOM_FEEDBACK` on the public worker → cast one up + one down vote through a real embed → confirm rows, linkage (`conversation_id`/`message_id` populated and snapshots DB-sourced when the turn log ran; unverified badge when not), Analytics tiles, Chats chips.

## H. Deferred

- Un-vote (delete) and reason editing after submit.
- Snapshotting cards/citations into the feedback row for **unmatched** rows (matched rows get them via the F13 join).
- **Per-feedback source-detail RPC** (rejected as v1 overreach in F13; the batched `thom_messages` join covers it).
- Session-key-family reconstruction to fully dedupe re-mint votes (F7 — accepted limitation; best-effort dedupe in the daily RPC only).
- Thumbs-down notification (email/Slack ping to Davis) and a weekly digest.
- Feedback-driven regression set (export thumbs-down Q/A pairs as eval fixtures for the lighting-expert regression conversation).
- Rating internal turns from conversations logged before this ships (no stable key without content-matching; low value).
- Public reason-text PII scrubbing/redaction pass (v1 = cap + admin-only visibility + UI note + plain-text-only rendering per F15).
- Per-message feedback in the non-streaming internal `/chat` client path beyond returning the id (nothing consumes `/chat` today besides tests).

## Davis checklist

- [ ] **Ratify this v2** (reconciled from the counter-plan; ledger below).
- [ ] Sign off the public disclosure microcopy **wording AND placement** (C.2 — static line with the thumbs row, F4) — same bar as `WARNING_COPY`.
- [ ] Apply migration 0062 (Supabase dashboard/CLI) before PR 1 merges — and note the attribute-filter plan now takes 0063.
- [ ] Confirm feedback rate-cap defaults (10/min, 40/day per IP) or override via vars.
- [ ] After PR 2: commit the `THOM_FEEDBACK="1"` var flip on `apps/thom-bot/wrangler.jsonc` when ready to go live publicly (dashboard toggles get clobbered by CI).
- [ ] Reminder: `thom_feedback` rows can contain visitor-typed text — repo is public, never quote rows in PR bodies/commits.

## Adjudication ledger (counter-plan → resolution)

| Obj | Sev | Resolution |
|---|---|---|
| F1 internal partial unique index breaks PostgREST upsert (0046 lesson) | BLOCKER | single total `dedup_key text not null unique`; internal rows `'msg:'\|\|message_id`; all writers `onConflict:"dedup_key"` (A) |
| F2 public two-column partial index — same 0046 failure + collides once public rows set message_id | BLOCKER | same `dedup_key` (`'pub:'\|\|session_key\|\|':'\|\|client_turn_id`); `message_id` demoted to plain indexed nullable, NO uniqueness, settable on bridge match (A/B.2) |
| F3 public snapshots trust visitor text | MAJOR | on bridge match, snapshot from the matched DB rows (client text = probe only); miss ⇒ store client text with `message_id` null = unverified flag, "unverified, visitor-supplied text" badge, excluded from positive rate; unmatched answer cap 16k (B.2/C.3/A) |
| F4 tooltip-only disclosure invisible on mobile | MINOR | disclosure renders statically whenever the thumbs row renders; wording + placement both on the Davis sign-off checklist (C.2) |
| F5 pre-existing `prepareTurn` ownership hole (thom.ts:121-133) | MAJOR | PR 1 adds the GET's ownership 404 before any history load (B.1.1/E) |
| F6 reload feedback read's RLS path unstated | MINOR | pinned: service client strictly AFTER the route owner check, documented in B.1.2 + ordering test; no second RLS policy (B.1.2/E) |
| F7 session re-mint duplicates votes | MINOR | accepted limitation, documented (D); daily RPC dedupes repeated `client_turn_id` best-effort; full family reconstruction deferred (A/D/H) |
| F8 public dark-launch was client-side only | MAJOR | worker `/api/feedback` itself gates on `THOM_FEEDBACK` server-side, 404 when dark; config flag stays as UX (B.2/G/E) |
| F9 wrong anon-boundary test path | MINOR | corrected to `apps/api/src/thom/anonBoundary.test.ts` (A/E) |
| F10 `<=` in question-snapshot query looked like a bug | MINOR | kept deliberately (logTurn inserts both rows in one transaction ⇒ equal timestamps) + code comment + equal-timestamp test (B.1.3/E) |
| F11 conversations GET could 500 if 0062 lags the deploy | MAJOR | feedback joins are best-effort: errors swallowed, empty map returned; reload/thread views never fail on a missing table (B.1.2/B.3/E) |
| F12 bridge zod bounds unspecified (relied on worker pre-caps) | MAJOR | explicit `FeedbackInput` bounds: session_key 16–128, client_turn_id ≤64, rating literal 1\|-1, reason ≤1000, question ≤8000, answer ≤16000; worker caps demoted to hygiene (B.2/E) |
| F13 feedback rows lack answer context (tools/sources) | MINOR | analytics list joins matched rows' `tool_calls` + citation doc_types from `thom_messages` (0044) as ThomChats-style chips + "Open in Chats"; per-feedback source RPC rejected as overreach → Deferred (B.3/C.3/H) |
| F14 reason storable on thumbs-up | MINOR | `check (rating = -1 or reason is null)` in 0062; route still nulls on flip (A/B.1.3) |
| F15 visitor text through markdown renderer | MAJOR | explicit rule: snapshots/reasons render as plain text only (React children / pre-wrap), never through ReactMarkdown; PR review checklist item (C.3) |

Confirmed sound by the counter-plan (unchanged from v1): log-bridge reuse for the anon→service-role write path, `done`-frame timing (logTurn awaited before the terminal frame), the committed-vars two-commit dark-launch idiom, the disclosure copy lints, and feedback-specific KV rate-cap namespacing.

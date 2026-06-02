# WAC Marketing App

Internal marketing tool for the WAC Group team. See [WAC-Marketing-App-PRD.md](./WAC-Marketing-App-PRD.md) for the full product spec.

Phase 1 (in progress): **UTM & QR Code Generator** — governed UTM builder, editable short links on `gowac.cc`, single + bulk + social-fan-out QR generation, shared asset library.

## Repo layout

This is a pnpm workspace monorepo.

```
.
├── apps/
│   ├── web/        React (Vite) SPA — served by the API Worker via Static Assets
│   ├── api/        Cloudflare Worker for /api/* (also hosts the SPA assets)
│   └── redirect/   Cloudflare Worker bound to gowac.cc — short-link resolver
├── packages/
│   └── shared/     Pure TS: UTM assembly + validation, shared types/zod schemas
├── supabase/
│   └── migrations/ SQL schema + RLS policies + seed data
└── WAC-Marketing-App-PRD.md
```

## Stack

| Layer | Choice |
|-------|--------|
| Frontend | React 18 + Vite, served by Workers Static Assets |
| Auth | Supabase Auth (Google OAuth + magic link) |
| DB | Supabase Postgres with RLS |
| API | Hono on Cloudflare Workers |
| File storage | Cloudflare R2 |
| Short-link cache | Cloudflare KV |
| Short-link host | `gowac.cc` (separate Worker) |

## Local setup

Prereqs: Node 20+, pnpm 9+, a Cloudflare account, the Supabase project URL + keys.

```bash
pnpm install

# Frontend (Vite dev server at http://localhost:5173)
pnpm dev

# API Worker locally (wrangler dev at http://localhost:8787)
pnpm dev:api

# Redirect Worker locally
pnpm dev:redirect

# Run the unit tests (UTM assembly + validation)
pnpm test
```

### Environment variables

Frontend (`apps/web/.env.local`):

```
VITE_SUPABASE_URL=https://stmphhslrjhtzmvqilqu.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_API_BASE_URL=http://localhost:8787
VITE_SHORT_LINK_HOST=https://gowac.cc
```

API Worker secrets (`apps/api/.dev.vars` for local; `wrangler secret put` for prod):

```
SUPABASE_URL=https://stmphhslrjhtzmvqilqu.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SHORT_LINK_HOST=https://gowac.cc
HUBSPOT_TOKEN=                 # leave blank until live HubSpot is wired
```

Redirect Worker secrets (`apps/redirect/.dev.vars`):

```
SUPABASE_URL=https://stmphhslrjhtzmvqilqu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Anyone reading: only the `VITE_SUPABASE_ANON_KEY` is safe to bundle. The service-role key is server-only.

## Cloudflare resources

These are provisioned via `wrangler` (one-time):

```bash
# Auth the CLI
npx wrangler login

# KV namespace for the slug -> destination cache
npx wrangler kv namespace create SHORT_LINKS

# R2 bucket for generated QR/asset files
npx wrangler r2 bucket create wac-marketing-assets
```

Put the returned IDs into the `wrangler.jsonc` files in `apps/api/` and `apps/redirect/`.

## Database

Supabase migrations live in [`supabase/migrations/`](./supabase/migrations). Apply them via the Supabase dashboard SQL editor or the Supabase CLI.

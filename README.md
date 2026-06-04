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
BFL_API_KEY=                   # Phase 2d: Black Forest Labs FLUX.1 Fill (hybrid mode)
GEMINI_API_KEY=                # Phase 2: Google Gemini (harmonize/concept + scene generation)
FAL_API_KEY=                   # Phase 2: fal.ai BiRefNet background removal (cutout matting)
```

These AI keys are forwarded into the generation Container. Without `BFL_API_KEY`/
`GEMINI_API_KEY` the Application Image generator still runs in deterministic
`composite` mode, while `hybrid`/`concept` jobs and text-to-room scene generation
fail with a clear "not configured" error. Without `FAL_API_KEY`, opaque product
images are rejected (only pre-cut transparent PNGs composite). In prod, set them
with `wrangler secret put BFL_API_KEY` / `... GEMINI_API_KEY` / `... FAL_API_KEY`.
Optional: `GEMINI_SCENE_MODEL` pins the scene-generation model (defaults to a
Gemini 3 image model so 4K is available), and `SALES_LAYER_BRAND_FIELD` pins the
product brand field if auto-discovery is wrong.

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

## Deploy

The React SPA is served by the `wac-marketing-api` Worker via Cloudflare Static
Assets, so deploying = building `apps/web` then `wrangler deploy` in `apps/api`.

```bash
# Worker + static assets only (skips the generation Container — fast, this is
# what you want for normal web/API changes)
pnpm deploy:web

# Full deploy, including a rebuild + rollout of the generation Container
# (needs Docker running locally and a token with container registry perms)
pnpm deploy
```

### Continuous deployment

Pushes to `main` that touch `apps/web`, `apps/api`, `apps/generator`,
`packages/shared`, or the lockfile trigger
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml), which builds
the SPA and runs `wrangler deploy --containers-rollout none` (Worker + assets,
no Container rebuild). To also rebuild and roll out the Container, run the
workflow manually from the Actions tab with `include_container = true`.

Required repo secret:

| Secret | Notes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token with Workers Scripts, Workers KV, R2, Queues, and (for full deploys) Containers/Cloudchamber write. `account_id` is already set in `wrangler.jsonc`. |

## Database

Supabase migrations live in [`supabase/migrations/`](./supabase/migrations). Apply them via the Supabase dashboard SQL editor or the Supabase CLI.

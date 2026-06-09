# CLAUDE.md

Internal marketing tool for the WAC Group team. pnpm workspace monorepo on Cloudflare + Supabase. See `README.md` for full setup/deploy and `WAC-Marketing-App-PRD.md` for the product spec.

## Layout

- `apps/web` — React 18 + Vite SPA (served by the API Worker via Static Assets). Pages in `src/pages`.
- `apps/api` — Hono on Cloudflare Workers, `/api/*`. Routes in `src/routes`. Also hosts the SPA assets and binds the generation Container.
- `apps/redirect` — Worker bound to `gowac.cc`, resolves short links (KV-cached).
- `apps/generator` — Node/Sharp image-generation server, runs in the Cloudflare Container. AI pipeline in `src/ai`.
- `apps/render-worker` — Node/Sharp render server for long 3D/Blender renders.
- `apps/fixture-sync` — CLI that syncs fixtures from Sales Layer → Supabase/R2.
- `packages/shared` — pure TS shared by everything: UTM assembly+validation, types, zod schemas. No runtime deps.
- `supabase/migrations` — SQL schema, RLS policies, seed.

## Stack

React 18/Vite · Hono/Workers · Supabase (Postgres + RLS, Google OAuth + magic link) · R2 (files) · KV (short-link cache). AI: BFL FLUX.1 Fill + Google Gemini.

## Commands

```bash
pnpm dev          # web SPA (localhost:5173)
pnpm dev:api      # API Worker (localhost:8787)
pnpm dev:redirect # redirect Worker
pnpm test         # all unit tests (vitest)
pnpm typecheck    # all packages
pnpm deploy:web   # Worker + SPA assets only (normal web/API changes)
pnpm deploy:all   # full deploy incl. Container rebuild (needs Docker + container token)
```

> Use `pnpm deploy:all`, NOT `pnpm deploy` — `deploy` is a pnpm built-in that
> silently no-ops (it does not run the project script).

## UI conventions

- Design tokens live in `apps/web/src/styles.css` (`:root` + `[data-theme="dark"]`). Use the CSS variables (`--bg`, `--panel`, `--accent`, `--radius`, `--shadow-*`) — never hardcode colors, radii, or shadows.
- Theme (light/dark) is provided by `lib/theme.tsx`.
- Shared UI in `src/components`; one CSS file, class-based — no CSS-in-JS or Tailwind.

## Conventions & gotchas

- Pure logic with tests goes in `packages/shared` (UTM, slug, bulk, social, fixture, appimage). Co-locate `*.test.ts`.
- The SPA is served *by* the API Worker, so a web change still deploys through `apps/api`.
- Container rebuilds are slow and gated on the Workers Paid plan + `Cloudflare Containers: Edit` token. Default to `pnpm deploy:web`; rebuild the Container with `pnpm deploy:all` when `apps/generator` changes. CI (`deploy.yml`) ships Worker+assets on every push to `main` but NEVER the Container (`--containers-rollout none`) — so a generator change is live ONLY after `pnpm deploy:all` (or the manual workflow: `gh workflow run deploy.yml -f include_container=true`).
- After a Container deploy, the warm container pool keeps serving the OLD image until each instance idles out and cold-restarts (`sleepAfter` in `apps/api/src/container.ts`, default `10m`). So prod can run stale generator code for ~10 min of idle — or indefinitely under steady traffic that keeps the pool warm. A new image is NOT live just because `wrangler deploy` succeeded. To force it now: temporarily lower `sleepAfter` (e.g. `60s`), `pnpm deploy:web`, wait for the pool to cycle, run the generator work, then restore `sleepAfter` + redeploy. Verify by hitting a route only the new build has (a stale Container returns `{"error":"not found"}` from its catch-all).
- Secrets are server-only Worker secrets set via `wrangler secret put` — not in CI, not in `.dev.vars` (local dev only). Only `VITE_SUPABASE_ANON_KEY` is safe to bundle.
- Without `BFL_API_KEY`/`GEMINI_API_KEY` the image generator still runs in deterministic `composite` mode; `hybrid`/`concept`/scene jobs fail with a clear "not configured" error.
- DB changes = a new SQL migration in `supabase/migrations` (include RLS). Apply via Supabase dashboard or CLI.
- OneDrive-backed working dir can slow file watching — see `docs/onedrive-dev-performance.md`.

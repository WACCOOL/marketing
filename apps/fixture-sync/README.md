# @wac/fixture-sync

One-shot bulk uploader for the scalable fixture pipeline (Phase 1).

It recursively scans a LucidLink mount of studio `.blend` files, mirrors each one
to R2 (preserving the `year/brand/...` subfolder structure in the object key
under `fixtures/`), and upserts a SKU-keyed row into the Supabase `fixtures`
registry. The web app's resolver then presigns `model_key` so any mirrored
fixture renders on demand.

This is deliberately a one-shot CLI. The continuous LucidLink to R2 watcher
(which will run on a separate always-on host) is a later phase. Re-runs are
idempotent: a file whose byte size already matches the registry (or the R2
object) is skipped, so the ~1TB backfill can run over multiple sessions.

## Requirements

- Run it on a machine where the LucidLink filespace is mounted (e.g. this Mac at
  `/Volumes/graphix-working/team/3d_files/`).
- These env vars (same names the generator uses):
  - `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

## Usage

```bash
pnpm --filter @wac/fixture-sync build

# Preview what would upload (no R2/DB writes):
node apps/fixture-sync/dist/index.js --dry-run

# Real run over the default mount:
node apps/fixture-sync/dist/index.js

# Options:
#   --source <dir>       root to scan (default /Volumes/graphix-working/team/3d_files/)
#   --dry-run            scan + plan only, no uploads or registry writes
#   --sku <substr>       only process SKUs containing this substring
#   --concurrency <n>    parallel uploads (default 4)
```

## SKU / scene derivation

Each `.blend` becomes one registry row, identified by `fixture_key` (the
lowercased filename stem). Two naming conventions are handled:

- `{sku}.blend` -> `fixture_key` = `sku` = the stem
  (`bl234608-bv-bk.blend` -> `bl234608-bv-bk`).
- `{sku}_scn{NNN}.blend` -> the SAME fixture in several scene setups, e.g.
  `bl123607-bk_scn010/_scn020/_scn030`. Each keeps its own `fixture_key`, shares
  the base `sku` (`bl123607-bk`), and records `scene` (`010`...). The picker
  groups these under one fixture and offers the scenes as options.

`_v{NNN}` versions and a trailing `_pub` flag are also recognized. If the exact
same stem appears in two folders, the most recently modified wins.

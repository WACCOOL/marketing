# Developing this repo inside OneDrive (performance fix)

This project lives under `~/Library/CloudStorage/OneDrive-.../WAC Marketing App`.
OneDrive (the macOS **File Provider**) intercepts every file read/write in that
tree and tries to sync it. Node tooling creates *tens of thousands* of tiny
dependency files, so without the tweaks below, `pnpm install`, builds, typechecks,
and even `git status` can take minutes and intermittently hang.

This doc records the fix so it doesn't have to be rediscovered.

## Root cause

By default pnpm writes its **virtual store** to `node_modules/.pnpm` — the real,
extracted package files (everything in `node_modules/<pkg>` is just a symlink into
it). Inside OneDrive that means:

1. OneDrive tries to upload/hydrate thousands of dependency files.
2. pnpm normally **hardlinks** from its global content-addressed store to the
   virtual store for speed; hardlinks don't work across the OneDrive File
   Provider boundary, so pnpm silently falls back to **copying**.

Result: slow installs, slow file watching, slow git, occasional stalls.

## The fix (applied)

Relocate pnpm's heavy directories to plain **local disk**, leaving only small
symlinks inside the OneDrive tree. This is configured in a machine-local,
**git-ignored** `.npmrc` at the repo root:

```ini
virtual-store-dir=${HOME}/Library/pnpm/virtual-stores/wac-marketing-app
store-dir=${HOME}/Library/pnpm/store
```

- `virtual-store-dir` — moves `.pnpm` (the real files) out of OneDrive. After
  this, `node_modules/.pnpm` no longer exists in the project; `node_modules/<pkg>`
  entries are symlinks into the local path above.
- `store-dir` — pins the global store on the local volume so hardlinks work
  (it's the default `~/Library/pnpm/store`, pinned here to be explicit).

Both are on the same local APFS volume, so pnpm hardlinks instead of copying.

### Why `.npmrc` is git-ignored

The paths are per-machine and macOS-specific. Committing them would push odd
paths onto CI, Docker, and other developers. The generator Dockerfile only copies
specific manifests (not `.npmrc`), and CI checks out from git, so neither is
affected. Each developer creates their own `.npmrc` (copy the block above).

## Applying it on a fresh machine / after changes

```bash
# 1. Ensure the local .npmrc above exists at the repo root.
# 2. Remove any node_modules that were built with the in-OneDrive virtual store.
rm -rf node_modules apps/*/node_modules packages/*/node_modules
# 3. Reinstall — pnpm now builds the virtual store on local disk.
pnpm install
# 4. Verify the virtual store is NOT in the project anymore:
ls node_modules/.pnpm 2>/dev/null && echo "STILL in OneDrive (bad)" || echo "relocated (good)"
pnpm config get virtual-store-dir
```

## Optional, also helps

- **Editor**: exclude heavy dirs from file watching / search so Cursor/VS Code
  don't index them. In settings.json:
  ```jsonc
  "files.watcherExclude": { "**/node_modules/**": true, "**/dist/**": true, "**/.wrangler/**": true },
  "search.exclude":        { "**/node_modules": true, "**/dist": true, "**/.wrangler": true }
  ```
- **Keep large generated dirs local**: `dist/`, `.wrangler/`, `.turbo/`, and
  `coverage/` are already git-ignored; they still sync to OneDrive. If they cause
  churn, the same relocate-and-symlink trick can be applied, or pause OneDrive
  during long build/test loops.
- **`.git`**: a large `.git` in OneDrive can also be slow/risky. If git ops get
  painful, consider keeping the working copy outside OneDrive entirely for active
  development.

## Quick health check

```bash
# Heavy files should live OUTSIDE OneDrive:
du -sh "${HOME}/Library/pnpm/virtual-stores/wac-marketing-app" 2>/dev/null
# ...and the project should only have symlinks:
find node_modules -maxdepth 2 -type l | head
```

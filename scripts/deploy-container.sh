#!/usr/bin/env bash
#
# Deploy the generation Container AND force the warm pool onto the new image.
#
# Why this exists
# ---------------
# Deploying a new Container image (`pnpm deploy:all`) updates the image config,
# but the warm, Durable-Object-bound container pool keeps serving the OLD image
# until each instance idles out and cold-restarts (`sleepAfter` in
# apps/api/src/container.ts, default 10m). So a plain image deploy can leave
# production running stale generator code — indefinitely under steady traffic.
# (This is exactly how the Container drifted ~5 days out of date once.)
#
# What this does
# --------------
#   1. `pnpm deploy:all`            build + push + roll out the new image
#   2. drop sleepAfter -> short     redeploy the Worker so the pool sleeps fast
#   3. wait                         let the warm instances idle out + stop
#   4. restore sleepAfter           redeploy the Worker back to normal
# After step 3 the old containers have stopped, so the next generation request
# cold-starts on the NEW image.
#
# Caveats
# -------
# * Run it during a quiet window: generation traffic during step 3 keeps the
#   pool warm (resets the idle timer) and defeats the cycle.
# * Requires Docker running + wrangler authed with `Cloudflare Containers: Edit`
#   (same as `pnpm deploy:all`).
# * Tune the wait with CYCLE_WAIT_SECONDS (default 90) and the short value with
#   SHORT_SLEEP (default 30s) if needed.
#
# Usage: pnpm deploy:container      (or: bash scripts/deploy-container.sh)

set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER_TS="apps/api/src/container.ts"
SHORT_SLEEP="${SHORT_SLEEP:-30s}"
CYCLE_WAIT_SECONDS="${CYCLE_WAIT_SECONDS:-90}"

# Read the committed sleepAfter so we restore it EXACTLY (don't assume "10m").
ORIG_SLEEP="$(grep -oE 'override sleepAfter = "[^"]+"' "$CONTAINER_TS" | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -z "$ORIG_SLEEP" ]; then
  echo "error: could not find 'override sleepAfter' in $CONTAINER_TS" >&2
  exit 1
fi

set_sleep() {
  sed -i.bak -E "s/override sleepAfter = \"[^\"]+\";/override sleepAfter = \"$1\";/" "$CONTAINER_TS"
  rm -f "$CONTAINER_TS.bak"
}

DEPLOY_OK=0
cleanup() {
  # Always put the source file back to the committed value.
  set_sleep "$ORIG_SLEEP"
  if [ "$DEPLOY_OK" != "1" ]; then
    echo >&2
    echo "⚠️  Aborted. Restored $CONTAINER_TS to sleepAfter=\"$ORIG_SLEEP\"." >&2
    echo "    If a short-sleepAfter Worker already shipped, run: pnpm deploy:web" >&2
  fi
}
trap cleanup EXIT

echo "==> 1/4  Full deploy: build + push + roll out the new Container image"
pnpm deploy:all

echo "==> 2/4  sleepAfter \"$ORIG_SLEEP\" -> \"$SHORT_SLEEP\" so the warm pool sleeps fast"
set_sleep "$SHORT_SLEEP"
pnpm deploy:web

echo "==> 3/4  Waiting ${CYCLE_WAIT_SECONDS}s for warm instances to idle out + stop"
echo "         (keep generation traffic quiet during this window)"
sleep "$CYCLE_WAIT_SECONDS"

echo "==> 4/4  Restoring sleepAfter=\"$ORIG_SLEEP\" and redeploying the Worker"
set_sleep "$ORIG_SLEEP"
pnpm deploy:web

DEPLOY_OK=1
echo
echo "✅ Container deployed and warm pool cycled — the next generation request"
echo "   cold-starts on the new image. Verify in-app, or hit a route only the"
echo "   new build has (a stale Container returns {\"error\":\"not found\"})."

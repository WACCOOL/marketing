# Phase 2c generation container.
#
# Multi-stage pnpm-workspace build. The build CONTEXT is the repo root (set via
# `image_build_context` in apps/api/wrangler.jsonc) so the builder can resolve the
# @wac/shared workspace package and bundle it into the service with esbuild. The
# runtime stage installs only the native dependency (sharp); everything else is
# inlined into dist/server.js, so the final image stays lean.

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Install deps first (better layer caching). Copy only manifests + lockfile.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/generator/package.json ./apps/generator/package.json
RUN pnpm install --filter @wac/generator... --frozen-lockfile

# Copy sources and bundle (esbuild inlines @wac/shared + zod + sdk clients).
COPY packages/shared ./packages/shared
COPY apps/generator ./apps/generator
RUN pnpm --filter @wac/generator build

# Strip workspace/dev deps so the runtime install only pulls the native sharp
# binary (avoids npm choking on the `workspace:*` protocol outside pnpm).
RUN node -e "const p=require('/repo/apps/generator/package.json'); delete p.devDependencies; require('fs').writeFileSync('/repo/apps/generator/package.runtime.json', JSON.stringify(p))"

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# PPT Generator toolchain (PRD §8): python-pptx fills the template,
# LibreOffice headless converts to PDF, poppler renders the PNG thumbnail.
# fonts-liberation gives LibreOffice metric-compatible substitutes for the
# Office core fonts so PDF text doesn't reflow.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-pip libreoffice-impress poppler-utils \
       fonts-liberation fontconfig \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages python-pptx

COPY --from=builder /repo/apps/generator/package.runtime.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /repo/apps/generator/dist ./dist
# python-pptx scripts (introspect.py / build_deck.py); src/ppt.ts resolves them
# at PPT_SCRIPTS_DIR (default /app/python — WORKDIR above).
COPY apps/generator/python ./python

EXPOSE 8080
CMD ["node", "dist/server.js"]

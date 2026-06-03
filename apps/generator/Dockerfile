# Phase 2b generation container (stub). Single-stage is fine while the only deps
# are JS; switch to a multi-stage build in 2c when sharp/ImageMagick/LibreOffice
# land and the image grows.
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching. No workspace deps, so a plain
# npm install against this package.json works standalone in the build context.
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/server.js"]

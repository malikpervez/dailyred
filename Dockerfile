# syntax=docker/dockerfile:1
#
# Daily Red as a Discord Activity, in one image: builds the ROM from source,
# fetches the emulator, bundles Discord's SDK, and serves everything with the
# activity server (activity/server.mjs). See docs/discord-activity.md.
#
#   docker compose up -d --build
#
# Builds on x86_64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS). The first
# build compiles the whole game and takes a while on a Pi (roughly 10-20 min).

# --- 1. The ROM -------------------------------------------------------------------
# Same compiler as the macOS setup (xPack arm-none-eabi-gcc 14.2.1). The ROM is
# the same whatever CPU builds it, so this stage runs on the build machine's
# own architecture.
FROM --platform=$BUILDPLATFORM debian:trixie-slim AS rom
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl git libpng-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/setup-linux.sh scripts/
RUN scripts/setup-linux.sh
COPY scripts/ scripts/
COPY patches/ patches/
RUN scripts/get-pokefirered.sh
# Fewer parallel jobs if the build runs out of memory: --build-arg JOBS=2
ARG JOBS
RUN JOBS="${JOBS:-$(nproc)}" scripts/build-rom.sh

# --- 2. Emulator, font and the Discord SDK ---------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS vendor
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/fetch-vendor.sh scripts/
RUN scripts/fetch-vendor.sh
COPY activity/package.json activity/package-lock.json activity/
RUN cd activity && npm ci --no-audit --no-fund
COPY activity/build-sdk.mjs activity/
RUN cd activity && npm run build-sdk

# --- 3. The server -------------------------------------------------------------------
# Plain Node with no npm packages: node:sqlite for the stats, node:http for the rest.
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY web/ web/
COPY --from=vendor /src/web/vendor/ web/vendor/
COPY --from=rom /src/web/game/ web/game/
COPY activity/server.mjs activity/app.mjs activity/store.mjs activity/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "activity/server.mjs"]

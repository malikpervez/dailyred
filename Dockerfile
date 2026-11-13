# syntax=docker/dockerfile:1
#
# Daily Red in one image: bundles the battle engine (Pokémon Showdown's
# simulator) and Discord's SDK, fetches the font and the Pokémon sprites, and
# serves everything with the activity server (activity/server.mjs). See
# docs/discord-activity.md.
#
#   docker compose up -d --build
#
# Builds on x86_64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS) in a minute
# or two.

# --- 1. The site's vendored files ---------------------------------------------------
# Nothing here depends on the CPU, so this stage runs on the build machine's own.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/fetch-vendor.sh scripts/
RUN scripts/fetch-vendor.sh
COPY activity/package.json activity/package-lock.json activity/
RUN cd activity && npm ci --no-audit --no-fund
# The Pokémon sprites and move animation graphics, from pret/pokefirered's
# graphics (a few MB of git).
COPY activity/build-sprites.mjs activity/
COPY web/battle/fx-sprites.js web/battle/
COPY scripts/get-sprites.sh scripts/
RUN scripts/get-sprites.sh /tmp/pokefirered && rm -rf /tmp/pokefirered
COPY activity/build-sdk.mjs activity/build-battle.mjs activity/team-of-day.mjs activity/
COPY web/battle/ web/battle/
# The bag's rules (the battle engine checks items with them).
COPY web/economy.js web/
RUN cd activity && npm run build

# --- 2. The server -------------------------------------------------------------------
# Plain Node with no npm packages: node:sqlite for the stats, node:http for the rest.
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY web/ web/
COPY --from=build /src/web/vendor/ web/vendor/
COPY --from=build /src/web/sprites/ web/sprites/
COPY activity/server.mjs activity/app.mjs activity/store.mjs activity/bot.mjs activity/
# Today's card picture: drawn by the server from the sprites and this lettering.
COPY activity/card-image.mjs activity/png.mjs activity/card-title.png activity/
# The day's six for the bot's card (the battle data, bundled: a few MB).
COPY --from=build /src/activity/dist/ activity/dist/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "activity/server.mjs"]

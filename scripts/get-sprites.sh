#!/usr/bin/env bash
# Fetches the Pokémon battle sprites from pret/pokefirered (only
# graphics/pokemon/, at a pinned commit) and writes them to web/sprites/ with
# activity/build-sprites.mjs. Needs git and Node, and `npm ci` in activity/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRET_URL="https://github.com/pret/pokefirered.git"
PRET_COMMIT="037335f4c725d7c9aecdac87066f2002b4bd7e14"
SRC="${1:-$(mktemp -d)}"

if [ ! -d "$SRC/graphics/pokemon" ]; then
  echo ">> Fetching pret/pokefirered graphics @ ${PRET_COMMIT:0:10}"
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$PRET_URL"
  git -C "$SRC" sparse-checkout set --no-cone /graphics/pokemon/
  git -C "$SRC" fetch -q --depth 1 --filter=blob:none origin "$PRET_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi

node "$ROOT/activity/build-sprites.mjs" "$SRC" "$ROOT/web/sprites"

#!/usr/bin/env bash
# Fetches the Pokémon battle sprites, move animation graphics and the trainer
# pictures (RED and the Road to RED's) from pret/pokefirered (only graphics/pokemon/,
# graphics/battle_anims/sprites/ and those pictures, at a pinned commit) and writes them to web/sprites/ with
# activity/build-sprites.mjs. Needs git and Node, and `npm ci` in activity/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRET_URL="https://github.com/pret/pokefirered.git"
PRET_COMMIT="037335f4c725d7c9aecdac87066f2002b4bd7e14"
SRC="${1:-$(mktemp -d)}"

# The trainers' pictures (activity/build-sprites.mjs TRAINER_PICS).
TRAINERS="red champion_rival champion_steven leader_giovanni elite_four_lance leader_wallace"
PATHS=()
for t in $TRAINERS; do PATHS+=("/graphics/trainers/front_pics/${t}_front_pic.png" "/graphics/trainers/palettes/${t}.pal"); done

if [ ! -f "$SRC/graphics/trainers/front_pics/leader_wallace_front_pic.png" ]; then
  echo ">> Fetching pret/pokefirered graphics @ ${PRET_COMMIT:0:10}"
  [ -d "$SRC/.git" ] || { git init -q "$SRC" && git -C "$SRC" remote add origin "$PRET_URL"; }
  git -C "$SRC" sparse-checkout set --no-cone /graphics/pokemon/ /graphics/battle_anims/sprites/ "${PATHS[@]}"
  git -C "$SRC" fetch -q --depth 1 --filter=blob:none origin "$PRET_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi

node "$ROOT/activity/build-sprites.mjs" "$SRC" "$ROOT/web/sprites"

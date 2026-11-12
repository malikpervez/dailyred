#!/usr/bin/env bash
# Downloads the site's font into web/vendor/ so the site is fully self-hosted
# (no CDN at runtime). The version and checksum are pinned.
#
#   - Pixelify Sans, latin subset (SIL Open Font License 1.1)
#
# The rest of web/vendor/ is built from npm packages in activity/ (npm run
# build: the Discord SDK and the battle engine).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/web/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FONT_URL="https://fonts.gstatic.com/s/pixelifysans/v3/CHylV-3HFUT7aC4iv1TxGDR9Jn0Ei0tSaJ0.woff2"
FONT_SHA="0f2216c1b7bf13b775e7b825c15e1c8414f3899cbd4120f275cdc96001a053a0"
FONT_LICENSE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/pixelifysans/OFL.txt"

check() { # file sha
  local actual
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$1" | awk '{print $1}')"
  else actual="$(shasum -a 256 "$1" | awk '{print $1}')"; fi
  [ "$actual" = "$2" ] || { echo "Checksum mismatch: $1 ($actual)"; exit 1; }
}

mkdir -p "$VENDOR"

echo ">> Pixelify Sans"
curl -fsSL -o "$TMP/font.woff2" "$FONT_URL"
check "$TMP/font.woff2" "$FONT_SHA"
cp "$TMP/font.woff2" "$VENDOR/pixelify-sans.woff2"
curl -fsSL -o "$VENDOR/pixelify-sans.OFL.txt" "$FONT_LICENSE_URL"

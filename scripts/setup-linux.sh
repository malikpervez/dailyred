#!/usr/bin/env bash
# Installs the ROM compiler on Linux (x86_64 or arm64, e.g. a Raspberry Pi):
# the same xPack GNU Arm Embedded GCC that scripts/setup-macos.sh uses, into
# ./.toolchain/arm-none-eabi. The Dockerfile runs this too.
#
# Also needs a native C compiler, make, git and libpng, from the system:
#   sudo apt install build-essential git libpng-dev
#
# Re-running is safe: finished steps are skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
mkdir -p "$TC/downloads"

GCC_VER="14.2.1-1.1"

case "$(uname -m)" in
  x86_64)         GCC_HOST="linux-x64" ;;
  aarch64|arm64)  GCC_HOST="linux-arm64" ;;
  *) echo "Unsupported CPU: $(uname -m) (use a 64-bit OS on the Raspberry Pi)"; exit 1 ;;
esac

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

for tool in cc make git; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run: sudo apt install build-essential git libpng-dev"; exit 1; }
done
if ! echo '#include <png.h>' | cc -E -x c - >/dev/null 2>&1; then
  echo "Missing libpng headers. Run: sudo apt install libpng-dev"; exit 1
fi

GCC_NAME="xpack-arm-none-eabi-gcc-$GCC_VER"
if [ ! -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  tarball="$GCC_NAME-$GCC_HOST.tar.gz"
  url="https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v$GCC_VER/$tarball"
  echo ">> Downloading $tarball"
  curl -fL --retry 3 -o "$TC/downloads/$tarball" "$url"
  curl -fsL -o "$TC/downloads/$tarball.sha" "$url.sha"
  expected="$(awk '{print $1}' "$TC/downloads/$tarball.sha")"
  [ "$expected" = "$(sha256 "$TC/downloads/$tarball")" ] || { echo "Checksum mismatch for $tarball"; exit 1; }
  echo ">> Checksum OK, extracting"
  tar -xzf "$TC/downloads/$tarball" -C "$TC"
  rm -f "$TC/arm-none-eabi"
  ln -s "$GCC_NAME" "$TC/arm-none-eabi"
  rm -f "$TC/downloads/$tarball"
fi
"$TC/arm-none-eabi/bin/arm-none-eabi-gcc" --version | head -1
echo 'int f(void){return 0;}' | "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" -x c -c -o /dev/null -

echo
echo "Toolchain ready. Build with: scripts/build-rom.sh"

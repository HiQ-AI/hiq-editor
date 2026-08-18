#!/usr/bin/env bash
# Cross-compiles the single-file executables shipped on GitHub Releases.
# One Bun toolchain builds every target, so this runs the same on a laptop and in CI.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=dist-bin
rm -rf "$OUT" && mkdir -p "$OUT"

bun scripts/stamp-version.mjs

# Archive names carry no version: that lets the installers fetch
# `releases/latest/download/<name>` straight off GitHub — no version lookup, so
# no anonymous-API rate limit to hit on someone's first install.
#
# name=bun-target. `-baseline` targets omit AVX2 so the binaries also run on
# pre-2013 x64 hardware and inside VMs that mask CPU features.
TARGETS=(
  "darwin-arm64=bun-darwin-arm64"
  "darwin-x64=bun-darwin-x64-baseline"
  "linux-x64=bun-linux-x64-baseline"
  "linux-arm64=bun-linux-arm64"
  "windows-x64=bun-windows-x64-baseline"
)

for entry in "${TARGETS[@]}"; do
  name="${entry%%=*}"
  target="${entry#*=}"
  ext=""; [[ "$name" == windows-* ]] && ext=".exe"
  bin="$OUT/hiq-editor-$name$ext"

  echo "→ $name"
  bun build src/cli.ts --compile --minify --sourcemap=none \
    --target="$target" --outfile "$bin"

  # Bun ad-hoc signs its Darwin output, but a re-sign here is what guarantees
  # the signature survives; unsigned arm64 Mach-O is killed on launch.
  if [[ "$name" == darwin-* && "$(uname -s)" == Darwin ]]; then
    codesign --force --sign - "$bin"
  fi

  # Archive per platform convention: zip on Windows, tar.gz elsewhere. The
  # member name is bare `hiq-editor` so install scripts need no per-OS casing.
  staged="$OUT/hiq-editor$ext"
  mv "$bin" "$staged"
  if [[ "$name" == windows-* ]]; then
    (cd "$OUT" && zip -q "hiq-editor-$name.zip" "hiq-editor$ext")
  else
    chmod +x "$staged"
    (cd "$OUT" && tar czf "hiq-editor-$name.tar.gz" hiq-editor)
  fi
  rm -f "$staged"
done

# Bun ≥1.3 writes a .map next to the executable whatever --sourcemap says.
# Drop it before hashing, or it ends up on the Release as a stray 1.6MB asset.
find "$OUT" -type f ! -name '*.tar.gz' ! -name '*.zip' -delete

(cd "$OUT" && shasum -a 256 ./* > checksums.txt)
echo && ls -lh "$OUT"

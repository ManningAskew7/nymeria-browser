#!/usr/bin/env bash
# Package the built extension into the beta release zip.
#
# Produces release/nymeria-browser-v<version>.zip containing a single
# top-level folder (nymeria-browser-v<version>/) with the dist build
# inside, so an end user unzips it and gets exactly one directory to hand
# to "Load unpacked". The same artifact feeds the headless launcher:
# `nymeria-headless.sh configure --source <the zip>` accepts it directly.
#
# The zip is built by scripts/make_zip.py (python3, no zip binary assumed,
# matching the launcher's bash+python3 rule) and the sha256 is printed so a
# release note can pin it. Zips are NOT committed: release/ is gitignored.
# What make_zip.py guarantees, and this script therefore inherits: the same
# dist/ always produces the same bytes (constant member timestamps and
# permissions, so a re-run or a fresh checkout reproduces the digest the
# backend pins), and a dist/ holding a credential-shaped file (a baked
# config.json carries a full account token) fails the build instead of
# publishing it. Reproducing a digest from a TAG additionally needs the
# build itself to be reproducible, which is vite's business, not this
# script's.
#
# Usage: scripts/package.sh          # requires an existing dist/ build
#        scripts/package.sh --build  # runs npm run build first
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

if [ "${1:-}" = "--build" ]; then
  npm run build
fi
[ -f dist/manifest.json ] || {
  echo "no dist/manifest.json: run npm run build first (or pass --build)" >&2
  exit 1
}

version=$(python3 -c "import json; print(json.load(open('dist/manifest.json'))['version'])")
mkdir -p release
out="release/nymeria-browser-v${version}.zip"

python3 scripts/make_zip.py dist "$out" "nymeria-browser-v${version}"

echo "sha256: $(sha256sum "$out" | cut -d' ' -f1)"
echo "version: ${version}"

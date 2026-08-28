#!/usr/bin/env bash
# Package the built extension into the beta release zip.
#
# Produces release/nymeria-browser-v<version>.zip containing a single
# top-level folder (nymeria-browser-v<version>/) with the dist build
# inside, so an end user unzips it and gets exactly one directory to hand
# to "Load unpacked". The same artifact feeds the headless launcher:
# `nymeria-headless.sh configure --source <the zip>` accepts it directly.
#
# The zip is built with python3's zipfile (no zip binary assumed, matching
# the launcher's bash+python3 rule) and the sha256 is printed so a release
# note can pin it. Zips are NOT committed: release/ is gitignored, the
# build is reproducible from the tag.
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

python3 - "$out" "$version" <<'EOF'
import json, os, sys, zipfile

out, version = sys.argv[1], sys.argv[2]
top = f"nymeria-browser-v{version}"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk("dist"):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, "dist")
            z.write(path, f"{top}/{rel}")
print(out)
EOF

echo "sha256: $(sha256sum "$out" | cut -d' ' -f1)"
echo "version: ${version}"

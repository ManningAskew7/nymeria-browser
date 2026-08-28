#!/usr/bin/env bash
# Unattended headless deployment of the Nymeria browser extension.
#
# Gives a server (no display, no popup) a fully driveable Chrome: fetches
# Chrome for Testing, prepares a headless install of the extension whose
# permissions are REQUIRED (auto-granted at load, no popup click), bakes the
# backend URL + token into a packaged config.json the worker adopts at
# startup, and runs Chrome in the new headless mode. Requires bash, curl,
# python3 (zip extraction and JSON transforms; unzip is not assumed).
#
# Commands:
#   install                       fetch the current stable Chrome for Testing
#   configure --base-url U --token T [--source DIR]
#                                 stage the extension + bake the config
#   run [--profile DIR] [--debug-port N] [--no-sandbox]
#                                 launch (foreground; systemd-friendly);
#                                 refuses while an instance is already up
#   stop                          kill every instance launched from here
#   status [--debug-port N]       is Chrome up, and is our worker present
#
# State lives under $NYMERIA_HEADLESS_HOME (default ~/.nymeria-browser):
#   cft/<version>/chrome-linux64/chrome   the browser
#   ext/                                  staged extension + config.json
#   profile/                              default persistent user-data-dir
#
# Sandbox note (Ubuntu 23.10+): AppArmor restricts unprivileged user
# namespaces, so stock Chrome cannot build its sandbox and aborts at launch.
# The durable fix is a one-time root-installed AppArmor profile (see
# https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
# `run --no-sandbox` is the explicit, logged opt-out for containers and
# boxes where that is not possible.
set -euo pipefail

HOME_DIR="${NYMERIA_HEADLESS_HOME:-$HOME/.nymeria-browser}"
CFT_DIR="$HOME_DIR/cft"
EXT_DIR="$HOME_DIR/ext"
PROFILE_DIR_DEFAULT="$HOME_DIR/profile"
VERSIONS_URL="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"

die() { echo "nymeria-headless: $*" >&2; exit 1; }

chrome_binary() {
  local first
  first=$(find "$CFT_DIR" -maxdepth 3 -name chrome -type f 2>/dev/null | sort | tail -1)
  [ -n "$first" ] || return 1
  echo "$first"
}

cmd_install() {
  mkdir -p "$CFT_DIR"
  echo "Resolving current stable Chrome for Testing..."
  local url version
  read -r version url < <(curl -fsSL "$VERSIONS_URL" | python3 -c '
import json, sys
data = json.load(sys.stdin)
stable = data["channels"]["Stable"]
downloads = stable["downloads"]["chrome"]
url = next(d["url"] for d in downloads if d["platform"] == "linux64")
print(stable["version"], url)
')
  if [ -x "$CFT_DIR/$version/chrome-linux64/chrome" ]; then
    echo "Chrome for Testing $version already installed."
    return 0
  fi
  echo "Downloading Chrome for Testing $version..."
  local zip="$HOME_DIR/cft-$version.zip"
  curl -fSL -o "$zip" "$url"
  # Python extraction with mode restoration: unzip is not a given on
  # servers, and zipfile alone drops the exec bits.
  python3 - "$zip" "$CFT_DIR/$version" <<'EOF'
import os, sys, zipfile
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    for info in z.infolist():
        path = z.extract(info, dest)
        mode = info.external_attr >> 16
        if mode:
            os.chmod(path, mode)
print("extracted to", dest)
EOF
  rm -f "$zip"
  "$CFT_DIR/$version/chrome-linux64/chrome" --version || die "installed binary does not run (missing system libraries?)"
}

cmd_configure() {
  local base_url="" token="" source=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) base_url="$2"; shift 2 ;;
      --token) token="$2"; shift 2 ;;
      --source) source="$2"; shift 2 ;;
      *) die "unknown configure option: $1" ;;
    esac
  done
  [ -n "$base_url" ] && [ -n "$token" ] || die "configure needs --base-url and --token"
  if [ -z "$source" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    source="$script_dir/../dist"
  fi
  # A release zip (scripts/package.sh) is accepted directly: unpack it and
  # stage from whichever directory holds manifest.json (the zip wraps one
  # top-level folder). python3 zipfile, same no-extra-binaries rule as
  # install's Chrome fetch.
  if [ -f "$source" ] && [[ "$source" == *.zip ]]; then
    local unpack_dir="$HOME_DIR/unpacked-release"
    rm -rf "$unpack_dir"
    mkdir -p "$unpack_dir"
    python3 - "$source" "$unpack_dir" <<'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PYEOF
    if [ -f "$unpack_dir/manifest.json" ]; then
      source="$unpack_dir"
    else
      source=$(find "$unpack_dir" -mindepth 2 -maxdepth 2 -name manifest.json -printf '%h\n' | head -1)
      [ -n "$source" ] || die "no manifest.json inside the zip"
    fi
  fi
  [ -f "$source/manifest.json" ] || die "no extension build at $source (run npm run build, pass --source <dir>, or pass a release zip)"
  rm -rf "$EXT_DIR"
  mkdir -p "$HOME_DIR"
  cp -r "$source" "$EXT_DIR"
  # The headless transform: required permissions are auto-granted for an
  # unpacked load, which is what replaces the popup's permission clicks.
  python3 - "$EXT_DIR/manifest.json" <<'EOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    manifest = json.load(f)
optional = manifest.pop("optional_host_permissions", [])
merged = list(dict.fromkeys(list(manifest.get("host_permissions", [])) + optional))
manifest["host_permissions"] = merged
manifest["optional_host_permissions"] = []
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print("manifest: host permissions now required:", merged)
EOF
  python3 - "$EXT_DIR/config.json" "$base_url" "$token" <<'EOF'
import json, sys
path, base_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "w") as f:
    json.dump({"baseUrl": base_url, "token": token}, f)
    f.write("\n")
EOF
  chmod 600 "$EXT_DIR/config.json"
  echo "Staged extension at $EXT_DIR (config.json baked, mode 600)."
  echo "NOTE: a fresh profile adopts the bake on first run; to apply a"
  echo "CHANGED config to an existing profile, remove the profile dir."
  echo "WARNING: an existing profile can serve the OLD service-worker script"
  echo "from its cache even across a full browser restart, while announcing"
  echo "the NEW manifest version (measured 2026-08-28: a whole QA round ran"
  echo "on stale code that reported the new build). After staging a NEW"
  echo "build, launch with: run --fresh-profile (costs site logins/cookies)."
}

cmd_run() {
  local profile="$PROFILE_DIR_DEFAULT" port=9222 sandbox_flag="" fresh_profile=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --debug-port) port="$2"; shift 2 ;;
      --no-sandbox) sandbox_flag="--no-sandbox"; shift ;;
      --fresh-profile) fresh_profile=1; shift ;;
      *) die "unknown run option: $1" ;;
    esac
  done
  local chrome
  chrome=$(chrome_binary) || die "no Chrome for Testing installed; run: $0 install"
  [ -f "$EXT_DIR/manifest.json" ] || die "extension not staged; run: $0 configure"
  [ -f "$EXT_DIR/config.json" ] || die "no baked config; run: $0 configure"
  # One instance per home, enforced: a second one subscribes the SAME
  # account and both then execute every broadcast command (measured
  # 2026-08-28: non-deterministic tab routing, probe showing only one).
  if pgrep -f "$HOME_DIR/cft/.*chrome-linux64/chrome" >/dev/null; then
    die "an instance from $HOME_DIR is already running; use: $0 stop"
  fi
  # A pre-existing profile can hand Chrome the OLD service-worker script from
  # its cache even across a full restart, while the manifest (read fresh)
  # announces the NEW version: the deploy looks landed and the code is stale.
  # Measured 2026-08-28; the wipe is the reliable invalidation. Opt-in
  # because a profile also carries the agent's site logins.
  if [ -n "$fresh_profile" ]; then
    echo "Removing profile dir ($profile): stale-SW-cache guard; the baked config re-adopts on first run."
    rm -rf "$profile"
  fi
  mkdir -p "$profile"
  if [ -n "$sandbox_flag" ]; then
    echo "WARNING: running with --no-sandbox (explicit opt-out; prefer the AppArmor profile, see header)."
  fi
  echo "Launching $($chrome --version) on debug port $port (profile: $profile)."
  # Foreground on purpose: systemd (or the operator's supervisor) owns the
  # lifecycle. --remote-debugging-port stays loopback-bound by Chrome.
  exec "$chrome" \
    --headless=new \
    $sandbox_flag \
    --user-data-dir="$profile" \
    --disable-extensions-except="$EXT_DIR" \
    --load-extension="$EXT_DIR" \
    --remote-debugging-port="$port" \
    --no-first-run \
    --disable-gpu
}

cmd_stop() {
  # Kill every Chrome launched from THIS home's staged install. Exists
  # because a hand-rolled pkill pattern missed the versioned path once
  # (2026-08-28) and the surviving instance stayed subscribed on the same
  # account as its replacement: two browsers then executed every command
  # with non-deterministic tab routing, while the connection probe showed
  # only one of them. Always stop through here before a relaunch.
  local pids
  pids=$(pgrep -f "$HOME_DIR/cft/.*chrome-linux64/chrome" || true)
  if [ -z "$pids" ]; then
    echo "No headless Chrome from $HOME_DIR running."
    return 0
  fi
  echo "$pids" | xargs -r kill
  sleep 2
  if pgrep -f "$HOME_DIR/cft/.*chrome-linux64/chrome" >/dev/null; then
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  pgrep -f "$HOME_DIR/cft/.*chrome-linux64/chrome" >/dev/null && die "instances survived kill -9" || echo "Stopped."
}

cmd_status() {
  local port=9222
  while [ $# -gt 0 ]; do
    case "$1" in
      --debug-port) port="$2"; shift 2 ;;
      *) die "unknown status option: $1" ;;
    esac
  done
  local version
  version=$(curl -fsS -m 3 "http://127.0.0.1:$port/json/version" 2>/dev/null) || die "Chrome not answering on 127.0.0.1:$port"
  echo "$version" | python3 -c 'import json,sys; print("Chrome:", json.load(sys.stdin)["Browser"])'
  # The worker may be idle-stopped (normal); poke a target list and report.
  curl -fsS -m 3 "http://127.0.0.1:$port/json" | python3 -c '
import json, sys
targets = json.load(sys.stdin)
workers = [t for t in targets if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://")]
print("extension worker target:", "PRESENT" if workers else "absent (may be idle-stopped; not an error by itself)")
'
  echo "Connection truth lives on the backend: ask a Nymeria thread to run chrome_health."
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  configure) shift; cmd_configure "$@" ;;
  run) shift; cmd_run "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

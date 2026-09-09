#!/usr/bin/env python3
"""Build the release zip: byte-reproducible, and refusing to ship secrets.

    make_zip.py <source-dir> <out-zip> <top-folder>

Two properties this exists for, both load-bearing:

REPRODUCIBLE. The backend pins one release by version AND sha256
(`nymeria browser configure` refuses to stage a zip whose digest differs),
so the same tree must always produce the same bytes. `ZipFile.write()` does
not: it stores each member's filesystem mtime and permission bits, so a
fresh checkout, a re-run of the release workflow, or a rebuild after a
`touch` produces a different digest from identical content and breaks
configure on every host that has not already cached the old zip. Members are
therefore walked in sorted order and written with a CONSTANT timestamp
(1980-01-01, the zip epoch) and CONSTANT permissions (0644, Unix), which is
the same recipe `strip-nondeterminism` applies after the fact.

CREDENTIAL-FREE. The one file that must never reach a public GitHub Release
is a baked `config.json`: it carries a full Nymeria account token, and this
extension's own tooling makes producing one routine (`nymeria browser
configure` bakes it into a staged copy of the extension). Nothing else in
the pipeline stops it, so this refuses the whole build, loudly, naming every
offending path, rather than quietly excluding it: a quiet exclusion would
also hide the far worse fact that a token-bearing file was sitting in the
directory being published.
"""

from __future__ import annotations

import os
import sys
import zipfile

# The zip epoch. Any constant works; this one is what every reproducible-zip
# tool uses, and predates it so no reader can mistake it for a real time.
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
# rw-r--r--, regular file, Unix. The high 16 bits of external_attr are the
# st_mode; the low byte carries the DOS attributes (0 = ordinary file).
FIXED_MODE = (0o100644 << 16)
CREATE_SYSTEM_UNIX = 3

# Credential-shaped files, matched on the BASENAME, case-insensitively.
DENIED_NAMES = frozenset(
    {
        "config.json",  # the baked rig config: carries an account token
        "credentials.json",
        "secrets.json",
        "secrets.yaml",
        "secrets.yml",
        "rig.json",  # the server-browser rig record, beside the baked config
    }
)
DENIED_PREFIXES = (".env", "id_rsa", "id_ecdsa", "id_ed25519", ".npmrc", ".netrc")
DENIED_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".ppk", ".asc", ".keystore", ".jks")


def is_denied(name: str) -> bool:
    lowered = name.lower()
    if lowered in DENIED_NAMES:
        return True
    if lowered.startswith(DENIED_PREFIXES):
        return True
    return lowered.endswith(DENIED_SUFFIXES)


def collect(source: str) -> list[tuple[str, str]]:
    """Every file under ``source`` as (path, relative path), in a stable order."""
    members: list[tuple[str, str]] = []
    for root, dirs, files in os.walk(source):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            members.append((path, os.path.relpath(path, source)))
    return members


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: make_zip.py <source-dir> <out-zip> <top-folder>", file=sys.stderr)
        return 2
    source, out, top = argv[1], argv[2], argv[3]

    members = collect(source)
    denied = [rel for _path, rel in members if is_denied(os.path.basename(rel))]
    if denied:
        print(
            f"refusing to package {source}/: it holds files that must never be published:",
            file=sys.stderr,
        )
        for rel in denied:
            print(f"  {rel}", file=sys.stderr)
        print(
            "A baked config.json carries a full Nymeria account token. Remove these "
            "and rebuild; do not add them to an exclude list.",
            file=sys.stderr,
        )
        return 3

    # Written only after the whole tree passed, so a refusal never leaves a
    # partial zip behind for the next step to publish.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, rel in members:
            info = zipfile.ZipInfo(f"{top}/{rel.replace(os.sep, '/')}", FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = CREATE_SYSTEM_UNIX
            info.external_attr = FIXED_MODE
            with open(path, "rb") as fh:
                zf.writestr(info, fh.read())
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

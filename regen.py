#!/usr/bin/env python3
"""Regenerate chrome-tools-reference.md from the live chrome_browser module.

Run from this repo root:
    env -u NYMERIA_PROJECT_ROOT python3 regen.py

The env -u matters: NYMERIA_PROJECT_ROOT pointing at the slim dogfood
instance would load that config instead of the checkout's. After a
successful run, update the commit hashes in CLAUDE.md's "Tool surface
reference" section.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/opt/Project-Nymeria/Nymeria")

import nymeria.tools.chrome_browser as mod  # noqa: E402

# Derived from the kit surface, so a new tool can never be silently
# missing from the reference.
NAMES = list(mod.CHROME_KIT_TOOL_NAMES)

OUT = Path(__file__).with_name("chrome-tools-reference.md")

lines = [
    "# chrome_* tool surface, verbatim (GENERATED)\n",
    "Generated from `nymeria/tools/chrome_browser.py` at the commit noted in CLAUDE.md.",
    "Regenerate with `regen.py` beside this file after any tool change. The description",
    "below IS the model-facing docstring, verbatim; args are the bound JSON schema.\n",
]
for name in NAMES:
    t = getattr(mod, name)
    lines += [
        f"\n---\n\n## {t.name}\n",
        "Args schema:\n",
        "```json",
        json.dumps(t.args, indent=2, default=str),
        "```\n",
        "Description (verbatim docstring):\n",
        "````",
        t.description.rstrip(),
        "````",
    ]

OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(NAMES)} tools)")

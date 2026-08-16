# CLAUDE.md (nymeria-browser: dev/QA standing info)

Facts that fresh sessions have repeatedly re-derived or tripped over. Trust
this file over memory; update it when a fact changes. It lives in this repo
(moved 2026-08-16 from an operator-local skill) so it loads automatically
when working on the extension.

## The one picture to hold

The EXTENSION runs in the USER'S Chrome on THEIR machine, not on the VPS.
The BACKEND (chrome_* tools in `Nymeria/nymeria/tools/chrome_browser.py`)
runs on the VPS, in the Docker stack (port 8000). The two halves meet over
SSE: backend publishes browser commands, the user's extension executes and
POSTs results. Consequences:

- Extension deploy flow (live 2026-08-16): after pushing this repo, wait
  EXACTLY 3 minutes (the user's machine auto-pulls and rebuilds on its own
  schedule), then start the QA session on the sanctioned thread and have it
  run `chrome_reload_extension` FIRST, before any testing. No manual step
  remains in the ordinary loop. Bump the manifest version each shipped
  pass: `version_after` in the reload result is the build confirmation,
  and a stale value means the rebuild has not landed yet (measured
  2026-08-16: 3 minutes was once not enough; wait ~2 more and retry the
  reload rather than QA'ing old code). Fallback: a build that fails to
  load strands the extension (the reload tool cannot revive it); only then
  ask the user to reload by hand at chrome://extensions.
- Backend code changes are inert until COMMITTED to main: deploy-sync (a
  5-min idle-gated timer) restarts the stack on commit. Never manually
  restart after a push; for QA of the backend half, commit first, then
  WAIT for the bounce to land before prompting QA (up to ~5 idle minutes;
  confirm with `docker inspect nymeria-api --format '{{.State.StartedAt}}'`,
  since a round dispatched before the restart tests the OLD backend).
  Settled precedent from the #168 and #175 passes. Skew trap (measured
  2026-08-16): kit manifests (`skills_bundled/*/SKILL.md`) are read from
  the bind mount per-activation while the tool registry loads per-restart,
  so an uncommitted manifest edit naming a not-yet-registered tool makes
  the kit bind NOTHING until the commit deploys.
- You cannot see the user's screen. Grants, visible prompts, and anything
  OS-level need the user to confirm by hand.

## Live QA

- QA thread: `38e2c63c` (title "[QA session: browser extension update...]"),
  via the `nymeria` MCP (`nymeria_chat`, verbosity "concise"). Reuse it: it
  holds the running QA history (#168 fused waits, nav honesty, #175
  http_status, budget, batched upload, #160 worlds/refs, OOPIF input). The
  driving agent there is capable; give it one focused round per message and
  have it quote payload fields. A FRESH thread is fine (and better when the
  user may be working in that one): the actionability pass ran on `01f4dec8`
  with no loss, since each round carries its own fixture and expectations.
  Set the model on a new thread (`/model claude-opus-5 thread`); a fresh
  thread otherwise inherits the default, which is not the QA-grade one.
- After an extension push, the round starts with `chrome_reload_extension`
  (see the deploy flow above) so QA always runs the just-shipped code.
- Standing user request: after functional rounds, ALWAYS ask the thread
  agent for its opinion/suggestions on the tooling as its operator, and
  relay those to the user (they routinely become backlog rows).
- Etiquette: fresh tabs only, close QA tabs at the end, never touch the
  user's own tabs. The browser-control kit binds with a 2h TTL; the agent
  re-binds itself when lapsed.
- Reliable QA targets: `https://example.com/` (200),
  `https://www.google.com/nonexistent-page-xyz` (real 404),
  `https://the-internet.herokuapp.com/upload` (file input + Upload button,
  success text "File Uploaded!"; NOTE the site is X-Frame-Options
  SAMEORIGIN, unusable inside iframes), `https://pypi.nymeriaos.com/simple/`
  (our own bare 401, `WWW-Authenticate: Basic realm="pypi"`). httpbin.org
  and httpstat.us were both DOWN during the 2026-08-15 QA; curl-check
  before building a round on them. OOPIF fixtures (gist
  `5abcda526e35b6ad0bee69af96989a44`, editable via `gh gist edit`), parents
  at `gist.githack.com/ManningAskew7/<id>/raw/nymeria-qa-oopif-fixture-2.html`
  and `...-fixture-3.html` (fixture-3: example.org frame + a statically
  frame with links to BOTH example.org and www.iana.org; githack shows a
  one-click interstitial on first visit), and `...-fixture-4.html`
  (fixture-3 plus deterministic capture signals: frame B is
  `nymeria-qa-frame-links-2.html`, which logs "frame-b alive" and fires a
  same-origin 404 fetch `./nonexistent-177` on load; built for #177, the
  statically CDN caches gist files hard, so cache-bust with NEW filenames
  rather than editing one in place), and `...-sameproc-fixture-5.html`
  (reads-honesty pass: same-origin child frame with `#child-btn`/
  `#child-input`/`#child-status`, DOUBLY-nested grandchild with
  `#grand-btn`/`#grand-status`, showModal `#open-modal` + dialog `#dlg`,
  an aria-hidden block, `#behind-modal`; the nested-frame and
  collapse/hidden honesty target), `...-actionability-fixture-6.html`
  (actionability pass: `#disabled-btn` + `#disabled-check` (disabled),
  `#readonly-input` (readonly) beside `#normal-input` (control),
  `#invisible-input` (opacity:0 real control over a styled box,
  the annotate case), `#ghost-btn` (pointer-events:none over page
  background), and `#child-frame` under a real `#overlay` with
  `#dismiss-overlay`; child is `...-actionability-child-6.html` with
  `#child-btn`/`#child-status`. Every status paragraph starts
  `*-untouched`, so a refusal that actually acted is visible in one read),
  and `...-mixed-kind-fixture-1.html` (`#parent-btn`, same-origin
  `#wrapper-frame` -> `...-mixed-kind-wrapper-1.html` with
  `#wrapper-btn`/`#wrapper-input` and an example.org OOPIF `#oopif-frame`:
  an out-of-process frame nested inside a same-process one, so both frame
  kinds are exercised in a single tree). TRAP, measured 2026-08-16 and
  corrected same day by #177's live capture: an in-frame link to iana.org
  NEVER navigates. The operative blocker is MIXED CONTENT
  (`https://www.iana.org/domains/example` 301s to `http://...`, blocked
  from an HTTPS page before the fetch), with `X-Frame-Options: DENY` on
  the chain behind it; a curl -L follows past where the browser stops.
  Since #177 shipped this is no longer silent: the refusal appears as a
  `browser: true` console advisory and in the act payload's
  `console_errors`. Use iana links as a deliberate negative control;
  example.org's own page link points at iana, which is what made
  fixture-2's frame look cursed for three rounds.
- Measured 2026-08-15: a fullscreen game occluding the Chrome window makes
  driven navigations onto Basic-auth 401s auto-cancel
  (`net::ERR_INVALID_AUTH_CREDENTIALS`, no prompt, no http_status), and an
  auto-cancelled challenge can leave input suppression that SURVIVES
  navigation (only a fresh tab cleared it). Ask what is on the user's
  screen before reading a weird QA result as a code bug.

## Repos and deployment

- Extension: `/opt/Project-Nymeria/nymeria-browser/`. Its OWN git repo
  (`github.com/ManningAskew7/nymeria-browser`), gitignored inside the main
  tree, push separately. Module invariants live in module docstrings: read
  them before editing; this file is the standing map, not their
  replacement. Commits need the trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend tool file: `Nymeria/nymeria/tools/chrome_browser.py`; tests
  `Nymeria/tests/test_chrome_browser_tools.py`; kit
  `Nymeria/nymeria/skills_bundled/browser-control/SKILL.md`; docs rows in
  `Nymeria/docs/public/agent-systems/tools.md`.
- Backlog home: `docs/private/plans/backlog/03-tools-and-credentials.md`
  (#160/#165/#166 registers, #173); pass notes in
  `docs/private/plans/shipped/02-tools-skills-and-search.md`.

## Extension constraints that keep resurfacing

- Backend URL must be `https://` or localhost: the manifest's
  `optional_host_permissions` are `https://*/*` + loopback, so Connect to
  `http://<ip>:8000` fails BEFORE reaching Nymeria. Deliberate (bearer
  token in a logged-in browser); remote setups use Tailscale/Cloudflare/
  Caddy HTTPS.
- Page-status reporting (#175) is OPT-IN: the `webRequest` host grant comes
  from a dedicated popup button ("Page status reporting" row, Enable), NOT
  from Connect (`permissions.request` needs a direct user click; Connect's
  async chain breaks it). Ungranted, `http_status` is simply absent, and
  absent means unknown, never OK. First QA round after any fresh install:
  confirm the user actually clicked Enable + Allow (this bit us 2026-08-15:
  round 1 read as a feature failure and was just the missing grant).
- MV3 worker recycles: state is in-memory per worker; backend dispatch
  rides a 75s post-disconnect grace (#172), and a backend RESTART gets its
  own startup grace (#176 pass: a dispatch in the first ~75s of backend
  process life holds for the extension's reconnect instead of hard-failing
  with "click Connect"). The extension DOES auto-reconnect through an
  ordinary backend restart (measured; the 2026-08-16 strand was a
  one-off): a "not connected" right after a bounce usually just wants a
  beat, not a popup click. Snapshots die with the worker too: measured
  2026-08-16, both QA tabs answered `stale_refs: true, reason: "no-snapshot"`
  about 90 seconds after their last act, with NO navigation and page state
  intact. Mid-QA that is the worker recycling, not a bug in the round: re-read
  the page and carry on (the honest-copy half is filed as a residual).
- Ref lifetime (since stage B, 2026-08-16): frame refs key on the frame's
  STABLE target id and SURVIVE the 10s idle detach (never session-keyed);
  they refuse honestly when the frame left (`frame-gone`) or navigated
  (mint-URL compare). Do not "fix" a stale-looking frame ref by re-keying
  it to a session id. Since the reads-honesty pass (v0.4.0/0.5.0) the same
  token space also covers SAME-PROCESS frames (`Page.FrameId`; no session,
  everything rides the shared one).
- Reads-honesty traps (v0.5.0, measured): the same-process occlusion gate
  must test the OUTERMOST local ancestor's owner (`LocalFrame.path[0]`),
  never the immediate one, and must SKIP (fail open) when no ancestor
  chain is readable; both wrong forms deterministically refuse every
  nested-frame act as covered by its own ancestor. Same-process dispatch
  points come from `DOM.getContentQuads` on the element's OWN session
  (backendNodeIds are per-process; root-session quads for a
  nested-in-OOPIF node describe the wrong element). act.test's wait
  mocks extract the needle from the scan expression's
  `var NEEDLE = "..."` binding and THROW on shape drift: changing
  `waitTextExpression`'s shape means updating both mock sites.
- Actionability traps (v0.6.0, measured): `elementFromPoint` on a
  `pointer-events: none` target answers its ANCESTOR, so a gate keyed on
  `hit === false` alone would almost never fire live while the click landed
  on the wrapper and the payload reported delivery. `HIT_TEST_FN` therefore
  returns `via: 'self' | 'descendant' | 'ancestor'`, and only a MISS or an
  ancestor hit is a pointer-events refusal (a descendant hit is the
  legitimate `pointer-events: none` container). Two page facts are live, not
  static: `readonly` clears on focus (anti-autofill fields, date pickers) so
  that decision sits in fill/type AFTER their own `focusElement`, and
  `pointer-events` changes mid-transition, so both re-ask a single fact on
  the refusal path only. The facts ride the EXISTING ref-resolution probe
  (`ACTIONABILITY_FN` in `input.ts`), which is why they cover `@eN` refs and
  not `css=`/`xpath=`; act.test pins both the zero-extra-round-trips
  property and the one-probe-world-per-act ratchet, so a new probe call is a
  test failure, not a review catch. Pre-dispatch refusals use the payload
  key `refused` (`disabled`, `readonly`, `pointer_events_none`), never
  `reason` (that is the STALE-ref key). act.test's `Runtime.callFunctionOn`
  mock routes by SUBSTRING and the actionability body contains
  `isConnected`, `isContentEditable` and `getComputedStyle`, so its branch
  must come FIRST and key on `checkVisibility`; frames.test had a DEAD
  `getComputedStyle` branch (a legacy frame-offset probe) that would
  otherwise have answered the new probe with `{x, y}`.

## Check commands

Extension (from this repo root):
`npx vitest run`; `npx tsc --noEmit -p tsconfig.app.json`;
`npx eslint src --max-warnings 0`; `npm run build`.

Backend (from `Nymeria/`):
`env -u NYMERIA_PROJECT_ROOT python3 -m pytest tests/test_chrome_browser_tools.py -q`;
`python3 -m ruff check nymeria/tools/chrome_browser.py`;
`pyrefly check nymeria/tools/chrome_browser.py`.
Full suite ONCE pre-commit:
`flock /tmp/nymeria-pytest.lock env -u NYMERIA_PROJECT_ROOT python3 -m pytest tests/ -n 2`.

Mutation reverts: NEVER `git checkout` (files are usually uncommitted);
`cp` originals to `/tmp/mut-backups*/` first and restore from there,
verifying with `diff -q`.

## Tool surface reference

`chrome-tools-reference.md` beside this file is the VERBATIM 13-tool kit
surface (args schema + model-facing docstring per tool), generated from the
live code at backend commit `ed1fdbef` / extension `4705dfb` (v0.6.0,
2026-08-16).
It is a convenience snapshot and can lag `chrome_browser.py`; the code is
the truth. Regenerate after any tool change (from this repo root):

```bash
env -u NYMERIA_PROJECT_ROOT python3 regen.py
```

Then update the commit hashes in this section.

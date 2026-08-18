# CLAUDE.md (nymeria-browser: dev/QA standing info)

Facts that fresh sessions have repeatedly re-derived or tripped over. Trust
this file over memory; update it when a fact changes. It lives in this repo
(moved 2026-08-16 from an operator-local skill) so it loads automatically
when working on the extension.

## Priorities (user-set, 2026-08-16)

Design and review decisions in this stack weigh in this ORDER:

1. **Maximum agent control, functionality, and browser driveability.**
   When a trade-off surfaces, capability for the driving agent wins. Do
   not shave capability to buy anything in tiers 2 or 3 without the user's
   explicit say-so; a reviewer proposing a capability-narrowing change is
   arguing against the number one priority and needs a case strong enough
   to escalate, not silently apply.
2. **Agent best practices.** Clear tool descriptions and schemas, honest
   payloads, and context discipline: no single call may dump a massive
   token count into the driving agent's window (caps, pagination, and
   terse notes exist for this). General agent-UX heuristics live here too
   (refusals that teach the next step, one fact once, stable keys).
3. **Everything else**, including security hardening and human-facing UX
   polish. Real concerns, filed and worked, but they yield to 1 and 2
   when they collide.

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
- A legibility fixture must draw its secret text on a CANVAS. Measured
  2026-08-16: the operator flagged its own "can you read this now" round as
  contaminated, because an earlier `chrome_read_page(detail="full")` had
  already printed the fixture's codes into its context from the
  accessibility tree. Canvas text never enters that tree, so the magnified
  capture stays the only way in.
- The user's external-PC hourly cron agent is PIPELINE PLUMBING ONLY: it
  keeps the pull/rebuild loop smooth, so a stale `version_after` tends to
  self-heal if you wait and retry. It is never an observer. Anything
  needing human eyes (a Chrome banner, what is on screen) still waits for
  the user.
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
  `...-capture-fixture-7.html` (capture-fidelity pass: three 5px codes
  `#tiny-a`/`#tiny-b`/`#tiny-c` that no plain capture can resolve, a
  canvas, a compositor-promoted layer, four fixed viewport-corner markers,
  and a 1400px scroll band so an element sits well below the fold),
  `...-mixed-kind-fixture-1.html` (`#parent-btn`, same-origin
  `#wrapper-frame` -> `...-mixed-kind-wrapper-1.html` with
  `#wrapper-btn`/`#wrapper-input` and an example.org OOPIF `#oopif-frame`:
  an out-of-process frame nested inside a same-process one, so both frame
  kinds are exercised in a single tree), `...-shadow-fixture-8.html`
  (selector pass: `#shadow-btn`/`#shadow-input` in an OPEN root, `#deep-btn`
  in a root nested in a root, `#closed-btn` in a CLOSED one, `.dup-target`
  in BOTH light and shadow, three `.triple` buttons, `#shadow-disabled`),
  and `...-frames-order-8.html` (the frame EMISSION-ORDER case: its first
  same-origin frame is the mixed-kind wrapper holding an example.org OOPIF,
  its second is `...-deep-child-8.html` holding
  `...-deep-grand-8.html#tab2`, so a cross-origin section printed after
  both local ones reads as the second one's child, and the grandchild gives
  a two-deep focus target whose frame URL carries a fragment), and
  `...-worldsteer-fixture-7.html` (transport pass: four MAIN-world lies for
  any read that claims isolation, an `innerText` override, a
  `document.title` override, a `querySelector` redirect to `#decoy`, and an
  `<img name="body">` clobber; honest answers all contain REAL or TARGET,
  every lie contains STEERED or DECOY, and the decoy legitimately appears in
  an UNSCOPED read, so it is a failure only from a scoped `#target` read).
  TRAP, measured 2026-08-16 and corrected same day by #177's live capture:
  an in-frame link to iana.org NEVER navigates. The operative blocker is
  MIXED CONTENT
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
  beat, not a popup click. Snapshot REFS no longer die with the worker
  (v0.10.0, #179): the ref map mirrors into `chrome.storage.session` beside
  the counter and hydrates once per worker life (`refsReady`, awaited in
  `runSingle` before any executor; `clear`/`dropTab` racing an in-flight
  hydration tombstone the tab so a navigated map cannot resurrect). A
  `no-snapshot` refusal now means never-read or navigation-invalidated, and
  the copy says which; mid-QA it is no longer explainable as the recycle.
  Since v0.11.0 (#188) two more facts ride `chrome.storage.session`, both
  storage-only (no hydration gate, health is their one reader): the per-tab
  last-driven stamp (`driveStamp.ts`, written in `runSingle` for every
  tab_id command EXCEPT health) and swallowed-input evidence
  (`delivery.ts`, stamped on a conclusive probe "no", cleared on a proven
  "yes"). Attach state, buffers, dialogs and statusWatch still reset with
  the worker; `chrome_health` says `worker_recycled_since_drive` when its
  stamp predates the worker.
- `chrome_health` (v0.11.0, #188): the one-call tab diagnostic. LOCAL READS
  ONLY by contract: it must never attach (`withSession` forbidden in
  `health.ts`, pinned by a test), or it would flip the capture state it
  reports; `READS_THE_PAGE: false` so it answers under a standing dialog or
  a hung renderer (the cure must not deadlock on the disease). Absent keys
  mean unknown/none, never fine; ages are `age_ms`. Suppression is
  EVIDENCE + the 401/407 inference, never a readable flag (no CDP getter).
  Capture gap honesty (#183): `fireSessionEnd` stamps detach time on every
  path (worker-scoped like `capturedEver`, same-lifetime rule), and the
  shared `commands/captureFlags.ts` sampler gives BOTH `chrome_network` and
  `chrome_console` the started-now/resumed split plus `capture_gap_ms`
  (sample BEFORE the command's own withSession or the lapse is gone).
- Ref lifetime (since stage B, 2026-08-16): frame refs key on the frame's
  STABLE target id and SURVIVE the 10s idle detach (never session-keyed);
  they refuse honestly when the frame left (`frame-gone`) or navigated
  (mint-URL compare). Do not "fix" a stale-looking frame ref by re-keying
  it to a session id. Since the reads-honesty pass (v0.4.0/0.5.0) the same
  token space also covers SAME-PROCESS frames (`Page.FrameId`; no session,
  everything rides the shared one). Since v0.10.0 the whole map is also
  persisted (see the recycle bullet above), which is what makes the
  docstring promise "refs live until the page navigates" literally true.
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
  (`ACTIONABILITY_FN` in `input.ts`), and since v0.8.0 a SELECTOR target gets
  them too, from `SELECTOR_FACTS_FN`, which composes that same body and adds
  the selector-only pair (match count, shadow provenance) on the same call; act.test pins both the zero-extra-round-trips
  property and the one-probe-world-per-act ratchet, so a new probe call is a
  test failure, not a review catch. Pre-dispatch refusals use the payload
  key `refused` (`disabled`, `readonly`, `pointer_events_none`), never
  `reason` (that is the STALE-ref key). act.test's `Runtime.callFunctionOn`
  mock routes by SUBSTRING and the actionability body contains
  `isConnected`, `isContentEditable` and `getComputedStyle`, so its branch
  must come FIRST and key on `checkVisibility`; frames.test had a DEAD
  `getComputedStyle` branch (a legacy frame-offset probe) that would
  otherwise have answered the new probe with `{x, y}`.

- Selector and frame traps (v0.8.0, measured):
  - `document.elementFromPoint` RETARGETS a shadow hit to the HOST and
    `Node.contains` never crosses a shadow boundary, so a hit test run in the
    document refuses a button inside an open root as "covered by" its own
    component. Test the point in the target's OWN `getRootNode()`
    (`HIT_TEST_FN`, `FOCUS_LANDED_FN`). Everything else that hit-tests a
    point (`OWNER_AT_POINT_FN`, `describePoint`, `OPENS_FILE_CHOOSER`) is
    still document-only, deliberately: filed, not forgotten.
  - A CLOSED shadow root is unreachable from EVERY world (encapsulation is
    not world-scoped) and cannot be told apart from "no root at all", since
    `el.shadowRoot` is null for both. Any hint built on that fact has to be
    soft; refs reach closed content because they ride the AX tree.
  - The bounded open-root walk lives in `src/background/shadowWalk.ts`, not
    in a command: two probes need the SAME walk and must agree about it (the
    resolution stops at the first match, the count adds up every match), and
    a count taken over different scopes than the resolution searched is worse
    than no count. It is also the reusable piece for the filed alignment of
    `region_ref` / `scope_selector` / `extract_text`.
  - `Runtime.evaluate` returns primitives ON the RemoteObject even with
    `returnByValue: false`, which is what lets one call return either a node
    handle or a by-value miss marker. Key the branch on `result.type ===
    'string'`, never on the value alone.
  - A thrown expression still returns a `result`: the Error OBJECT, with a
    usable objectId. Check `exceptionDetails`, or an invalid selector
    resolves to an exception and the act proceeds on it.
  - An OOPIF is ABSENT from its parent's frame tree, but its own session's
    root node carries `parentId`: the only place that relationship is on the
    wire. Emission ORDER matters as much as depth, because indentation is the
    tree's only containment signal.
  - `document.activeElement` is the frame OWNER in every ancestor of the
    focused document (so a first-true-wins sweep picks the outermost frame)
    AND is a per-document record that survives its document leaving the focus
    chain (so asking each frame's own parent turns one question into N and
    the first stale yes wins, which sends trusted keystrokes into the wrong
    origin). Ask in the ONE document the focus read names.
  - `Page.Frame.url` is defined WITHOUT the fragment; `location.href` carries
    it. Compare the two fragment-free or the match silently empties.

- Capture traps (v0.7.x, every one measured, several the opposite of what
  reasoning predicted):
  - `fromSurface: false` is REFUSED for an extension's debugger session
    (`{"code":-32000,"message":"Only screenshots from surface are allowed."}`);
    Chromium allowlists it to one extension. It also points the wrong way,
    being the OS window-grab path from a trusted client, so it NEEDS the
    window on screen and ignores `clip`. Do not reach for it again.
  - `clip` is DOCUMENT space, not viewport space. A viewport-space rect
    captures the wrong place, or pure white. Add the scroll offset and clamp
    to `cssContentSize`.
  - An off-surface clip returns a SUCCESSFUL capture of one flat colour with
    no error at all, which is why the backend flags a single-colour image.
  - `captureBeyondViewport` permanently reflows the live page (layout
    viewport 1353 -> 1368, scrollbar gone) until the tab navigates. Spend it
    only when the box is not entirely on screen; `full_page` always pays it,
    and both disclose it (`[Reflow]`).
  - Report the viewport as `window.innerWidth/innerHeight`, NOT
    `cssVisualViewport.clientWidth/Height`: the 15px scrollbar is inside the
    captured image and outside that CSS box, so the narrower number puts
    ~23px of error into an image-to-coordinate conversion at x=1200. Zoom
    comes only from `getLayoutMetrics`.
  - Chrome rounds the clip box before rendering, so a fractional element box
    returns a few pixels off `width x scale` (measured: 244 where 248 was
    predicted). The backend's did-Chrome-actually-clip cross-check is
    therefore RELATIVE (5%), not an absolute pixel window.
  - Backgrounded-tab capture is not slow and not stale: ~1.3s with live
    pixels, canvas and composited layers included, through the tool and
    through raw CDP. The old "backgrounded tabs capture badly" premise did
    not reproduce on this Chrome.
  - An image over 2000px on either side 400s the whole turn on a many-image
    request, and the image stays in the transcript, so every later turn in
    that thread fails the same way: it BRICKS the thread, not the turn. A
    tall `full_page` is a turn-killer until the image-ceiling slice lands
    (backlog 03, downscale-to-fit). Width bites too, and window width varies
    per window, so a short page is not a safe full page.
  - Driving a tab shortens its viewport by 56 CSS px, a command or two in.
    That is Chrome's "being debugged" infobar, measured decisively 2026-08-17
    on one fresh tab: `getLayoutMetrics` said 981 tall, the capture said 925
    and its image agreed, and a second `getLayoutMetrics` had moved to 925.
    So a metrics read taken as the FIRST touch on a freshly driven tab is the
    stale number, and the capture's own geometry is the current one. Two QA
    rounds were spent suspecting the tool over this; the pattern generalizes,
    an agent's own pre-capture control is the thing to doubt first.

- Transport traps (v0.9.x, measured): the SSE journal is BOOKKEEPING and must
  never sit in front of a dispatch. Journalling first cost the extension every
  upload over ~7.5MB (`chrome.storage.local` is capped at 10MB, an over-quota
  `set()` REJECTS, and the rejection ate the command), and it surfaced as a
  backend transport timeout blaming a suspended page, so the symptom pointed
  nowhere near the cause. `connection.ts` dispatches first and journals after,
  fire-and-forget with its own log line; `state.ts` redacts long strings and
  `persist()` swallows its own failures, because one oversized entry left in
  `current` would otherwise reject the status writes `connectOnce` awaits and
  take the stream down with the bookkeeping. Capture honesty answers from the
  SESSION layer, never the buffer: `everAttached` (set in `doAttach`, dropped
  on tab close) splits "never watched" from "watching lapsed", and keying it
  on buffer contents instead would call a cleared tab, or a driven tab that
  made no requests, tabs nobody ever watched. `limit: 0` means ZERO in both
  buffers now, and because it does, a cut read must report `matched_total`
  (counted AFTER the filters) or truncation reads as absence. Note composers
  on the backend read their flags as identities (`is True`), never for
  truthiness: the payload is extension-supplied and a stray string must not
  switch on a claim that renders outside the untrusted fence.
- `chrome_read_text` reads in the isolated probe world (v0.9.0). A world alone
  is not enough there: named DOM properties are real DOM and follow the read
  into it, and both `Document` and `HTMLFormElement` let a named element
  SHADOW a built-in, so `<img name="body">` clobbers `document.body` in any
  world. Every accessor goes through its prototype descriptor, and a non-HTML
  root reads `textContent` (`innerText` is not on its prototype). The QA gist
  carries `nymeria-qa-worldsteer-fixture-7.html` for this: four steering
  attempts (innerText, title, querySelector redirect, body clobber) whose
  honest answers all contain REAL or TARGET. STOPGAP living in three places
  until the selector-alignment pass lands: the selector-miss error, the
  `extract_text.ts` module docstring, and the `chrome_read_text` row in
  `tools.md` all say that `css=` acts walk open shadow roots while this read
  does not. Remove them together.

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

`chrome-tools-reference.md` beside this file is the VERBATIM 14-tool kit
surface (args schema + model-facing docstring per tool), generated from the
live code at backend commit `b8c46d30` / extension `1183ccd` (v0.11.1,
2026-08-18).
It is a convenience snapshot and can lag `chrome_browser.py`; the code is
the truth. Regenerate after any tool change (from this repo root):

```bash
env -u NYMERIA_PROJECT_ROOT python3 regen.py
```

Then update the commit hashes in this section.

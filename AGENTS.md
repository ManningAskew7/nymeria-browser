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
  remains in the ordinary loop. Since #223 (backend, 2026-08-22) a
  tab-free `chrome_health` reports the ANNOUNCED build and its age with
  NO dispatch, so the driver can poll for the rebuild's announce cheaply
  before firing the reload; it proves subscription, not execution, so
  `version_after` stays the execution-grade confirmation. Bump the
  manifest version each shipped
  pass: `version_after` in the reload result is the build confirmation,
  and a stale value means the rebuild has not landed yet (measured
  2026-08-16: 3 minutes was once not enough; wait ~2 more and retry the
  reload rather than QA'ing old code). The 3 minutes are the QA driver's
  wait, NOT the thread agent's: measured 2026-08-20, a reload fired ~70s
  after the push returned the OLD version and the extension then went
  disconnected and stayed there, because the rebuild swapped files under a
  running extension. So do the waiting BEFORE dispatching the round, and
  never write a round that says "reload, and if the version is stale wait
  and reload again": the retry lands inside the rebuild window, which is
  the one place a reload can strand the thing it is trying to refresh. A
  stranded extension cannot be revived by the reload tool, so this costs a
  manual reload at chrome://extensions and blocks QA until the user is
  around, which on an unattended loop can be hours. Same fallback applies
  to a build that fails to load.
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

- **ALWAYS dispatch with `nymeria_chat_background`, never plain
  `nymeria_chat`.** A QA round routinely runs ten to twenty minutes and plain
  chat dies at 300s. Then know the second half, because the workaround does
  NOT escape the ceiling it exists for: `nymeria_chat_collect` blocks silently
  and Claude Code aborts any MCP tool that is silent for 300s (#199).
  Measured 2026-08-20: a collect died at exactly 300s while `/status/turns`
  showed the turn healthy at 328s and climbing, and Claude Code
  auto-backgrounding the call did NOT save it, because the abort is on
  transport silence rather than on foreground-ness. The fix is a per-server
  `"timeout"` in the repo `.mcp.json` (set to 30 min; it is read at startup,
  so a session that predates it still has the old ceiling). Without that,
  poll `GET /status/turns` under the ceiling and read the result from history.
- **Collect per ROUND, not once at the end.** A long round can trip
  auto-compaction, which removes the messages from retrievable history: the
  final report then cannot be read back at all and has to be re-requested.
  (The thread agent survived this correctly by writing state to its notepad
  first, but the transcript was still gone.)
- QA thread: `38e2c63c` (title "[QA session: browser extension update...]"),
  via the `nymeria` MCP, verbosity "concise". IDs rotate, `45ae4224` carried
  the 2026-08-20 pass; treat these as examples, not as live pointers. Reuse
  one: it
  holds the running QA history (#168 fused waits, nav honesty, #175
  http_status, budget, batched upload, #160 worlds/refs, OOPIF input). The
  driving agent there is capable; give it one focused round per message and
  have it quote payload fields. A FRESH thread is fine (and better when the
  user may be working in that one): the actionability pass ran on `01f4dec8`
  with no loss, since each round carries its own fixture and expectations.
  Set the model on a new thread (`/model claude-opus-5 thread`); a fresh
  thread otherwise inherits the default, which is not the QA-grade one.
- After an extension push, the round starts with `chrome_reload_extension`
  (see the deploy flow above) so QA always runs the just-shipped code. A
  round measuring ALREADY-shipped behavior opens with it too: measured
  2026-08-21, the running build was a day stale (#233's zoom action erroring
  as unknown) because nothing reloads the user's Chrome until a round does.
- Verify the round RAN on the model you set (`context_stats.model`): a
  thread whose turns failed during a provider outage can wedge onto the
  fallback model while `/model` still shows the override (backlog #236,
  measured 2026-08-21; a haiku-driven round misread its own instructions).
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
- Fixture catalog for ROUND PROMPTS (#235, 2026-08-22): the main repo's
  `Nymeria/docs/private/browser-qa-fixtures.md` lists every `nymeria-qa-*`
  gist page with its inventory in paste-able rows, plus the known fixture
  gaps. The DRIVEN agent cannot discover fixtures on its own (its
  filesystem is the container's), so a round that needs one carries the
  URL and inventory in the prompt, or the catalog is seeded into the QA
  thread's notepad once. Keep the catalog and this file's traps in step
  when adding a fixture.
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
  an UNSCOPED read, so it is a failure only from a scoped `#target` read),
  and `...-rerender-fixture-9.html` (the negative ref round: `#morph-btn`
  relabels IN PLACE via `#morph-now`, "Confirm order" -> "Delete
  everything", same node so the fingerprint must refuse `changed`;
  `#swap-btn` is node-REPLACED by a lookalike via `#swap-now`, refusing
  `unknown-ref`; `#stable-btn` is the control; `#abort-fetch` mints a
  cross-origin `canceled` failure for the routine-noise class (the fixture
  for `failed_requests_benign_omitted`; the `likely_benign` payload key it
  was built against is gone since #220); status
  lines start `*-untouched` per the fixture-6 convention).
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
  replacement. Commits need a `Co-Authored-By:` trailer naming the model that
  actually did the work (`<noreply@anthropic.com>`). This line used to pin
  "Claude Fable 5" and went stale the moment the driving model changed; the
  live history is the reference, not this file.
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
  Caddy HTTPS, or the SSH-tunnel + localhost fallback.
- The extension ID is PINNED to `hfjpeeimhfbkpidpeabpdppddahckhgp` (manifest
  `key`, since v0.25.0; private key host-local in
  `~/nymeria-browser-keys/`, never in this repo). A pre-pin install is a
  DIFFERENT extension to Chrome: remove + re-load unpacked once, then
  re-Connect and re-grant page status. Backend CORS accepts any
  well-formed extension origin by pattern since backend 2026-08-28
  (measured: ungranted SW fetches follow ordinary CORS, granted ones
  bypass it entirely; `Nymeria/tests/test_cors_extension_origin.py` pins
  the server side).
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
  Since v0.11.0 (#188) more facts ride `chrome.storage.session`, all
  storage-only (no hydration gate, health is their one reader): the per-tab
  last-driven stamp (`driveStamp.ts`, written in `runSingle` for every
  tab_id command EXCEPT health), swallowed-input evidence (`delivery.ts`,
  stamped on a conclusive probe "no", cleared on a proven "yes"), and
  since v0.13.1 (#202) its positive twin, the delivery-proof stamp
  (`nymInputOk:`, also `delivery.ts`): written on EVERY trusted
  `delivered === 'yes'` (context-gone included, carrying the PRE-nav URL
  and the pre-action commit seq; synthetic never stamps), cross-cleared
  with the swallow store both ways, cleared on tab close. Its `navSeq` is
  per-worker navWatch memory, so health omits `on_current_url` for a
  stamp older than the worker (do not "fix" that by persisting the seq).
  All three stamps ride the `sessionStamp.ts` factory (#204): stores are
  side-effect-free, the two cross-clears sit adjacent at the act.ts
  verdict site, and reader-side age gating stays in health.ts by design.
  Attach state, buffers, dialogs and statusWatch still reset with
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
  (sample BEFORE the command's own withSession or the lapse is gone); the
  same sample backs `capture_active: true` on warm reads (v0.13.0, #202),
  which claims live-at-THIS-read, never continuity. `input_ok` (#202)
  surfaces the delivery-proof stamp (recycle bullet above) with age,
  action, url and `on_current_url` = DOCUMENT identity: url match AND
  `commitSeq(tabId) === stamp.navSeq`; false is the normal navigating-
  click reading (proven on the page it was sent from), and a doc-level
  container ref degrades synthetic with a reason that says nothing
  specific was clicked. Normally at most one of input_ok/input_swallowed
  appears (two sequential storage reads; smaller age_ms wins).
- Delivery evidence is deterministic and teardown-proof (v0.14.x, #180):
  the probe's read yields one macrotask IN the page, conditional on a
  pending `defaultPrevented` sample (hidden tabs throttle timers to ~1s,
  so the yield must stay conditional), and the arm expression PUSHES its
  snapshot after every trusted event over a `Runtime.addBinding` channel
  (`__nymDeliveryPush`, `executionContextName`-scoped to the delivery
  world, installed per arm, uncached BY DESIGN: bindings die with the
  debugger session). Probe ids carry a per-worker tag and push slots key
  on tab+id; a held push rescues a non-context read failure into a
  proven yes. `dom_mutations` is the SAME probe's MutationObserver,
  armed with the arm (before dispatch, so synchronous handler reactions
  count: QA measured the settle-window version blind to them), watching
  the ACTED document, surviving the read (the registry entry dies at
  the post-settle `tally()`, not at read), absent on navigating acts by
  construction. Settle is quiescence-ONLY: do not put a tally back
  there (it leaked the destination document's count, measured live).
  Test traps: the settle-probe marker in mocks/filters is `readyState`,
  NOT `MutationObserver` (the arm contains one too); the delivery mock
  serializes evaluate results like `returnByValue` (by-reference peeks
  alias live counters and defang merge tests).
- `resolved_frame` (v0.12.0, #201): act payloads attribute the frame the
  TARGET RESOLVED into; `focused` is state, never attribution (hover and
  scroll_to do not move it). Carriage is the post-resolution facts bag
  (`selectorFacts`), set ONCE after resolution so every later exit,
  refusals included, carries it; do not hand-spread it per exit (the
  review round removed exactly that shape). Absent on a target-backed act
  means ROOT; coordinates unknown; the drag-dest fingerprint refusal
  deliberately omits it (its `target` names the SOURCE). Keyboard claims
  come only from CDP frame records (the in-page focus read truncates to
  200 chars and only routes the confirmation); an unconfirmed frame
  claims nothing. `Target.targetInfoChanged` keeps the frame map's URLs
  current (without it, attach-time URLs misattribute in-place navs AND
  refuse fresh refs as `navigated`). Same pass: cross-origin
  `canceled`/`ERR_BLOCKED_BY_CLIENT` failures with status < 400 are the
  routine-noise class; same-origin/unparseable/error-status never join it.
  Since #220 (v0.20.0) that class is OMITTED from act payloads rather than
  ranked last inside them, and rides as `failed_requests_benign_omitted`
  = `{count, hosts, errors, hosts_omitted?}`. Ranking it last just let it pad
  whatever the cap of 5 had spare, so a retail click spent all five slots on
  ad pixels (~6,000 chars, measured). Dropping it cannot evict a real
  failure, since a real one always outranked it: that is the argument to
  re-make if anyone proposes un-omitting. The HOSTS are the load-bearing
  half and v0.18.0 shipped without them for half a day: the class keys on an
  EXACT origin compare, so a site's own `api.*` subdomain is cross-origin to
  its `www`, and the agent's own POST canceled by the navigation it
  triggered (no status, so no >=400 rescue) classifies as noise. A bare
  count made that indistinguishable from an ad pixel, which is the Place
  Order case the item came from. Do not "simplify" the hosts away.
  `chrome_network` reads the same buffer unfiltered and is the way back to
  the entries, though it exposes no `since`, so the reread cannot be scoped
  to the act's window. `errors` exists because QA measured the hosts-only
  cut and said the key "says benign but never says WHY, so I have to take
  the extension's word for it": the kinds are what let an agent re-judge the
  classification instead of trusting the label. A summary with NO
  `failed_requests` beside it is the ordinary commercial-page shape, never
  "nothing failed". Three more from the same pass. `failed_requests_total`
  appears when the CAP cut the real list, which nothing said before, and
  five-of-nine read as all nine especially beside a summary that counts what
  IT dropped. `FAILURE_RANK_POOL` is gone (newest 50, applied BEFORE
  classification, so a burst of noise starved older real failures out of the
  ranking that exists to protect them); the buffer's own `MAX_PER_TAB` is
  the bound. And both PRE-DISPATCH refusals (standing dialog, unresponsive
  renderer) now pass the real page URL: they passed `null`, which made every
  origin unknown, so nothing classified as noise and the payload carried the
  full ad-pixel list with the summary ABSENT, meaning "nothing omitted", on
  the two paths where diagnostics are all the agent has. `currentUrl` is a
  `chrome.tabs.get` and never touches the renderer, so it is safe to read
  before those gates. Since #203
  (v0.15.x) resolved_frame is THREE-state: absent=root, null=frame
  located with an empty URL, string=live URL; both emission sites
  (target-backed + confirmed keyboard) guard `!== undefined`, never
  truthiness.
- Scroll (v0.15.0-0.15.2, #203): scroll is in OPTIONAL_TARGET; a ref
  wheels AT the element's VISIBLE-region centre on its own session
  (off-viewport refuses: wheel input is positional; deliberately NO
  scrollIntoView, it would move the offsets being measured).
  `scroll_moved` reads the SAME registered scroller elements twice
  (`__nymScroll` probe-world slots; a re-walk can subtract two different
  containers): container delta when it moved, else document (a bottomed
  pane CHAINS), measured {0,0} vs absent; a targetless wheel point over
  an embedded frame WITHHOLDS zeros (QA-measured false zero). All
  document.* reads in the scroll probes ride the prototype-CHAIN getter
  (happy-dom lacks the getters on Document.prototype; instance own-props
  and the named getter are the forgery surfaces). Test traps: baseline
  and after-read are DISTINCT mock fixtures on distinct markers
  (`__nymScroll` + `scrollingElement` = baseline, `__nymScroll` alone =
  after); the `__nymScroll` evaluate route must precede
  `elementFromPoint`'s. Measured: root-session wheels DO reach OOPIFs by
  position, unlike clicks. Since v0.15.3-0.15.5 (#207) the wheel ACK is
  not load-bearing: Chromium never acks a coalesced-away wheel (source-
  confirmed) so trustedWheel resolves acked/timeout (only
  InputDispatchStalled tolerated; other rejections propagate), the
  payload says `wheel_ack: "not_received"` (absence = acked; no live
  sighting yet, unit-proven), a per-widget latch drops later wheels to
  500ms and DIES WITH THE WIDGET (index.ts onCommitted/onRemoved clear
  it), and `stall_at` names which stall gate raised. Every other
  Input.* dispatch keeps its load-bearing ack. The ack is not a
  MEASUREMENT signal either: gating scroll_moved's zero on it was tried
  for one unreleased version and re-broke this very entry, since a
  latched widget loses acks routinely while its offsets read perfectly
  well (see the freshness bullet).
- Ref lifetime (since stage B, 2026-08-16): frame refs key on the frame's
  STABLE target id and SURVIVE the 10s idle detach (never session-keyed);
  they refuse honestly when the frame left (`frame-gone`) or navigated
  (mint-URL compare). Do not "fix" a stale-looking frame ref by re-keying
  it to a session id. Since the reads-honesty pass (v0.4.0/0.5.0) the same
  token space also covers SAME-PROCESS frames (`Page.FrameId`; no session,
  everything rides the shared one). Since v0.10.0 the whole map is also
  persisted (see the recycle bullet above), which is what makes the
  docstring promise "refs live until the page navigates" literally true.
- Ref MINTING is interactive-only at EVERY detail level (snapshot.ts
  formatTree: `isInteractive(node)` gates the mint; `detail="full"`
  shows static nodes but still mints nothing for them), and
  `chrome_find` can only cite minted refs, so its miss copy fires on
  text plainly present in the tree. An all-static page (fixture 11)
  mints only RootWebAreas BY DESIGN: that shape produced two false
  "frame mint gap" filings before the root-document control settled it
  (#205 closed invalid 2026-08-18). Before filing any mint finding,
  run the same-shape control in the ROOT document. Document roots mint
  through the `focusable` property, not the role list, so `ref_count`
  alone overstates: since #208 the payload also carries
  `control_ref_count` (refs minus document roots), which is what the
  backend header counts and what triggers its one "nothing here is
  clickable" note. Keep that count structured; the backend must never
  derive it from tree text, which is page content and could forge a
  ref-shaped line into the region outside the fence.
- Scrolling a pane that mints no ref (#208): `css=` targets already
  worked and nothing said so; inside a frame, where selectors cannot
  reach, the frame's own document ref is now the handle. A DOCUMENT
  target (nodeType 9) wheels at that document's own viewport centre on
  its own session and watches the scroller under that point, so an
  in-frame pane scroll is VERIFIED, not silent. Cross-origin only: a
  same-process frame's document ref is refused EXPLICITLY (its point is
  frame-local and a Document's quads describe the whole document, not
  the viewport, so composing would wheel where nothing was watched;
  the first cut left that to whatever `getContentQuads` returns, which
  a review round flagged as an assumption whose failure mode is a
  mis-aimed trusted wheel). The over-frame withhold now covers the
  targeted path AND both zero branches: watching the pane under the
  point (which is what lets a coordinate wheel finally measure what it
  moved) re-opened the false zero through `cd` for an iframe inside a
  scrollable pane. Scroll metrics ride a prototype-chain read on BOTH
  sides of the baseline/after pair: a mismatched pair would subtract
  two different quantities into a fabricated delta, and named-property
  access (`<form><input name="clientHeight">`) is the forgery an
  isolated world does not stop. Test note: `metrics()` in act.test
  stages values as per-element PROTOTYPE accessors for that reason;
  own-property stubs would leave the hardened read untested and
  happy-dom's own Element getters shadow them anyway.
- Scroll measurement is WATCHED, not sampled (v0.16.1, #210). Two live
  findings drove it. (1) A window that is minimised, covered or
  backgrounded stops painting and its offsets lag: QA measured three
  confident {0,0}s against a page that had moved 500px. (2) A
  BACKGROUNDED TAB HOLDS ITS WHEELS: QA wheeled a hidden tab three times
  (no movement at all, ground truth flat), and all 1500px landed the
  moment the tab was shown, long after those acts answered. QA verified
  the shipped fix the same way (three backgrounded scrolls, each
  `not_rendering` with no number, then 500 + 3x500 = 2000 exactly on
  activation): a held wheel is SPENT, so an agent that resends one it
  thinks failed lands both, which is what the copy now warns about. So
  the after-read waits for two animation frames (`awaitPromise` forwarded
  through `evaluateInProbeWorld`, which settle.ts already proved on the
  same sendCommand), and a page that rendered but shows NOTHING gets a
  second look 150ms later; only a zero pays that cost. A hidden page
  short-circuits both waits, because it services no frame callbacks and
  is where timers are throttled hardest. What the frame proof does NOT
  cover: a wheel still queued behind the page's own handler, and a
  smooth scroll mid-flight (the second look narrows both).
  `requestAnimationFrame` comes from `Window.prototype`'s own descriptor,
  NOT a chain walk: named properties sit on WindowProperties, which
  PRECEDES Window.prototype, so a chain walk would find
  `<img name="requestAnimationFrame">` first (the opposite of the element
  metric rule, where the accessor is the deepest thing on the chain).
  Payload: a zero means at-rest; an unrendered page's zero is withheld
  with `scroll_unmeasured` (closed enum: over_frame, not_rendering,
  no_frame, read_failed, budget_spent), and its DELTA still reports
  tagged `scroll_stale` (deleting a real delta would leave an agent
  driving a background tab with no scroll feedback at all, which both
  review rounds pushed back on). Test traps: act.test's after-read
  fixtures default to `fresh: true`, so a test meaning "never rendered"
  must say `fresh: false`; frames.test stages its own inline fixtures and
  needs the same fields; and a not-fresh case staged at the MOCK pins the
  ladder, not the measurement, which is how a review round deleted the
  whole frame wait with all 861 tests still green (the in-page probe
  tests are the ones with teeth there).
- Known residual (#208, not a regression): the point-based walks start
  from `Document.prototype.elementFromPoint`, which retargets a shadow
  hit to the HOST, so a scroller INSIDE an open shadow root is not
  found and the wheel reads as a document zero. Pre-existing for
  coordinate wheels and inherited by the document-ref route. Fix it
  with the other point predicates (`HIT_TEST_FN` already pierces),
  filed as backlog #209, not one-off here.
- Reads-honesty traps (v0.5.0, measured): the same-process occlusion gate
  must test the OUTERMOST local ancestor's owner (`LocalFrame.path[0]`),
  never the immediate one, and must SKIP (fail open) when no ancestor
  chain is readable; both wrong forms deterministically refuse every
  nested-frame act as covered by its own ancestor. Same-process dispatch
  points come from `DOM.getContentQuads` on the element's OWN session
  (backendNodeIds are per-process; root-session quads for a
  nested-in-OOPIF node describe the wrong element). act.test's wait
  mocks route on the literal `innerText.includes` at FIVE sites (count
  them fresh with grep in act.test.ts; a hardcoded count and line list
  both went stale here) and
  three extract the needle from the scan expression's
  `var NEEDLE = "..."` binding and THROW on shape drift: changing
  `waitTextExpression`'s shape means updating every site, and all of them
  return booleans, so a scan that returned anything else breaks them all.
- Wait miss report (v0.24.0, #196): a timed-out TEXT wait runs ONE extra
  probe-world evaluate (`waitMissReportExpression`) whose payload keys are
  `page_text_excerpt` (root document, whitespace-collapsed, 240 chars,
  sliced PAGE-side) and `found_case_insensitive` (present only when true;
  the ci scan descends same-origin frames but no OOPIF sweep, a bounded
  blind spot taken for one round trip). The expression deliberately does
  NOT contain the literal `innerText.includes` (the five mock sites above
  would swallow it) and mocks route it on its own `MISS_REPORT` marker,
  which must stay BEFORE act.test's `querySelector` branch (the ci scan
  contains `querySelectorAll`). Matching semantics unchanged: exact,
  case-sensitive, per decision. The backend's [Fill note] (#217) keys on
  `action == "fill"` + `dom_mutations == 0` + delivery not "no", so
  changing `PROBE_EVENTS.fill` or the tally's verb-agnostic read changes
  what that note fires on.
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
    to `cssContentSize`. The ECHOED `region.x/y` is therefore document space
    too, under the same key name as the viewport-space `region` ARGUMENT,
    which is the mis-aim trap #194 closed: `chrome_act` takes viewport px, so
    a point in a crop needs divide-by-scale, add-origin, SUBTRACT-scroll, and
    only the first two were discoverable. The backend now publishes that
    composed (`region.x - scroll.x`) as a `[Frame]` line. It is WITHHELD when
    the capture reached off screen, because that pays `captureBeyondViewport`
    and reflows the page the frame is measured against, mid-capture: the same
    reason `full_page` never gets one. Do not "simplify" that guard away, and
    do not publish a frame beside a `[Reflow]` line.
  - `clip` is documented in DEVICE INDEPENDENT px, while `getBoundingClientRect`,
    `getContentQuads` and `scrollX` are CSS px. `cssVisualViewport.zoom` is the
    documented conversion. CONFIRMED live and FIXED in v0.23.0 (#231, measured
    2026-08-21: a ref-measured element at 150% came back as blank margin,
    content ~1/1.5 toward the origin, while the PNG size check passed
    cleanly). The multiply lives at ONE seam, the `cdpClip` built beside the
    `Page.captureScreenshot` call: `clampToContent` and the beyond-viewport
    test upstream are CSS-px comparisons, and the ECHO stays CSS px because
    the backend's `[Frame]` composes `region.x - scroll.x` in CSS. The echo
    carries `clip_zoom` (the folded factor; null when zoom was unreadable, in
    which case the clip goes out UNMULTIPLIED and the backend withholds the
    frame rather than trust the aim; never default a null zoom to 1). The
    same measurement settled #227: devicePixelRatio folds NOTHING into a
    clipped capture's output, the PNG is sent-clip x scale exactly. Two
    contracts the backend now rests on: its frame verdict requires
    `clip_zoom` to EQUAL the payload's top-level zoom, which holds only
    because both are the one `getLayoutMetrics` read (never split those
    sources); and `autoScale`'s 1600px budget is OUTPUT px, so the fold
    divides what fits (explicit `region_scale` is only clamped, unchanged).
    `chrome_tabs(action="zoom")` (#233, v0.22.0) is per-TAB and temporary on
    purpose, since Chrome's ordinary zoom scope is per-origin and would
    permanently rewrite the user's preference for the whole site.
  - NEVER express a capture-derived conversion as a factor of the returned
    PNG's pixels. The backend downscales any image past the model's ceiling
    (2000px on every model checked) before the model sees it, and `autoScale`'s
    `REGION_SCALE_FLOOR = 2` overrides its own 1600px budget, so a magnified
    crop is the shape MOST likely to be downscaled: measured, 3200x2400 is
    delivered at 2000x1500. A first cut of `[Frame]` published
    `origin + image_x/scale`, went green, and mis-aimed by up to 285x210 CSS
    px while reporting success. The frame is therefore stated as the CSS BOX
    the image covers, read by relative position across it, because a
    proportion has no ratio a resize can invalidate.
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
    predicted). The backend's did-Chrome-actually-clip cross-check is an
    ABSOLUTE window sized to that rounding, `max(4, 2 x scale x clip_zoom
    + 2)` per axis (it was relative 5% until the #194 review made it gate a
    coordinate frame; a 5% window on a wide box was real mis-aim).
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
- A READ takes its HTTP status from the DOCUMENT, not from statusWatch
  (`docStatus.ts`, #187, whose docstring carries the derivation). statusWatch
  stays the NAVIGATION answer; for a read it needs the host grant, dies with
  the worker, and has to be JOINED back to the document, where a same-URL
  reload whose response has landed but not committed attributes the NEW status
  to the OLD text. Traps: it is the tab's MAIN document even on a scoped read
  (no scope can falsify that, unlike the frame and control counts); it survives
  a pushState with its ORIGINAL value, so an SPA that 404s its shell and then
  routes to real content still reports 404; and because `chrome_read_page`
  needs several round trips, a commit between the tree and the probe withholds
  it (`withProbeWorld` rebuilds its world in the new document, so the wrong
  answer would be silent).
- `GLOBAL_READ_SNIPPET` (`worlds.ts`) is the ONE way a probe body reads a
  global: own descriptor first, `Window.prototype` second, never bare and never
  by chain walk, because `<img name="x">` writes into the WindowProperties
  object which precedes Window.prototype. Measured 2026-08-19: `performance`,
  `getComputedStyle` AND `requestAnimationFrame` are all OWN properties of the
  probe world's global and none is on `Window.prototype`, which is why
  `act.ts`'s rAF read moved onto this helper (its old prototype-first lookup
  never matched in Chrome, so the fallback it called "the test environment's
  path" was production).
- The text read COUNTS what it could not carry (`text_dropped_generated`,
  #190; `TEXT_DROPPED_SNIPPET`'s docstring carries the measurements). Traps a
  fresh session cannot re-derive: hidden elements STILL report generated
  content, so the element gate is required, and it gates on
  `checkVisibilityCSS` ALONE because `innerText` KEEPS an `opacity: 0`
  element's text; the pseudo has its own box, so a `display: none` ::after is
  no loss; computed `content` QUOTES literals and RESOLVES `attr()` but leaves
  `counter()` alone, and `image-set(url("a.png") 1x)` carries a quoted
  FILENAME, so only quoted runs at paren depth ZERO count as text; the scan
  includes the ROOT (querySelectorAll is descendants-only) and caps at 5,000
  elements, which makes the count a floor. The text itself is UNCHANGED:
  inline markers would mean rebuilding innerText's layout rules, trading a
  fidelity regression on every page for a fix on some. Fixture
  `nymeria-qa-glyph-fixture-13.html` carries all six loss mechanisms.

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
live code at backend commit `dc00bad7` / extension `fcc41ed` (v0.24.0,
2026-08-28).
It is a convenience snapshot and can lag `chrome_browser.py`; the code is
the truth. Regenerate after any tool change (from this repo root):

```bash
env -u NYMERIA_PROJECT_ROOT python3 regen.py
```

Then update the commit hashes in this section.

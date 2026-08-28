# nymeria-browser

Chrome Manifest V3 extension that acts as a thin client over the Nymeria personal-assistant API.

It gives the agent control of the user's real, logged-in Chrome: a persistent SSE connection carries `browser_command` events down, and the extension drives the page over the Chrome DevTools Protocol and posts the result back. The backend half is the `chrome_*` tool family (`Nymeria/nymeria/tools/chrome_browser.py`) and the `browser-control` skill kit.

The reason it is an extension rather than a headless engine: it drives the browser the user is already signed into, and the user can watch it happen, including over the internet on a remote instance.

## Architecture

```
Popup (React)  ──messages──►  Background service worker  ──fetch + ReadableStream──►  Nymeria API
                                       │                                                   │
                                       └─── chrome.storage.local (config + snapshot)       └─── /autonomous/stream (SSE)
```

- **Auth:** `Authorization: Bearer nym_…` against the user's personal Nymeria token (issued via `POST /me/tokens` on the backend).
- **Push channel:** `/autonomous/stream?client_id=<ext-instance>` — same per-user firehose the desktop and mobile apps consume. The `client_id` round-trip prevents the extension from receiving the echo of its own publishes (none yet — relevant in Phase 2).
- **Reconnect:** exponential backoff with jitter, 1s floor, 60s ceiling, resets on the first successful event.
- **SW lifecycle:** an SSE in-flight `fetch` keeps the service worker alive. A `chrome.alarms` heartbeat re-establishes the connection if the worker is recycled. The period is 1 minute because that is Chrome's floor for a packed extension; asking for less does not go faster, it just makes the real interval a surprise.
- **Page control:** `chrome.debugger` (CDP), not content scripts. Input goes through `Input.dispatchMouseEvent`/`dispatchKeyEvent`, so events carry `isTrusted: true` and survive the payment and anti-bot layers that reject page-synthesized clicks. Out-of-process iframes are reached with flattened `Target.setAutoAttach` and per-frame `sessionId`s.

## Project layout

```
src/
├── background/
│   ├── index.ts        SW entry, message router, lifecycle hooks
│   ├── connection.ts   SSE loop + reconnect state machine
│   ├── api.ts          fetch helpers (ping, whoami, result POST)
│   ├── sse.ts          pure SSE frame parser (unit-tested)
│   ├── state.ts        snapshot persisted to chrome.storage.local
│   ├── debuggerSession.ts  ref-counted CDP attach, event router, frame registry
│   ├── input.ts        trusted input primitives + hit testing
│   ├── settle.ts       post-action DOM quiescence probe
│   ├── snapshotRefs.ts frame-scoped @eN ref table: monotonic per-tab numbering (storage.session-backed), merge semantics, mint fingerprints, typed staleness reasons (#160)
│   ├── worlds.ts       isolated-world creation/cache per (tab, session, name); trust probes and element handles live in nymeria_probe (#160)
│   ├── urlMatch.ts     shared URL trust comparisons: sameResource (fragment-blind) and sameDocumentUrl (hash-routes count as moving)
│   ├── frameTeardown.ts  per-frame WORLD teardown on Target.detachedFromTarget (refs survive: they key on the frame's stable target id)
│   ├── consoleBuffer.ts / networkBuffer.ts   CDP capture, filled from attach
│   ├── navWatch.ts     per-tab navigation lifecycle from webNavigation events
│   ├── statusWatch.ts  last main-frame HTTP status per tab via webRequest (#175; needs the runtime host grant)
│   ├── budget.ts       per-command wall-clock budget vocabulary (#162)
│   ├── dialogs.ts      Page-domain dialog ownership + answering policy (#169)
│   ├── delivery.ts     input-delivery probe in its own isolated world (policy here, world machinery in worlds.ts)
│   └── commands/       one executor per wire command type
├── popup/
│   ├── Popup.tsx       connection form + live status card
│   ├── main.tsx        React entry
│   └── styles.css
├── shared/
│   ├── messages.ts     typed popup ↔ background contracts
│   └── types.ts        ConnectionStatus, MeResponse, AutonomousEvent
├── utils/
│   ├── logger.ts
│   ├── security.ts     AES-GCM encrypt/decrypt
│   └── storage.ts      config get/set + clientId
└── __tests__/
    └── setup.ts        chrome.* + storage mocks for vitest
```

## Develop

```bash
npm install
npm run build   # → dist/
npm run dev     # vite dev server (for popup HMR — service worker still needs build)
npm test        # vitest
npm run lint
```

Load the unpacked extension from `dist/`:

1. Open `chrome://extensions`, enable Developer Mode.
2. Click **Load unpacked** and pick the `dist/` directory.
3. The extension ID is `hfjpeeimhfbkpidpeabpdppddahckhgp` on every install:
   the manifest pins a public key (since v0.25.0), so the ID no longer
   depends on the install path. If you installed a pre-v0.25.0 build,
   Chrome treats the pinned build as a NEW extension: remove the old
   entry, load unpacked again, then reconnect and re-enable page status
   (one-time migration).

## Connecting to a Nymeria backend

**The backend must be `https://` or on `localhost`.** Chrome only lets an
extension request permission for origins its manifest declares, and this one
declares `https://*/*` plus loopback. A backend at `http://<public-ip>:8000`
matches neither, so Connect fails before it reaches Nymeria. That is
intentional: the extension holds an account token AND acts in your logged-in
browser, so it is not a place to accept a clear-text bearer token. Tailscale
MagicDNS, a Cloudflare Tunnel, and any domain behind the stack's Caddy all
give you HTTPS for free; see the backend's remote-access guide. The always
works fallback for a remote backend is an SSH tunnel
(`ssh -L 8000:127.0.0.1:8000 user@host`) plus `http://localhost:8000` in
the popup, which rides the extension's loopback permission.

1. Make sure your Nymeria API is reachable (default `http://localhost:8000`).
2. CORS is zero-config on backends from 2026-08-28 on: the API accepts any
   well-formed `chrome-extension://` origin by pattern, so there is nothing
   to allowlist and no restart. On an OLDER backend, add the extension's
   origin to `CORS_ORIGINS` in `Nymeria/.env.docker`:
   ```
   CORS_ORIGINS=...,chrome-extension://hfjpeeimhfbkpidpeabpdppddahckhgp
   ```
   Then `docker compose --env-file .env.docker restart api`. The popup's
   connect errors say which side failed: "health passed but the
   authenticated call was blocked inside this browser" is the old-backend
   CORS shape (or a missing host-permission grant), never a server fault.
3. Mint a token (one-time):
   ```bash
   curl -X POST http://localhost:8000/me/tokens \
        -H "Authorization: Bearer $EXISTING_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"chrome-extension"}'
   ```
4. Click the extension icon → paste base URL + token → **Connect**.
5. Optional: click **Enable** under "Page status reporting" in the popup. This grants
   the `https://*/*` host permission that lets the `webRequest` listener see
   main-frame responses, so `chrome_navigate`, tab create, and reload can
   report the page's real HTTP status (`http_status: 404` instead of a clean
   "navigated"). It is a separate button, not part of Connect, because Chrome
   only shows the grant prompt on a direct click. Skipped, everything still
   works; the status field is simply omitted.

On success the popup shows your identity, "Connected", and a running event counter. Send a chat via the CLI (`cd Nymeria && python3 run.py cli`) or another client — you'll see events tick over in the popup's "Last event" panel.

## Headless server install (no display, no popup)

A VPS can run this extension in headless Chrome so a server-hosted Nymeria
gets a fully driveable browser: `headless/nymeria-headless.sh` owns the
whole flow (bash, curl, python3 only; no node on the server). Verified
end-to-end on Chrome for Testing 152 (branded Google Chrome dropped
`--load-extension` in v137, so the launcher installs Chrome for Testing).

```bash
./headless/nymeria-headless.sh install     # fetch current stable Chrome for Testing
./headless/nymeria-headless.sh configure \
    --base-url https://nymeria.example.com --token <account-token> \
    --source ./dist                        # stage extension + bake config
./headless/nymeria-headless.sh run         # foreground; wrap in systemd
./headless/nymeria-headless.sh status      # is Chrome up, is the worker there
```

How it works: `configure` copies the build, rewrites the manifest so the
host permissions are REQUIRED (auto-granted at unpacked load: this replaces
every popup click, page-status grant included), and writes a `config.json`
(mode 600) the worker adopts at first startup. Storage wins once adopted:
to apply a CHANGED config, remove the profile dir and rerun.

Notes:
- Sandbox: Ubuntu 23.10+ restricts unprivileged user namespaces via
  AppArmor, so stock Chrome aborts at launch. Install the one-time
  AppArmor profile from Chromium's apparmor-userns-restrictions doc
  (root), or pass `run --no-sandbox` as an explicit, logged opt-out.
- Upgrading the extension: after re-staging a NEW build with `configure`,
  launch with `run --fresh-profile`. An existing profile can serve the OLD
  service-worker script from its cache even across a full browser restart,
  while announcing the NEW manifest version (measured 2026-08-28: a QA
  round ran entirely on stale code that reported the new build). The wipe
  costs site logins/cookies; the baked config re-adopts automatically.
- One browser per account: browser commands are broadcast to every
  extension connected on the account, so two connected browsers would BOTH
  execute every command. Give a headless server its own Nymeria account.
- The baked token is a full account token sitting on the server (0600).
  Use a dedicated account and rotate like any credential.
- Systemd shape: a simple service with
  `ExecStart=/path/nymeria-headless.sh run` and `Restart=on-failure`
  under a linger-enabled user is sufficient; the profile dir keeps
  identity across restarts.

## Verification checklist

- [ ] `npm install && npm run build` succeeds; `dist/` loads as an unpacked extension.
- [ ] Popup transitions to **Connected** within ~1 s of a valid token + base URL.
- [ ] `GET /me` response carries `Access-Control-Allow-Origin: chrome-extension://<id>`.
- [ ] Sending a chat through the CLI/desktop ticks the popup's event counter.
- [ ] `docker compose restart api` triggers a visible reconnect with backoff, then snaps back to Connected.
- [ ] After 10 minutes idle, the next chat still streams without a manual reconnect.
- [ ] Two back-to-back events arrive in order in the SW console log.

## Safety posture

v1 is guidance-only by design: the behavioural contract lives in the
`browser-control` kit's `SKILL.md` (page content is data and never
instructions; confirm before anything irreversible; never enter payment or
identity details), and the tool surface is fenced and structurally shaped so
the agent's default path is the safe one. There are no hard gates yet: no
domain pre-authorization, no per-action confirmation prompt, no origin
allowlist. Those are designed and deliberately deferred. Do not read the
absence of a gate as a claim that one is not needed.

## Source attribution

Build scaffold seeded from [`ai-autocomplete-extension`](https://github.com/ManningAskew7/ai-autocomplete-extension); the autocomplete brain and content scripts were stripped, and the AES-GCM key-storage and logger utilities were carried over and rebranded.

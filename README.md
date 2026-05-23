# nymeria-browser

Chrome Manifest V3 extension that acts as a thin client over the Nymeria personal-assistant API.

This is **Phase 1**: it establishes an authenticated, persistent SSE connection from the browser to a Nymeria backend and surfaces connection state in the popup. It does not yet expose any browser-action tools to the agent. That comes in Phase 2 (see `../Nymeria/AGENTS.md` for the larger plan).

## Architecture

```
Popup (React)  ──messages──►  Background service worker  ──fetch + ReadableStream──►  Nymeria API
                                       │                                                   │
                                       └─── chrome.storage.local (config + snapshot)       └─── /autonomous/stream (SSE)
```

- **Auth:** `Authorization: Bearer nym_…` against the user's personal Nymeria token (issued via `POST /me/tokens` on the backend).
- **Push channel:** `/autonomous/stream?client_id=<ext-instance>` — same per-user firehose the desktop and mobile apps consume. The `client_id` round-trip prevents the extension from receiving the echo of its own publishes (none yet — relevant in Phase 2).
- **Reconnect:** exponential backoff with jitter, 1s floor, 60s ceiling, resets on the first successful event.
- **SW lifecycle:** an SSE in-flight `fetch` keeps the service worker alive. A 30-second `chrome.alarms` heartbeat re-establishes the connection if the worker is recycled.

## Project layout

```
src/
├── background/
│   ├── index.ts        SW entry, message router, lifecycle hooks
│   ├── connection.ts   SSE loop + reconnect state machine
│   ├── api.ts          fetch helpers (ping, whoami)
│   ├── sse.ts          pure SSE frame parser (unit-tested)
│   └── state.ts        snapshot persisted to chrome.storage.local
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
npm test        # vitest, 32 tests
npm run lint
```

Load the unpacked extension from `dist/`:

1. Open `chrome://extensions`, enable Developer Mode.
2. Click **Load unpacked** and pick the `dist/` directory.
3. Note the extension ID Chrome assigns. You'll need it for the backend CORS allowlist.

## Connecting to a Nymeria backend

1. Make sure your Nymeria API is reachable (default `http://localhost:8000`).
2. Add the extension's origin to `CORS_ORIGINS` in `Nymeria/.env.docker`:
   ```
   CORS_ORIGINS=...,chrome-extension://<the-extension-id-from-step-3-above>
   ```
   Then `docker compose --env-file .env.docker restart api`.
3. Mint a token (one-time):
   ```bash
   curl -X POST http://localhost:8000/me/tokens \
        -H "Authorization: Bearer $EXISTING_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"chrome-extension"}'
   ```
4. Click the extension icon → paste base URL + token → **Connect**.

On success the popup shows your identity, "Connected", and a running event counter. Send a chat via the CLI (`cd Nymeria && python3 run.py cli`) or another client — you'll see events tick over in the popup's "Last event" panel.

## Phase 1 verification checklist

- [ ] `npm install && npm run build` succeeds; `dist/` loads as an unpacked extension.
- [ ] Popup transitions to **Connected** within ~1 s of a valid token + base URL.
- [ ] `GET /me` response carries `Access-Control-Allow-Origin: chrome-extension://<id>`.
- [ ] Sending a chat through the CLI/desktop ticks the popup's event counter.
- [ ] `docker compose restart api` triggers a visible reconnect with backoff, then snaps back to Connected.
- [ ] After 10 minutes idle, the next chat still streams without a manual reconnect.
- [ ] Two back-to-back events arrive in order in the SW console log.

## Phase 2 (next)

The plumbing is intentionally tool-free. Phase 2 adds:

- Browser-action content scripts (`navigate`, `click`, `fill`, `read_text`, `screenshot`).
- A Nymeria-side `delegate_to_browser` optional tool plus a `BrowserCommandCoordinator` mirroring `auth_prompt_coordinator.py`.
- A new SSE event type `browser_command` carrying a `command_id`.
- A `POST /browser-commands/{command_id}/result` endpoint for the extension to post outcomes.

## Source attribution

Build scaffold seeded from [`ai-autocomplete-extension`](https://github.com/ManningAskew7/ai-autocomplete-extension); the autocomplete brain and content scripts were stripped, and the AES-GCM key-storage and logger utilities were carried over and rebranded.

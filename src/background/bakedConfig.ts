/**
 * Popup-free configuration for unattended installs: the server browser.
 *
 * A server install has no popup to type into: the installer (`nymeria
 * browser configure` on the backend side) writes a `config.json` into its
 * copy of the packaged extension, and the worker adopts it at bootstrap.
 * The file carries `baseUrl` and `token`, and optionally the identity
 * fields `clientId` (must start with `nymeria-browser-`), `kind` (`server`
 * or `desktop`) and `label` (one printable line, at most 60 characters).
 * Each optional field degrades FIELD-WISE: an invalid value is ignored with
 * one log line and the rest of the bake still applies, so a bake with none
 * of them behaves exactly as the v0.28.0 baseUrl-plus-token file did.
 *
 * Adoption happens when storage is unconfigured OR when the file has
 * CHANGED since it was last adopted: the SHA-256 of the raw file text is
 * stored beside the config (`bakedHash`) and compared on every bootstrap,
 * so a re-bake with a new port or a rotated token takes effect on the next
 * worker start without wiping the profile (before v0.29.0 storage won
 * forever, which stranded a rig on any config change). Forget clears the
 * hash with the config, so it too re-adopts on the next start.
 *
 * "Adopt when the bake CHANGES" is the whole rule, which is why a config
 * typed into the popup records the hash of the bake it overrides
 * (`recordBakeOverride`): without that the override carries no bake
 * identity and the next worker start restores the file it was there to
 * replace.
 *
 * The file rides `chrome.runtime.getURL`, so it only ever reads from the
 * extension's own package, and shipping builds simply do not contain one:
 * desktop installs are byte-identical with or without this module running,
 * and a missing or malformed file degrades to the ordinary unconfigured
 * state with one log line (on a server the operator reads the launcher's
 * status check, not a popup).
 */
import { BAKED_HASH_KEY, getConfig, setConfig, type BrowserKind } from '../utils/storage'
import { backgroundLogger as logger } from '../utils/logger'

export interface BakedConfig {
  baseUrl: string
  token: string
  clientId?: string
  kind?: BrowserKind
  label?: string
}

export interface BakedFile {
  config: BakedConfig
  /** SHA-256 hex of the raw file text: the identity a re-adoption compares. */
  hash: string
}

const CLIENT_ID_PREFIX = 'nymeria-browser-'
/**
 * The id travels as the `X-Nymeria-Client-Id` REQUEST HEADER on every
 * whoami and every stream open, so its charset is a transport rule, not
 * cosmetics: a CR or LF in it makes `fetch` reject the request itself, and
 * that failure reads as "cannot reach the backend" (connection.ts) forever,
 * on a rig nobody is watching. Bound both ends, and keep the set to what a
 * header token may hold.
 */
const CLIENT_ID_MAX_CHARS = 128
const CLIENT_ID_CHARSET = /^[A-Za-z0-9._-]+$/
const LABEL_MAX_CHARS = 60
/**
 * "One printable line" as the docstring promises: control characters (Cc),
 * the invisible format characters (Cf, which includes the bidi overrides),
 * and the two Unicode line separators. `\p{Cc}` alone let U+202E and
 * U+2028 through, which are exactly the two that make a roster line lie.
 */
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/**
 * Field-wise degradation for one optional field: absent is silent (the
 * ordinary v0.28.0 bake), an invalid value is dropped with one log line
 * naming the rule it broke, and either way the rest of the bake applies.
 */
function optionalField<T>(
  raw: unknown,
  name: string,
  rule: string,
  accept: (raw: unknown) => T | undefined,
): T | undefined {
  if (raw === undefined) return undefined
  const value = accept(raw)
  if (value === undefined) logger.warn(`config.json: ignoring ${name} (${rule})`)
  return value
}

/**
 * An absolute http(s) URL with a host, which is what the popup's Connect
 * path proves by pinging before it saves. The bake path pings nothing, so a
 * schemeless `api.example.test:8000` would be stored, resolved against the
 * EXTENSION's own origin, and fail every request for the life of the rig
 * under the same "cannot reach the backend" line a real outage produces.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
}

/** Parse the packaged config.json text, or null when it is not a usable bake. */
export function parseBakedConfig(text: string): BakedConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Record<string, unknown>
  if (typeof fields.baseUrl !== 'string' || typeof fields.token !== 'string') return null
  const baseUrl = fields.baseUrl.trim().replace(/\/+$/, '')
  const token = fields.token.trim()
  if (!baseUrl || !token) return null
  // Required, so a bad one is not a field-wise degradation: there is no
  // usable bake left. It gets a log line anyway, because the alternative is
  // a rig that silently never connects.
  if (!isAbsoluteHttpUrl(baseUrl)) {
    logger.warn('config.json: ignoring the file (baseUrl must be an absolute http(s) URL)')
    return null
  }

  const config: BakedConfig = { baseUrl, token }
  const clientId = optionalField(
    fields.clientId,
    'clientId',
    `must start with ${CLIENT_ID_PREFIX}, hold only [A-Za-z0-9._-], and be at most ${CLIENT_ID_MAX_CHARS} characters`,
    (value) => {
      const id = typeof value === 'string' ? value.trim() : ''
      if (!id.startsWith(CLIENT_ID_PREFIX) || id.length <= CLIENT_ID_PREFIX.length) return undefined
      if (id.length > CLIENT_ID_MAX_CHARS) return undefined
      return CLIENT_ID_CHARSET.test(id) ? id : undefined
    },
  )
  if (clientId) config.clientId = clientId
  const kind = optionalField(fields.kind, 'kind', 'must be "server" or "desktop"', (value) =>
    value === 'server' || value === 'desktop' ? value : undefined,
  )
  if (kind) config.kind = kind
  const label = optionalField(
    fields.label,
    'label',
    `must be one printable line of at most ${LABEL_MAX_CHARS} characters`,
    (value) => {
      const text = typeof value === 'string' ? value.trim() : ''
      return text && text.length <= LABEL_MAX_CHARS && !LABEL_FORBIDDEN.test(text) ? text : undefined
    },
  )
  if (label) config.label = label
  return config
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Read and parse the packaged config.json, or null for absent/malformed. */
export async function loadBakedConfig(): Promise<BakedFile | null> {
  let text: string
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'))
    if (!res.ok) return null
    text = await res.text()
  } catch {
    return null
  }
  const config = parseBakedConfig(text)
  return config ? { config, hash: await sha256Hex(text) } : null
}

/**
 * Adopt the packaged config when storage is unconfigured, or when the file
 * has changed since it was last adopted. Returns true when an adoption
 * happened. Nothing has to act on that: adoption runs at worker start,
 * before the first connect, so nothing is holding the old URL and token.
 *
 * A re-adoption overwrites baseUrl, token, kind and label. It takes the
 * baked clientId when the file names one and otherwise KEEPS the stored id
 * (setConfig's default), because a re-bake that says nothing about
 * identity must not re-identify the browser to the backend's roster.
 *
 * The `configured` conjunct is what heals an install whose stored token has
 * become unreadable (`decryptData` answers '' for a corrupt or
 * foreign-keyed blob, so `hasToken` goes false while the hash survives):
 * without it the matching hash would win and the rig would sit on an empty
 * token forever, with the fix sitting right there in the package.
 */
export async function adoptBakedConfig(): Promise<boolean> {
  const baked = await loadBakedConfig()
  if (!baked) return false
  const existing = await getConfig()
  const configured = !!existing.baseUrl && existing.hasToken
  const stored = await chrome.storage.local.get(BAKED_HASH_KEY)
  if (configured && stored[BAKED_HASH_KEY] === baked.hash) return false
  await setConfig(baked.config)
  await chrome.storage.local.set({ [BAKED_HASH_KEY]: baked.hash })
  logger.log(
    configured
      ? 'packaged config.json changed since it was adopted: re-adopted it'
      : 'adopted packaged config.json (unattended install)',
  )
  return true
}

/**
 * Record the bake that a hand-entered config overrides.
 *
 * The popup is the only way a person overrides a baked rig, and the reason
 * they reach for it is that the bake is wrong: a revoked token, a moved
 * backend. Adoption's rule is "adopt when the bake CHANGES", so an override
 * that records no bake identity leaves the next worker start comparing
 * against a hash that is not there, re-adopting the stale file, and
 * silently undoing the fix. Storing the CURRENT file's hash says "this bake
 * was seen and deliberately overridden": the next start leaves storage
 * alone, while a genuinely NEW bake (a re-configure) still wins.
 *
 * Best-effort by design: a build with no config.json has no bake to record
 * (and nothing that could clobber it), and a storage failure must not fail
 * the connect the popup is waiting on.
 */
export async function recordBakeOverride(): Promise<void> {
  try {
    const baked = await loadBakedConfig()
    if (!baked) return
    await chrome.storage.local.set({ [BAKED_HASH_KEY]: baked.hash })
  } catch (error) {
    logger.warn('could not record the overridden config.json hash:', error)
  }
}

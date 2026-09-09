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
const LABEL_MAX_CHARS = 60

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

  const config: BakedConfig = { baseUrl, token }
  const clientId = optionalField(
    fields.clientId,
    'clientId',
    `must start with ${CLIENT_ID_PREFIX} followed by an id`,
    (value) => {
      const id = typeof value === 'string' ? value.trim() : ''
      return id.startsWith(CLIENT_ID_PREFIX) && id.length > CLIENT_ID_PREFIX.length ? id : undefined
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
      return text && text.length <= LABEL_MAX_CHARS && !/\p{Cc}/u.test(text) ? text : undefined
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
 * happened (the caller reconnects so the new URL and token take effect).
 *
 * A re-adoption overwrites baseUrl, token, kind and label. It takes the
 * baked clientId when the file names one and otherwise KEEPS the stored id
 * (setConfig's default), because a re-bake that says nothing about
 * identity must not re-identify the browser to the backend's roster.
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

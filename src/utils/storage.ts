import { decryptData, encryptData } from './security'
import { logger } from './logger'

/**
 * Which kind of browser this extension instance is, as announced to the
 * backend on every subscribe (`client_kind`). `desktop` is the extension in
 * a Chrome the user can see; `server` is the headless Chrome that runs
 * beside the backend (the "server browser"), configured by a baked
 * `config.json` rather than the popup. Closed set: the backend stores any
 * other value as `desktop`.
 */
export type BrowserKind = 'server' | 'desktop'

export interface NymeriaConfig {
  baseUrl: string
  clientId: string
  hasToken: boolean
  kind: BrowserKind
  /** Roster label hint sent as `client_label`; empty when none is set. */
  label: string
}

interface StoredShape {
  baseUrl?: string
  clientId?: string
  encryptedToken?: string
  kind?: BrowserKind
  label?: string
}

const KEYS: Array<keyof StoredShape> = ['baseUrl', 'clientId', 'encryptedToken', 'kind', 'label']

/**
 * SHA-256 of the packaged `config.json` last adopted (`bakedConfig.ts`).
 * Owned here because Forget must clear it with the config: a headless
 * install that forgets its token re-adopts the bake on the next worker
 * start, which is the documented way to apply a changed config. The popup's
 * Connect writes it back (`recordBakeOverride`), so a config a person typed
 * after that Forget is not undone by the file they were working around.
 */
export const BAKED_HASH_KEY = 'bakedHash'

export async function getConfig(): Promise<NymeriaConfig & { token: string }> {
  const stored = (await chrome.storage.local.get(KEYS)) as StoredShape
  const baseUrl = stored.baseUrl ?? ''
  const clientId = stored.clientId ?? ''
  const token = stored.encryptedToken ? await decryptData(stored.encryptedToken) : ''
  const kind = stored.kind ?? 'desktop'
  const label = stored.label ?? ''
  return { baseUrl, clientId, hasToken: !!token, token, kind, label }
}

/**
 * Write the whole config. `clientId` defaults to the stored (or a freshly
 * minted) id, so a caller that omits it never re-identifies the browser;
 * `kind` and `label` default to the desktop shape, so a caller that omits
 * them (the popup, a re-bake without them) resets rather than inherits.
 */
export async function setConfig(input: {
  baseUrl: string
  token: string
  clientId?: string
  kind?: BrowserKind
  label?: string
}): Promise<void> {
  const clientId = input.clientId ?? (await ensureClientId()).clientId
  const encryptedToken = input.token ? await encryptData(input.token) : ''
  await chrome.storage.local.set({
    baseUrl: input.baseUrl,
    clientId,
    encryptedToken,
    kind: input.kind ?? 'desktop',
    label: input.label ?? '',
  } satisfies StoredShape)
  logger.log('Config saved')
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove([...KEYS, BAKED_HASH_KEY])
  logger.log('Config cleared')
}

export async function ensureClientId(): Promise<{ clientId: string }> {
  const stored = (await chrome.storage.local.get(['clientId'])) as { clientId?: string }
  if (stored.clientId) return { clientId: stored.clientId }
  const clientId = `nymeria-browser-${crypto.randomUUID()}`
  await chrome.storage.local.set({ clientId })
  return { clientId }
}

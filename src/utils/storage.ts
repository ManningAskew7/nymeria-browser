import { decryptData, encryptData } from './security'
import { logger } from './logger'

export interface NymeriaConfig {
  baseUrl: string
  clientId: string
  hasToken: boolean
}

interface StoredShape {
  baseUrl?: string
  clientId?: string
  encryptedToken?: string
}

const KEYS: Array<keyof StoredShape> = ['baseUrl', 'clientId', 'encryptedToken']

export async function getConfig(): Promise<NymeriaConfig & { token: string }> {
  const stored = (await chrome.storage.local.get(KEYS)) as StoredShape
  const baseUrl = stored.baseUrl ?? ''
  const clientId = stored.clientId ?? ''
  const token = stored.encryptedToken ? await decryptData(stored.encryptedToken) : ''
  return { baseUrl, clientId, hasToken: !!token, token }
}

export async function setConfig(input: { baseUrl: string; token: string }): Promise<void> {
  const { clientId } = await ensureClientId()
  const encryptedToken = input.token ? await encryptData(input.token) : ''
  await chrome.storage.local.set({
    baseUrl: input.baseUrl,
    clientId,
    encryptedToken,
  } satisfies StoredShape)
  logger.log('Config saved')
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove(KEYS)
  logger.log('Config cleared')
}

export async function ensureClientId(): Promise<{ clientId: string }> {
  const stored = (await chrome.storage.local.get(['clientId'])) as { clientId?: string }
  if (stored.clientId) return { clientId: stored.clientId }
  const clientId = `nymeria-browser-${crypto.randomUUID()}`
  await chrome.storage.local.set({ clientId })
  return { clientId }
}

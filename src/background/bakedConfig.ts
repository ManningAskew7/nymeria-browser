/**
 * Popup-free configuration for unattended installs (browser-beta stage 2).
 *
 * A server install has no popup to type into: the headless launcher writes a
 * `config.json` (baseUrl + token) into its copy of the packaged extension,
 * and the worker adopts it at bootstrap WHEN STORAGE IS UNCONFIGURED.
 * Storage wins once set (a popup edit and an adopted bake both count), so a
 * rotated `config.json` applies via Forget or a fresh profile, never by
 * silently overriding a live install mid-flight. Absent or malformed files
 * degrade to the ordinary unconfigured state with one log line: on a server
 * the operator reads the launcher's health check, not a popup.
 *
 * The file rides `chrome.runtime.getURL`, so it only ever reads from the
 * extension's own package, and shipping builds simply do not contain one:
 * desktop installs are byte-identical with or without this module running.
 */
import { getConfig, setConfig } from '../utils/storage'
import { backgroundLogger as logger } from '../utils/logger'

export interface BakedConfig {
  baseUrl: string
  token: string
}

/** Parse the packaged config.json, or null for absent/malformed/empty. */
export async function loadBakedConfig(): Promise<BakedConfig | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'))
    if (!res.ok) return null
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null) return null
    const baseUrl = (raw as { baseUrl?: unknown }).baseUrl
    const token = (raw as { token?: unknown }).token
    if (typeof baseUrl !== 'string' || typeof token !== 'string') return null
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, '')
    const trimmedToken = token.trim()
    if (!trimmedUrl || !trimmedToken) return null
    return { baseUrl: trimmedUrl, token: trimmedToken }
  } catch {
    return null
  }
}

/**
 * Adopt the packaged config into storage iff storage is unconfigured.
 * Returns true when an adoption happened (the caller logs and connects).
 */
export async function adoptBakedConfigIfUnconfigured(): Promise<boolean> {
  const existing = await getConfig()
  if (existing.baseUrl && existing.hasToken) return false
  const baked = await loadBakedConfig()
  if (!baked) return false
  await setConfig(baked)
  logger.log('adopted packaged config.json (unattended install)')
  return true
}

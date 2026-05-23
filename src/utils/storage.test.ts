import { describe, expect, it } from 'vitest'
import { clearConfig, ensureClientId, getConfig, setConfig } from './storage'
import { decryptData, encryptData } from './security'

describe('encryptData / decryptData round-trip', () => {
  it('decrypts to the original plaintext', async () => {
    const ciphertext = await encryptData('nym_supersecret_value')
    expect(ciphertext).not.toContain('nym_supersecret_value')
    expect(await decryptData(ciphertext)).toBe('nym_supersecret_value')
  })

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const a = await encryptData('hello')
    const b = await encryptData('hello')
    expect(a).not.toBe(b)
    expect(await decryptData(a)).toBe('hello')
    expect(await decryptData(b)).toBe('hello')
  })

  it('returns empty string for empty input', async () => {
    expect(await encryptData('')).toBe('')
    expect(await decryptData('')).toBe('')
  })

  it('decrypts to empty string on tampered ciphertext (does not throw)', async () => {
    const ciphertext = await encryptData('secret')
    const tampered = ciphertext.slice(0, -4) + 'AAAA'
    expect(await decryptData(tampered)).toBe('')
  })
})

describe('config storage', () => {
  it('persists baseUrl and token (encrypted) and reads them back', async () => {
    await setConfig({ baseUrl: 'http://localhost:8000', token: 'nym_abc123' })
    const cfg = await getConfig()
    expect(cfg.baseUrl).toBe('http://localhost:8000')
    expect(cfg.token).toBe('nym_abc123')
    expect(cfg.hasToken).toBe(true)
    expect(cfg.clientId).toMatch(/^nymeria-browser-/)
  })

  it('stores the token encrypted (raw value not present in chrome.storage)', async () => {
    await setConfig({ baseUrl: 'http://localhost:8000', token: 'nym_visible' })
    const stored = (await chrome.storage.local.get(['encryptedToken'])) as { encryptedToken: string }
    expect(stored.encryptedToken).toBeTruthy()
    expect(stored.encryptedToken).not.toContain('nym_visible')
  })

  it('clearConfig removes baseUrl, clientId, and token', async () => {
    await setConfig({ baseUrl: 'http://x', token: 'nym_y' })
    await clearConfig()
    const cfg = await getConfig()
    expect(cfg.baseUrl).toBe('')
    expect(cfg.token).toBe('')
    expect(cfg.hasToken).toBe(false)
  })

  it('ensureClientId is idempotent — same id on repeat calls', async () => {
    const a = await ensureClientId()
    const b = await ensureClientId()
    expect(a.clientId).toBe(b.clientId)
    expect(a.clientId).toMatch(/^nymeria-browser-/)
  })

  it('ensureClientId reuses the id set by setConfig', async () => {
    await setConfig({ baseUrl: 'http://x', token: 'nym_y' })
    const { clientId } = await ensureClientId()
    const cfg = await getConfig()
    expect(clientId).toBe(cfg.clientId)
  })
})

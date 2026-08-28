import { describe, expect, it, vi } from 'vitest'
import { loadDraft, saveDraft } from './draft'

/** The failure this module exists for: the popup dies (Connect's permission
 *  prompt dismisses it), a NEW popup loads, and the typed fields must come
 *  back. Storage is the only thing connecting the two lives, so every test
 *  is a save-in-one-life, load-in-the-next shape. */

const flush = () => new Promise((r) => setTimeout(r, 0))

/** saveDraft is fire-and-forget and its encrypt step spans several awaits,
 *  so tests wait for the record to LAND rather than counting microtasks. */
async function draftLanded(): Promise<void> {
  await vi.waitFor(async () => {
    const raw = await chrome.storage.session.get('nymPopupDraft')
    expect(raw['nymPopupDraft']).toBeDefined()
  })
}

describe('connect-form draft', () => {
  it('round-trips what was typed across a popup death', async () => {
    saveDraft({ baseUrl: 'https://nymeria.example.com', token: 'nym_typed_but_not_submitted' })
    await draftLanded()

    const restored = await loadDraft()

    expect(restored).toEqual({
      baseUrl: 'https://nymeria.example.com',
      token: 'nym_typed_but_not_submitted',
    })
  })

  it('stores the token as ciphertext, like the configured copy', async () => {
    // A storage dump (a debug probe took one live, 2026-08-28) must see
    // ciphertext, never the credential.
    saveDraft({ baseUrl: 'https://nymeria.example.com', token: 'nym_secret_draft' })
    await draftLanded()

    const raw = await chrome.storage.session.get('nymPopupDraft')
    const stored = raw['nymPopupDraft'] as { baseUrl: string; token: string }

    expect(stored.baseUrl).toBe('https://nymeria.example.com')
    expect(stored.token).not.toContain('nym_secret_draft')
    expect(stored.token.length).toBeGreaterThan(0)
  })

  it('answers null when nothing was ever typed', async () => {
    expect(await loadDraft()).toBeNull()
  })

  it('answers null for a malformed record instead of half a draft', async () => {
    // Storage is a store, not a trusted producer: a coerced or partial
    // record must not hand the form an undefined to render.
    await chrome.storage.session.set({ nymPopupDraft: { baseUrl: 42, token: 'x' } })
    expect(await loadDraft()).toBeNull()

    await chrome.storage.session.set({ nymPopupDraft: { baseUrl: 'https://a' } })
    expect(await loadDraft()).toBeNull()
  })

  it('restores the URL alone when the token ciphertext does not decrypt', async () => {
    // decryptData answers '' on tamper: half a draft (the URL) beats none.
    saveDraft({ baseUrl: 'https://nymeria.example.com', token: 'nym_secret' })
    await draftLanded()
    const raw = await chrome.storage.session.get('nymPopupDraft')
    const stored = raw['nymPopupDraft'] as { baseUrl: string; token: string }
    await chrome.storage.session.set({
      nymPopupDraft: { ...stored, token: stored.token.slice(0, -4) + 'AAAA' },
    })

    const restored = await loadDraft()

    expect(restored).toEqual({ baseUrl: 'https://nymeria.example.com', token: '' })
  })

  it('survives a storage layer that throws, answering null and swallowing the save', async () => {
    const broken = {
      get: vi.fn().mockRejectedValue(new Error('no session storage')),
      set: vi.fn().mockRejectedValue(new Error('no session storage')),
    }
    const original = chrome.storage.session
    ;(chrome.storage as { session: unknown }).session = broken
    try {
      expect(await loadDraft()).toBeNull()
      expect(() => saveDraft({ baseUrl: 'https://a', token: 'b' })).not.toThrow()
      await flush()
    } finally {
      ;(chrome.storage as { session: unknown }).session = original
    }
  })
})

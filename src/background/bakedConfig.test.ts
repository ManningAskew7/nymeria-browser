/**
 * Baked-config adoption (browser-beta stage 2): a packaged config.json
 * configures an unattended install exactly once, and storage always wins
 * after that. The fetch is stubbed per-test; storage is the setup mock's
 * real in-memory area, so adoption is asserted on observable getConfig
 * output, not on internal calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptBakedConfigIfUnconfigured, loadBakedConfig } from './bakedConfig'
import { getConfig, setConfig } from '../utils/storage'

const stubFetch = (impl: () => Promise<Response>) => {
  vi.stubGlobal('fetch', vi.fn(impl))
}

const jsonResponse = (body: unknown, ok = true): Response =>
  ({
    ok,
    json: async () => body,
  }) as unknown as Response

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('loadBakedConfig', () => {
  it('parses a well-formed packaged config and trims it', async () => {
    stubFetch(async () =>
      jsonResponse({ baseUrl: 'https://api.example.test///', token: '  tok-1  ' }),
    )
    expect(await loadBakedConfig()).toEqual({
      baseUrl: 'https://api.example.test',
      token: 'tok-1',
    })
  })

  it('degrades to null when the package has no config.json (non-ok fetch)', async () => {
    stubFetch(async () => jsonResponse(null, false))
    expect(await loadBakedConfig()).toBeNull()
  })

  it('degrades to null when the fetch itself rejects', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await loadBakedConfig()).toBeNull()
  })

  it('degrades to null on malformed JSON', async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token')
          },
        }) as unknown as Response,
    )
    expect(await loadBakedConfig()).toBeNull()
  })

  it.each([
    ['not an object', 'just a string'],
    ['missing token', { baseUrl: 'https://x.test' }],
    ['missing baseUrl', { token: 't' }],
    ['non-string fields', { baseUrl: 42, token: 't' }],
    ['empty strings', { baseUrl: '   ', token: '' }],
  ])('degrades to null on %s', async (_label, body) => {
    stubFetch(async () => jsonResponse(body))
    expect(await loadBakedConfig()).toBeNull()
  })
})

describe('adoptBakedConfigIfUnconfigured', () => {
  it('adopts into empty storage and reports it', async () => {
    stubFetch(async () => jsonResponse({ baseUrl: 'https://api.example.test', token: 'tok-2' }))
    expect(await adoptBakedConfigIfUnconfigured()).toBe(true)
    const config = await getConfig()
    expect(config.baseUrl).toBe('https://api.example.test')
    expect(config.hasToken).toBe(true)
    expect(config.token).toBe('tok-2')
  })

  it('never overrides a configured install: storage wins', async () => {
    await setConfig({ baseUrl: 'https://user-chose.test', token: 'user-token' })
    stubFetch(async () => jsonResponse({ baseUrl: 'https://baked.test', token: 'baked-token' }))
    expect(await adoptBakedConfigIfUnconfigured()).toBe(false)
    const config = await getConfig()
    expect(config.baseUrl).toBe('https://user-chose.test')
    expect(config.token).toBe('user-token')
  })

  it('reports false and stores nothing when no bake exists', async () => {
    stubFetch(async () => jsonResponse(null, false))
    expect(await adoptBakedConfigIfUnconfigured()).toBe(false)
    const config = await getConfig()
    expect(config.baseUrl).toBe('')
    expect(config.hasToken).toBe(false)
  })
})

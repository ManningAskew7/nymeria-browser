/**
 * Baked-config adoption (the server browser): a packaged config.json
 * configures an unattended install, and a CHANGED file re-adopts on the
 * next worker start while an unchanged one leaves storage alone. The fetch
 * is stubbed per-test; storage is the setup mock's real in-memory area, so
 * adoption is asserted on observable getConfig output and the stored hash,
 * not on internal calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptBakedConfig, loadBakedConfig, parseBakedConfig } from './bakedConfig'
import { backgroundLogger } from '../utils/logger'
import { BAKED_HASH_KEY, clearConfig, getConfig, setConfig } from '../utils/storage'

const stubFetch = (impl: () => Promise<Response>) => {
  vi.stubGlobal('fetch', vi.fn(impl))
}

/** A packaged file whose body is the given raw text (ok unless told otherwise). */
const textResponse = (text: string, ok = true): Response =>
  ({
    ok,
    text: async () => text,
  }) as unknown as Response

/** Stage a config.json holding this object; the adopt tests speak in objects. */
const stageBake = (body: unknown): void => {
  stubFetch(async () => textResponse(JSON.stringify(body)))
}

/** A build with no config.json: Chrome rejects the fetch of a missing package file. */
const stageNoBake = (): void => {
  stubFetch(async () => {
    throw new TypeError('Failed to fetch')
  })
}

const storedHash = async (): Promise<string | undefined> =>
  ((await chrome.storage.local.get(BAKED_HASH_KEY)) as { bakedHash?: string }).bakedHash

const BASE = { baseUrl: 'https://api.example.test', token: 'tok-1' }

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseBakedConfig', () => {
  it('parses a baseUrl-plus-token file and trims it (the v0.28.0 shape, unchanged)', () => {
    expect(parseBakedConfig('{"baseUrl": "https://api.example.test///", "token": "  tok-1  "}')).toEqual({
      baseUrl: 'https://api.example.test',
      token: 'tok-1',
    })
  })

  it('carries every optional identity field when each is valid', () => {
    expect(
      parseBakedConfig(
        JSON.stringify({
          ...BASE,
          clientId: 'nymeria-browser-rig-1',
          kind: 'server',
          label: '  server browser  ',
        }),
      ),
    ).toEqual({
      ...BASE,
      clientId: 'nymeria-browser-rig-1',
      kind: 'server',
      label: 'server browser',
    })
  })

  it('accepts kind "desktop" too: the set is closed at two values', () => {
    expect(parseBakedConfig(JSON.stringify({ ...BASE, kind: 'desktop' }))).toEqual({ ...BASE, kind: 'desktop' })
  })

  it.each([
    ['a clientId without the nymeria-browser- prefix', { clientId: 'rig-1' }],
    ['a clientId that is the bare prefix', { clientId: 'nymeria-browser-' }],
    ['a clientId that is the prefix plus whitespace', { clientId: 'nymeria-browser-   ' }],
    ['a non-string clientId', { clientId: 42 }],
    ['an unknown kind', { kind: 'headless' }],
    ['a non-string kind', { kind: 1 }],
    ['a null kind', { kind: null }],
    ['a label over 60 characters', { label: 'x'.repeat(61) }],
    ['a label containing a newline', { label: 'server\nbrowser' }],
    ['a label containing a control character', { label: 'server\u0007browser' }],
    ['a blank label', { label: '   ' }],
    ['a non-string label', { label: ['server'] }],
  ])('ignores %s with one warning and keeps the rest of the bake', (_label, extra) => {
    const warn = vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})

    const parsed = parseBakedConfig(JSON.stringify({ ...BASE, ...extra }))

    expect(parsed).toEqual(BASE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(Object.keys(extra)[0])
  })

  it('drops only the invalid field when another optional field is valid', () => {
    vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})

    expect(parseBakedConfig(JSON.stringify({ ...BASE, kind: 'bogus', label: 'server browser' }))).toEqual({
      ...BASE,
      label: 'server browser',
    })
  })

  it('logs nothing when the optional fields are simply absent', () => {
    const warn = vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})

    parseBakedConfig(JSON.stringify(BASE))

    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a label of exactly 60 characters (the limit is inclusive)', () => {
    const label = 'y'.repeat(60)
    expect(parseBakedConfig(JSON.stringify({ ...BASE, label }))).toEqual({ ...BASE, label })
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['not an object', '"just a string"'],
    ['missing token', JSON.stringify({ baseUrl: 'https://x.test' })],
    ['missing baseUrl', JSON.stringify({ token: 't' })],
    ['non-string fields', JSON.stringify({ baseUrl: 42, token: 't' })],
    ['empty strings', JSON.stringify({ baseUrl: '   ', token: '' })],
  ])('degrades to null on %s', (_label, text) => {
    expect(parseBakedConfig(text)).toBeNull()
  })
})

describe('loadBakedConfig', () => {
  it('returns the parsed config with the SHA-256 of the RAW file text', async () => {
    // Pinned against `sha256sum` of this exact text. Spacing is deliberate:
    // hashing a re-serialised object instead of the file would not match.
    stubFetch(async () => textResponse('{ "baseUrl": "https://api.example.test",  "token": "tok-1" }'))

    expect(await loadBakedConfig()).toEqual({
      config: BASE,
      hash: '7add58076fe65f9594ead5e3d7a8de2cd42ef5bdf061e7ecd310c769436d39c4',
    })
  })

  it('degrades to null when the package has no config.json (non-ok fetch)', async () => {
    stubFetch(async () => textResponse('', false))
    expect(await loadBakedConfig()).toBeNull()
  })

  it('degrades to null when the fetch itself rejects', async () => {
    stageNoBake()
    expect(await loadBakedConfig()).toBeNull()
  })

  it('degrades to null on a malformed file rather than hashing it', async () => {
    stubFetch(async () => textResponse('{not json'))
    expect(await loadBakedConfig()).toBeNull()
  })
})

describe('adoptBakedConfig', () => {
  it('adopts into empty storage, records the hash, and reports it', async () => {
    stageBake({ ...BASE, token: 'tok-2' })

    expect(await adoptBakedConfig()).toBe(true)

    const config = await getConfig()
    expect(config.baseUrl).toBe('https://api.example.test')
    expect(config.hasToken).toBe(true)
    expect(config.token).toBe('tok-2')
    expect(await storedHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('adopts the baked identity fields: clientId, kind and label', async () => {
    stageBake({ ...BASE, clientId: 'nymeria-browser-rig-1', kind: 'server', label: 'server browser' })

    await adoptBakedConfig()

    const config = await getConfig()
    expect(config.clientId).toBe('nymeria-browser-rig-1')
    expect(config.kind).toBe('server')
    expect(config.label).toBe('server browser')
  })

  it('a bake with none of the optional fields adopts as v0.28.0 did: desktop, no label, minted id', async () => {
    stageBake(BASE)

    await adoptBakedConfig()

    const config = await getConfig()
    expect(config.kind).toBe('desktop')
    expect(config.label).toBe('')
    expect(config.clientId).toMatch(/^nymeria-browser-[0-9a-f-]{36}$/)
  })

  it('leaves a configured install alone when the file has not changed since adoption', async () => {
    stageBake(BASE)
    await adoptBakedConfig()
    const before = await getConfig()

    expect(await adoptBakedConfig()).toBe(false)

    expect(await getConfig()).toEqual(before)
  })

  it('re-adopts when the file changed: new URL and token replace the stored ones', async () => {
    stageBake(BASE)
    await adoptBakedConfig()
    const firstHash = await storedHash()

    stageBake({ baseUrl: 'http://localhost:8010', token: 'tok-rotated' })
    expect(await adoptBakedConfig()).toBe(true)

    const config = await getConfig()
    expect(config.baseUrl).toBe('http://localhost:8010')
    expect(config.token).toBe('tok-rotated')
    expect(await storedHash()).not.toBe(firstHash)
  })

  it('re-adoption keeps the existing clientId when the new bake names none', async () => {
    stageBake({ ...BASE, clientId: 'nymeria-browser-rig-1' })
    await adoptBakedConfig()

    stageBake({ ...BASE, token: 'tok-rotated' })
    await adoptBakedConfig()

    expect((await getConfig()).clientId).toBe('nymeria-browser-rig-1')
  })

  it('re-adoption takes the new clientId when the new bake names one', async () => {
    stageBake({ ...BASE, clientId: 'nymeria-browser-rig-1' })
    await adoptBakedConfig()

    stageBake({ ...BASE, clientId: 'nymeria-browser-rig-2' })
    await adoptBakedConfig()

    expect((await getConfig()).clientId).toBe('nymeria-browser-rig-2')
  })

  it('re-adoption overwrites kind and label, so dropping them from the bake resets to desktop', async () => {
    stageBake({ ...BASE, kind: 'server', label: 'server browser' })
    await adoptBakedConfig()

    stageBake({ ...BASE, token: 'tok-rotated' })
    await adoptBakedConfig()

    const config = await getConfig()
    expect(config.kind).toBe('desktop')
    expect(config.label).toBe('')
  })

  it('a rig adopted before hashes existed re-adopts once, then settles', async () => {
    // v0.28.0 stored the config with no bakedHash; the upgrade must record
    // one without re-identifying the browser.
    await setConfig({ ...BASE, clientId: 'nymeria-browser-old-rig' })
    stageBake(BASE)

    expect(await adoptBakedConfig()).toBe(true)
    expect((await getConfig()).clientId).toBe('nymeria-browser-old-rig')
    expect(await adoptBakedConfig()).toBe(false)
  })

  it('Forget re-arms adoption: clearConfig drops the hash so the same file adopts again', async () => {
    stageBake(BASE)
    await adoptBakedConfig()

    await clearConfig()
    expect(await storedHash()).toBeUndefined()

    expect(await adoptBakedConfig()).toBe(true)
    expect((await getConfig()).baseUrl).toBe('https://api.example.test')
  })

  it('reports false and stores nothing when no bake exists', async () => {
    stageNoBake()

    expect(await adoptBakedConfig()).toBe(false)

    const config = await getConfig()
    expect(config.baseUrl).toBe('')
    expect(config.hasToken).toBe(false)
    expect(await storedHash()).toBeUndefined()
  })

  it('a desktop build (no config.json) never touches a popup-configured install', async () => {
    await setConfig({ baseUrl: 'https://user-chose.test', token: 'user-token' })
    const before = await getConfig()
    stageNoBake()

    expect(await adoptBakedConfig()).toBe(false)

    expect(await getConfig()).toEqual(before)
    expect(await storedHash()).toBeUndefined()
  })
})

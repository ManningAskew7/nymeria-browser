/**
 * Baked-config adoption (the server browser): a packaged config.json
 * configures an unattended install, and a CHANGED file re-adopts on the
 * next worker start while an unchanged one leaves storage alone. The fetch
 * is stubbed per-test; storage is the setup mock's real in-memory area, so
 * adoption is asserted on observable getConfig output and the stored hash,
 * not on internal calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptBakedConfig, loadBakedConfig, parseBakedConfig, recordBakeOverride } from './bakedConfig'
import { backgroundLogger, logger } from '../utils/logger'
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
    // The id is an HTTP REQUEST HEADER value: a CR or LF in it makes fetch
    // reject the request itself, so the rig retries forever reporting
    // "cannot reach the backend" while the backend is perfectly healthy.
    ['a clientId containing CRLF', { clientId: 'nymeria-browser-rig\r\nX-Evil: 1' }],
    ['a clientId containing an embedded newline', { clientId: 'nymeria-browser-\nrig' }],
    ['a clientId containing a space', { clientId: 'nymeria-browser-rig one' }],
    ['a clientId containing a non-ASCII character', { clientId: 'nymeria-browser-rigé' }],
    ['a clientId over 128 characters', { clientId: `nymeria-browser-${'r'.repeat(113)}` }],
    ['an unknown kind', { kind: 'headless' }],
    ['a non-string kind', { kind: 1 }],
    ['a null kind', { kind: null }],
    ['a label over 60 characters', { label: 'x'.repeat(61) }],
    ['a label containing a newline', { label: 'server\nbrowser' }],
    ['a label containing a control character', { label: 'server\u0007browser' }],
    // "One printable line" is the documented rule, and Cc alone does not
    // enforce it: a bidi override reverses the rest of a roster row, and
    // U+2028 IS a line break to anything that renders it.
    ['a label containing a bidi override', { label: 'server\u202Ebrowser' }],
    ['a label containing a zero-width joiner', { label: 'server\u200Dbrowser' }],
    ['a label containing U+2028', { label: 'server\u2028browser' }],
    ['a label containing U+2029', { label: 'server\u2029browser' }],
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

  // baseUrl is REQUIRED, so a bad one is not a field-wise degradation: there
  // is no bake left to apply. It has to be caught here because the bake path
  // pings nothing (the popup's Connect does), and a stored schemeless URL
  // resolves against the extension's own origin, so every request fails for
  // the life of the rig under the same line a real outage prints.
  it.each([
    ['a schemeless host:port', 'api.example.test:8000'],
    ['a protocol-relative URL', '//api.example.test'],
    ['a bare host', 'api.example.test'],
    ['a path only', '/autonomous/stream'],
    ['a non-http scheme', 'ftp://api.example.test'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an http URL with no host', 'http://'],
  ])('refuses the whole bake when baseUrl is %s, with one warning', (_label, baseUrl) => {
    const warn = vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})

    expect(parseBakedConfig(JSON.stringify({ baseUrl, token: 'tok-1' }))).toBeNull()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('baseUrl')
  })

  it.each([
    ['https', 'https://api.example.test'],
    ['http on loopback', 'http://localhost:8010'],
    ['http on a container hostname', 'http://nymeria-api:8000'],
    ['an https URL with a path prefix', 'https://host.test/nymeria'],
  ])('keeps a %s baseUrl', (_label, baseUrl) => {
    expect(parseBakedConfig(JSON.stringify({ baseUrl, token: 'tok-1' }))).toEqual({ baseUrl, token: 'tok-1' })
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

  it('a rig whose stored config came from a v0.28.0 BAKE re-adopts once, then settles', async () => {
    // The one hash-less state left, and it is an upgrade, not a user's
    // choice: v0.28.0 adopted the same file and stored no bakedHash, so
    // re-adopting it changes nothing except recording the hash, and the
    // browser must keep its identity across the upgrade. A config a PERSON
    // typed into the popup is NOT this case (it records the hash it
    // overrides, and the test below pins that it survives), which is what
    // this assertion used to blur.
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

  it('heals a rig whose stored token has become unreadable, even though the bake is unchanged', async () => {
    // The state the `configured` conjunct exists for, and it is reachable:
    // decryptData answers '' for a blob it cannot open (a corrupted write,
    // or a profile carried to an install with a different extension id), so
    // hasToken goes false while the bakedHash sits there matching. Hash
    // equality alone would call that "nothing to do" and leave the rig
    // holding an empty token forever, with the cure in its own package.
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    stageBake(BASE)
    await adoptBakedConfig()
    const hashBefore = await storedHash()
    await chrome.storage.local.set({ encryptedToken: 'not-a-real-ciphertext' })
    expect((await getConfig()).hasToken).toBe(false)

    expect(await adoptBakedConfig()).toBe(true)

    const config = await getConfig()
    expect(config.token).toBe('tok-1')
    expect(await storedHash()).toBe(hashBefore)
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

/**
 * The override path: what the popup does to a BAKED rig. The scenario is the
 * one that makes it matter, from end to end, because the failure it fixes is
 * only visible across a worker restart.
 */
describe('recordBakeOverride', () => {
  /** What the popup's Connect writes, plus the override record it now makes. */
  const popupConnect = async (baseUrl: string, token: string): Promise<void> => {
    await setConfig({ baseUrl, token })
    await recordBakeOverride()
  }

  it('a config typed into the popup after a Forget survives the next worker start', async () => {
    // The revoked-token scenario: the rig is baked, the baked token is
    // revoked server-side, the operator reaches the popup, hits Forget and
    // types a live URL and token. Forget deliberately drops the bake hash
    // (it is the "apply a changed config" path), which is exactly what let
    // the very next worker start re-adopt the stale file and restore the
    // dead token: the manual fix un-did itself.
    stageBake({ ...BASE, token: 'revoked-token', clientId: 'nymeria-browser-rig-1' })
    await adoptBakedConfig()
    await clearConfig()

    await popupConnect('https://rescue.example.test', 'live-token')

    expect(await adoptBakedConfig()).toBe(false)
    const config = await getConfig()
    expect(config.baseUrl).toBe('https://rescue.example.test')
    expect(config.token).toBe('live-token')
  })

  it('a NEW bake still wins over an override: re-configure is not blocked by it', async () => {
    stageBake({ ...BASE, token: 'revoked-token' })
    await adoptBakedConfig()
    await clearConfig()
    await popupConnect('https://rescue.example.test', 'live-token')

    stageBake({ baseUrl: 'https://reconfigured.example.test', token: 'baked-again' })

    expect(await adoptBakedConfig()).toBe(true)
    const config = await getConfig()
    expect(config.baseUrl).toBe('https://reconfigured.example.test')
    expect(config.token).toBe('baked-again')
  })

  it('records the hash of the CURRENT file even when nothing had adopted it yet', async () => {
    // A rig configured by hand before its first worker start: the file is
    // there and has never been adopted, and the popup's config must still
    // outlive it.
    stageBake(BASE)

    await popupConnect('https://typed-first.example.test', 'typed-token')

    expect(await adoptBakedConfig()).toBe(false)
    expect((await getConfig()).baseUrl).toBe('https://typed-first.example.test')
  })

  it('stores nothing on a desktop build, where there is no bake to override', async () => {
    stageNoBake()

    await popupConnect('https://user-chose.test', 'user-token')

    expect(await storedHash()).toBeUndefined()
  })

  it('degrades quietly when storage rejects: the connect must not fail on bookkeeping', async () => {
    const warn = vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})
    stageBake(BASE)
    vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'))

    await expect(recordBakeOverride()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

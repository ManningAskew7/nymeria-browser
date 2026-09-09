/**
 * Worker bootstrap wiring: what happens when the service worker starts, and
 * WHEN a packaged config.json is (and is not) re-adopted.
 *
 * The module under test has top-level side effects by design (it IS the
 * worker's entry point), so every test re-imports it after `vi.resetModules()`
 * against a fresh chrome mock: importing index.ts is the worker starting.
 * Only the two seams that leave the worker are mocked, the SSE connection and
 * the HTTP client; storage and baked-config adoption are the real ones, so the
 * assertions land on observable state rather than on internal calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getConfig, BAKED_HASH_KEY } from '../utils/storage'
import type { PopupResponse } from '../shared/messages'

vi.mock('./connection', () => ({
  ensureConnected: vi.fn(async () => {}),
  startConnection: vi.fn(async () => {}),
  stopConnection: vi.fn(async () => {}),
  isRunning: vi.fn(() => false),
}))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    ping: vi.fn(async () => {}),
    whoami: vi.fn(async () => ({ id: 'default', email: 'a@b.test', display_name: 'A', role: 'admin' })),
  }
})

const BAKE = { baseUrl: 'https://baked.example.test', token: 'baked-token' }

/** Stage the package's config.json (or its absence) for the next worker start. */
const stageBake = (body: unknown | null): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (body === null) throw new TypeError('Failed to fetch')
      return { ok: true, text: async () => JSON.stringify(body) } as unknown as Response
    }),
  )
}

/**
 * Start the worker: import the entry point and wait for bootstrap to finish.
 *
 * `vi.resetModules()` re-runs index.ts (a fresh worker) but does NOT re-run
 * the mock factory, so the connection mock is one object for the whole test:
 * clear it first, or a second start's wait is satisfied by the first start's
 * call and the assertions race the bootstrap they are about.
 */
const startWorker = async (): Promise<typeof import('./connection')> => {
  const connection = await import('./connection')
  vi.mocked(connection.ensureConnected).mockClear()
  vi.resetModules()
  await import('./index')
  await vi.waitFor(() => expect(connection.ensureConnected).toHaveBeenCalled())
  return connection
}

/** Fire the heartbeat alarm the way chrome.alarms would. */
const fireHeartbeat = async (): Promise<void> => {
  const listener = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0]![0] as (a: {
    name: string
  }) => void
  listener({ name: 'nymeria-heartbeat' })
  await vi.waitFor(() => expect(vi.mocked(chrome.alarms.create)).toHaveBeenCalled())
}

/** Send a popup request through the real onMessage handler. */
const fromPopup = async (msg: Record<string, unknown>): Promise<PopupResponse> => {
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0] as (
    msg: unknown,
    sender: unknown,
    sendResponse: (r: PopupResponse) => void,
  ) => boolean
  return await new Promise<PopupResponse>((resolve) => {
    listener(msg, {}, resolve)
  })
}

const popupConnect = (baseUrl: string, token: string): Promise<PopupResponse> =>
  fromPopup({ kind: 'connect', baseUrl, token })

const popupForget = (): Promise<PopupResponse> => fromPopup({ kind: 'forget' })

const storedHash = async (): Promise<string | undefined> =>
  ((await chrome.storage.local.get(BAKED_HASH_KEY)) as { bakedHash?: string }).bakedHash

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  stageBake(null)
})

describe('bootstrap', () => {
  it('arms the heartbeat alarm and connects', async () => {
    const connection = await startWorker()

    expect(chrome.alarms.create).toHaveBeenCalledWith('nymeria-heartbeat', { periodInMinutes: 1 })
    expect(connection.ensureConnected).toHaveBeenCalled()
  })

  it('adopts a packaged config before it connects, so the first stream uses it', async () => {
    stageBake(BAKE)

    await startWorker()

    const config = await getConfig()
    expect(config.baseUrl).toBe(BAKE.baseUrl)
    expect(config.token).toBe(BAKE.token)
    expect(await storedHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never stops a connection to apply a bake: adoption happens before the first connect', async () => {
    // There is no live-restart path in the extension and there cannot be
    // one: adoption runs only here, at worker start, and an SSE-connected
    // MV3 worker does not recycle, so the branch that stopped a "live"
    // connection could only ever fire in a race between two bootstraps,
    // where its stopConnection() would flash `unconfigured` in the popup of
    // a perfectly configured install. What makes a re-bake land on a running
    // rig is the backend restarting it.
    stageBake(BAKE)
    const { isRunning, stopConnection } = await import('./connection')
    vi.mocked(isRunning).mockReturnValue(true)

    await startWorker()

    expect(vi.mocked(stopConnection)).not.toHaveBeenCalled()
  })

  it('still arms the alarm and connects when adoption throws', async () => {
    // chrome.storage.local.set REJECTS when over quota, and adoption writes
    // to it. Everything after adoption is the worker's whole job: losing the
    // heartbeat and the connect to a bookkeeping failure would leave the rig
    // silently dead rather than running on the config it already had.
    stageBake(BAKE)
    // Seeded so the failing write is adoption's own: ensureClientId writes
    // too, and this test is about what adoption's failure costs.
    await chrome.storage.local.set({ clientId: 'nymeria-browser-rig-1' })
    vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const connection = await startWorker()

    expect(chrome.alarms.create).toHaveBeenCalledWith('nymeria-heartbeat', { periodInMinutes: 1 })
    expect(connection.ensureConnected).toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
  })
})

describe('the heartbeat alarm', () => {
  it('reconnects but does NOT re-read the packaged config', async () => {
    // Re-adoption is a worker-start event, deliberately: the alarm fires
    // every minute for the life of the worker, and re-reading the package on
    // each tick would let a re-bake overwrite a popup-set config a minute
    // later, from a path with no user action behind it.
    stageBake(BAKE)
    const connection = await startWorker()
    vi.mocked(connection.ensureConnected).mockClear()
    stageBake({ baseUrl: 'https://rebaked.example.test', token: 'rebaked-token' })

    await fireHeartbeat()

    expect(connection.ensureConnected).toHaveBeenCalledTimes(1)
    expect((await getConfig()).baseUrl).toBe(BAKE.baseUrl)
  })
})

describe('the popup Connect path', () => {
  it('records the bake it overrides, so a worker restart does not undo it', async () => {
    // The rescue scenario end to end, in the order a person performs it: a
    // baked rig whose token was revoked server-side, Forget (which clears
    // the config AND the bake hash), a fresh URL and token typed in, then
    // the next worker start. That cleared hash is what made the stale bake
    // win the restart and put the dead token back, silently.
    stageBake(BAKE)
    await startWorker()
    await popupForget()

    const response = await popupConnect('https://rescue.example.test', 'live-token')
    expect(response.ok).toBe(true)

    await startWorker()

    const config = await getConfig()
    expect(config.baseUrl).toBe('https://rescue.example.test')
    expect(config.token).toBe('live-token')
  })

  it('leaves Forget re-arming adoption: a Forget with no config typed after it re-adopts', async () => {
    // The documented "apply a changed config" path, unchanged: Forget alone
    // re-arms adoption. Only a config actually entered afterwards claims the
    // bake, so the two rules do not fight.
    stageBake(BAKE)
    await startWorker()

    await popupForget()
    expect(await storedHash()).toBeUndefined()

    await startWorker()

    expect((await getConfig()).baseUrl).toBe(BAKE.baseUrl)
  })
})

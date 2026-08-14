import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeConnectFailure, ensureConnected, startConnection, stopConnection } from './connection'
import { HttpError, whoami } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, whoami: vi.fn(actual.whoami) }
})
vi.mock('../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/storage')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({
      baseUrl: 'http://localhost:1',
      token: 'tok',
      clientId: 'nymeria-browser-test',
    })),
  }
})
vi.mock('./state', () => ({
  setStatus: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}))

/**
 * The string these produce is rendered verbatim in the popup's status card,
 * so it is a diagnosis shown to a person, not a log line.
 */
describe('describeConnectFailure', () => {
  it('does not call an unreachable backend an auth problem', async () => {
    // What a closed SSH tunnel, a stopped backend, or a container mid-restart
    // all look like: the request never arrived, so nothing ever judged the
    // token. Observed 2026-08-12 when deploy-sync restarted the API while the
    // extension was reconnecting, which reported "auth (network)".
    const reason = describeConnectFailure(new TypeError('Failed to fetch'))

    expect(reason).not.toMatch(/auth|token/i)
    expect(reason).toMatch(/reach/i)
  })

  it('names a rejected token as one, and only for the statuses that mean it', () => {
    expect(describeConnectFailure(new HttpError(401, ''))).toMatch(/token rejected/i)
    expect(describeConnectFailure(new HttpError(403, ''))).toMatch(/token rejected/i)
    // A 500 is the backend failing, not the credential being wrong.
    expect(describeConnectFailure(new HttpError(500, ''))).not.toMatch(/token/i)
    expect(describeConnectFailure(new HttpError(500, ''))).toMatch(/backend error/i)
  })
})

describe('heartbeat vs backoff', () => {
  afterEach(async () => {
    await stopConnection()
    vi.mocked(whoami).mockReset()
  })

  it('the heartbeat preempts a pending backoff instead of deferring to it', async () => {
    // The alarm's whole purpose is to bound reconnection at about a minute,
    // and the backend's #172 dispatch grace is sized to that promise. Without
    // preemption, ensureConnected() sees running=true and returns, so a
    // pending 60s+jitter retry pushes the next attempt past the window.
    vi.mocked(whoami).mockRejectedValue(new TypeError('Failed to fetch'))

    await startConnection()
    expect(vi.mocked(whoami)).toHaveBeenCalledTimes(1)
    // A retry is now scheduled. Do NOT advance timers: the alarm must not
    // need the backoff to elapse.
    await ensureConnected()

    expect(vi.mocked(whoami), 'the alarm must retry now, not defer to the backoff').toHaveBeenCalledTimes(2)
  })
})

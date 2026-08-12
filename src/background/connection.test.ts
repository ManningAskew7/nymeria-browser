import { describe, expect, it } from 'vitest'
import { describeConnectFailure } from './connection'
import { HttpError } from './api'

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

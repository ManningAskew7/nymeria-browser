import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeConnectFailure, ensureConnected, startConnection, stopConnection } from './connection'
import { HttpError, whoami } from './api'
import { dispatchBrowserCommand } from './commands'
import { handleLoginInput } from './commands/login_session'
import { recordEvent } from './state'
import { backgroundLogger } from '../utils/logger'
import { getConfig } from '../utils/storage'
import type { BrowserCommandEvent } from '../shared/types'

/** What getConfig answers for an ordinary popup-configured install. */
const DESKTOP_CONFIG = {
  baseUrl: 'http://localhost:1',
  token: 'tok',
  clientId: 'nymeria-browser-test',
  hasToken: true,
  kind: 'desktop' as const,
  label: '',
}

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, whoami: vi.fn(actual.whoami) }
})
vi.mock('../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/storage')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => DESKTOP_CONFIG),
  }
})
vi.mock('./state', () => ({
  setStatus: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}))
vi.mock('./commands', () => ({ dispatchBrowserCommand: vi.fn(async () => {}) }))
vi.mock('./commands/login_session', () => ({ handleLoginInput: vi.fn(async () => {}) }))

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

describe('subscribe URL', () => {
  afterEach(async () => {
    await stopConnection()
    vi.mocked(whoami).mockReset()
    vi.mocked(getConfig).mockClear()
    vi.unstubAllGlobals()
  })

  /** Run one connect attempt and return the stream URL it opened. */
  async function subscribeUrl(): Promise<URL> {
    vi.mocked(whoami).mockResolvedValue({ user_id: 'u1' } as never)
    const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 500 }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await startConnection()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    return new URL(String(fetchSpy.mock.calls[0]![0]))
  }

  it('announces the running build version on the subscribe (#176 rider)', async () => {
    // The backend records this per subscriber so chrome_reload_extension can
    // report which build reconnected after a reload; without the param the
    // deploy-verification loop stays open.
    const url = await subscribeUrl()
    expect(url.pathname).toBe('/autonomous/stream')
    expect(url.searchParams.get('client_id')).toBe('nymeria-browser-test')
    expect(url.searchParams.get('client_version')).toBe('9.9.9')
  })

  it('always announces client_kind, and omits client_label when none is stored', async () => {
    // Every existing install reads as a desktop browser on the backend's
    // roster; an absent label must not arrive as an empty string that a
    // profile could be seeded with.
    const url = await subscribeUrl()
    expect(url.searchParams.get('client_kind')).toBe('desktop')
    expect(url.searchParams.has('client_label')).toBe(false)
  })

  it('a server browser announces client_kind=server and its baked label', async () => {
    vi.mocked(getConfig).mockResolvedValueOnce({ ...DESKTOP_CONFIG, kind: 'server', label: 'server browser' })

    const url = await subscribeUrl()
    expect(url.searchParams.get('client_kind')).toBe('server')
    expect(url.searchParams.get('client_label')).toBe('server browser')
  })
})

/**
 * The journal is bookkeeping; the command is the job. These pin that order,
 * because the reverse (journal first, awaited, inside the same try) meant a
 * `chrome.storage.local` quota rejection ATE the command: uploads past its
 * 10MB cap never ran and rode the backend transport timeout out as a page
 * problem.
 */
describe('journal vs dispatch', () => {
  afterEach(async () => {
    await stopConnection()
    vi.mocked(whoami).mockReset()
    vi.mocked(recordEvent).mockReset()
    vi.mocked(dispatchBrowserCommand).mockReset()
    vi.unstubAllGlobals()
  })

  function uploadCommand(commandId: string): Record<string, unknown> {
    return {
      type: 'browser_command',
      thread_id: 't1',
      command_id: commandId,
      command_type: 'act',
      args: { tab_id: 1, action: 'upload', file_base64: 'A'.repeat(4096) },
      timeout_seconds: 60,
    }
  }

  /** Feed the reader a finite SSE body, then let the connection drain it. */
  async function deliver(...frames: string[]): Promise<void> {
    vi.mocked(whoami).mockResolvedValue({ user_id: 'u1' } as never)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, body }) as unknown as Response),
    )
    await startConnection()
  }

  function frameOf(event: Record<string, unknown>): string {
    return `data: ${JSON.stringify(event)}\n\n`
  }

  it('executes the command even when the journal write is rejected, and says so', async () => {
    // What an over-quota `chrome.storage.local.set` does: a rejected promise.
    vi.mocked(recordEvent).mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'))
    const warn = vi.spyOn(backgroundLogger, 'warn').mockImplementation(() => {})

    try {
      await deliver(frameOf(uploadCommand('cmd-1')))

      expect(vi.mocked(dispatchBrowserCommand)).toHaveBeenCalledTimes(1)
      const dispatched = vi.mocked(dispatchBrowserCommand).mock.calls[0]![0] as BrowserCommandEvent
      expect(dispatched.command_id).toBe('cmd-1')
      // Diagnosed, not swallowed: an uncaught one is a bare unhandled
      // rejection in the service worker, which names neither the cause nor
      // the fact that only bookkeeping was lost.
      const journalWarning = warn.mock.calls.find((call) => String(call[0]).includes('journal'))
      expect(journalWarning, 'a failed journal write must be logged').toBeDefined()
      expect(String(journalWarning?.[1])).toMatch(/QUOTA_BYTES/)
    } finally {
      warn.mockRestore()
    }
  })

  it('dispatches first, so no journal write can delay or reorder the command', async () => {
    const order: string[] = []
    vi.mocked(dispatchBrowserCommand).mockImplementation(async () => {
      order.push('dispatch')
    })
    vi.mocked(recordEvent).mockImplementation(async () => {
      order.push('journal')
    })

    await deliver(frameOf(uploadCommand('cmd-2')))

    expect(order).toEqual(['dispatch', 'journal'])
  })

  it('keeps delivering the frames behind one whose journal write failed', async () => {
    // The narrow version of this bug survives the reorder: AWAIT the journal
    // after dispatching and a rejection still escapes into the reader's own
    // try, which tears the stream down and loses every frame already parsed
    // out of the same chunk. Two frames in one chunk is what shows it.
    vi.mocked(recordEvent).mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))

    await deliver(frameOf(uploadCommand('cmd-a')) + frameOf(uploadCommand('cmd-b')))

    const dispatched = vi
      .mocked(dispatchBrowserCommand)
      .mock.calls.map((call) => (call[0] as BrowserCommandEvent).command_id)
    expect(dispatched).toEqual(['cmd-a', 'cmd-b'])
  })

  it('skips a malformed frame and keeps reading the ones after it', async () => {
    await deliver('data: {not json\n\n', frameOf(uploadCommand('cmd-3')))

    expect(vi.mocked(dispatchBrowserCommand)).toHaveBeenCalledTimes(1)
    const dispatched = vi.mocked(dispatchBrowserCommand).mock.calls[0]![0] as BrowserCommandEvent
    expect(dispatched.command_id).toBe('cmd-3')
    // The unparseable frame is not journalled either, and does not stop the
    // journal for what follows.
    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1)
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


/**
 * An operator's keystrokes reach the extension over this same stream while
 * they sign the browser into a site. The journal writes to
 * `chrome.storage.local`, which PERSISTS across restarts, so journalling
 * this one event type would leave the characters of somebody's password
 * sitting in extension storage: exactly what the login handoff exists to
 * prevent, and invisible if it ever regressed.
 */
describe('login input is handled but never journalled', () => {
  afterEach(async () => {
    await stopConnection()
    vi.mocked(whoami).mockReset()
    vi.mocked(recordEvent).mockReset()
    vi.mocked(handleLoginInput).mockReset()
    vi.unstubAllGlobals()
  })

  async function deliver(...frames: string[]): Promise<void> {
    vi.mocked(whoami).mockResolvedValue({ user_id: 'u1' } as never)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body }) as unknown as Response))
    await startConnection()
  }

  const loginInput = {
    type: 'browser_login_input',
    thread_id: 't1',
    data: {
      session_id: 'blogin_abc',
      tab_id: 7,
      events: [{ type: 'key', key: 'h' }],
    },
  }

  it('replays the input and keeps it out of the journal', async () => {
    await deliver(`data: ${JSON.stringify(loginInput)}\n\n`)

    expect(vi.mocked(handleLoginInput)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(handleLoginInput).mock.calls[0]![0]).toMatchObject({
      session_id: 'blogin_abc',
      tab_id: 7,
    })
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled()
  })

  it('still journals ordinary events, so the skip is this type alone', async () => {
    await deliver(`data: ${JSON.stringify({ type: 'todo_completed', thread_id: 't1' })}\n\n`)

    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(handleLoginInput)).not.toHaveBeenCalled()
  })
})

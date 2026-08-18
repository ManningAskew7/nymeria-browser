import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execHealth } from './health'
import {
  installCdpEventRouter,
  installDetachHandler,
  resetForTests as resetDebugger,
  sendCommand,
} from '../debuggerSession'
import { installCdpConsoleCapture, resetForTests as resetConsole } from '../consoleBuffer'
import { installCdpNetworkCapture, resetForTests as resetNetwork } from '../networkBuffer'
import { resetDialogsForTests } from '../dialogs'
import {
  recordProvenDelivery,
  recordSwallowedInput,
  resetForTests as resetDelivery,
} from '../delivery'
import { readDriveStamp, recordDrive, WORKER_STARTED_AT } from '../driveStamp'
import { installNavWatch, resetForTests as resetNav } from '../navWatch'
import { resetForTests as resetRefs, set as setRefs, type RefTarget } from '../snapshotRefs'
import { installStatusWatch, resetForTests as resetStatus } from '../statusWatch'

const TAB = 1
const TAB_URL = 'https://example.com'

type CdpListener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params: unknown,
) => void

function wireCapture(): CdpListener {
  installCdpEventRouter()
  installCdpConsoleCapture()
  installCdpNetworkCapture()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

/** Attach the tab the way any earlier command would have. */
async function attach(): Promise<void> {
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
}

/** End the session the external way (DevTools, banner, linger): the path
 * that leaves buffers intact, exactly what a between-commands lapse does. */
function detachTab(): void {
  installDetachHandler()
  const addListener = chrome.debugger.onDetach.addListener as unknown as ReturnType<typeof vi.fn>
  const listener = addListener.mock.calls.at(-1)?.[0] as (
    source: { tabId: number },
    reason: string,
  ) => void
  listener({ tabId: TAB }, 'canceled_by_user')
}

function ref(backendNodeId: number): RefTarget {
  return { backendNodeId, role: 'button', name: 'Go' }
}

function payload(result: { data?: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>
}

beforeEach(() => {
  resetDebugger()
  resetConsole()
  resetNetwork()
  resetDialogsForTests()
  resetDelivery()
  resetNav()
  resetRefs()
  resetStatus()
})

describe('execHealth', () => {
  it('refuses without a tab_id before touching the browser', async () => {
    const result = await execHealth({})

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tab_id/)
  })

  it('names a closed tab instead of reporting on nothing', async () => {
    const result = await execHealth({ tab_id: 999 })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not exist/)
    expect(result.error).toMatch(/chrome_tabs/)
  })

  it('reports a never-driven tab honestly, and does NOT attach it', async () => {
    // The whole point of the read: no side effects. An attach here would
    // start capture the caller did not ask for and flip the very state
    // being reported.
    const result = await execHealth({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const data = payload(result)
    expect(data.attached).toBe(false)
    expect(data.ever_attached_this_worker).toBe(false)
    expect(data.console_entries).toBe(0)
    expect(data.network_entries).toBe(0)
    expect(data.refs).toEqual({ held: 0, minted_total: 0 })
    expect(data.last_driven).toBeUndefined()
    expect(data.dialog).toBeUndefined()
    expect(data.input_swallowed).toBeUndefined()
    expect(data.capture_gap_ms).toBeUndefined()
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('does not stamp itself as driving the tab', async () => {
    // A passive diagnostic must not overwrite when the tab was last actually
    // driven, or "last_driven" degenerates into "last asked about".
    await execHealth({ tab_id: TAB })

    expect(await readDriveStamp(TAB)).toBeNull()
  })

  it('reports the tab, attach state and buffer counts on a driven tab', async () => {
    const emit = wireCapture()
    await attach()
    emit({ tabId: TAB }, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'hello' }],
      timestamp: Date.now(),
    })
    emit({ tabId: TAB }, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api', method: 'GET' },
      type: 'XHR',
    })

    const attachCalls = (chrome.debugger.attach as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length
    const cdpCalls = (chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length

    const data = payload(await execHealth({ tab_id: TAB }))

    const tab = data.tab as Record<string, unknown>
    expect(tab.id).toBe(TAB)
    expect(tab.url).toBe(TAB_URL)
    expect(data.attached).toBe(true)
    expect(data.ever_attached_this_worker).toBe(true)
    expect(data.console_entries).toBe(1)
    expect(data.network_entries).toBe(1)
    // Attached means no lapse to measure.
    expect(data.capture_gap_ms).toBeUndefined()
    // The no-attach contract holds on a DRIVEN tab too, not only a cold one:
    // neither a new attach nor any CDP traffic at all.
    expect(
      (chrome.debugger.attach as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
      'health must not re-attach the session',
    ).toBe(attachCalls)
    expect(
      (chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
      'health must send no CDP commands',
    ).toBe(cdpCalls)
  })

  it('reports how long capture has been lapsed once the session ends', async () => {
    wireCapture()
    await attach()
    detachTab()

    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.attached).toBe(false)
    expect(data.ever_attached_this_worker).toBe(true)
    expect(typeof data.capture_gap_ms).toBe('number')
    expect(data.capture_gap_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('reports a standing dialog instead of refusing like a page read would', async () => {
    installCdpEventRouter()
    const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
    const route = addListener.mock.calls.at(-1)?.[0] as CdpListener
    route({ tabId: TAB }, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Sure?',
      url: TAB_URL,
    })

    const result = await execHealth({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const dialog = payload(result).dialog as Record<string, unknown>
    // The shared standingDialogPayload shape (same keys act/navigate/reads
    // emit), plus health's own age.
    expect(dialog.type).toBe('confirm')
    expect(dialog.message).toBe('Sure?')
    expect(typeof dialog.age_ms).toBe('number')
    expect(typeof dialog.expires_in_ms).toBe('number')
    expect((dialog.expires_in_ms as number) > 0).toBe(true)
    expect(String(dialog.answer_with)).toContain('chrome_dialog')
  })

  it('reports a recently resolved dialog when nothing stands', async () => {
    installCdpEventRouter()
    const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
    const route = addListener.mock.calls.at(-1)?.[0] as CdpListener
    route({ tabId: TAB }, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Sure?',
      url: TAB_URL,
    })
    route({ tabId: TAB }, 'Page.javascriptDialogClosed', { result: false })

    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.dialog).toBeUndefined()
    const resolved = data.dialog_resolved as Record<string, unknown>
    expect(resolved.type).toBe('confirm')
    // The shared describeResolution prose, not raw by/accepted codes: a
    // cold reader should not need the AnsweredBy enum to know what happened.
    expect(String(resolved.resolution)).toMatch(/dismissed|accepted/)
    expect(typeof resolved.age_ms).toBe('number')
  })

  it('carries the last main-frame HTTP status as a record, with the auth inference', async () => {
    installStatusWatch()
    const addListener = chrome.webRequest!.onResponseStarted
      .addListener as unknown as ReturnType<typeof vi.fn>
    const listener = addListener.mock.calls.at(-1)?.[0] as (details: unknown) => void
    listener({ type: 'main_frame', tabId: TAB, url: TAB_URL, statusCode: 404, timeStamp: Date.now() })

    const notFound = payload(await execHealth({ tab_id: TAB }))
    const status = notFound.http_status as Record<string, unknown>
    expect(status.status).toBe(404)
    expect(status.url).toBe(TAB_URL)
    expect(typeof status.age_ms).toBe('number')
    expect(notFound.auth_prompt_likely).toBeUndefined()

    listener({ type: 'main_frame', tabId: TAB, url: TAB_URL, statusCode: 401, timeStamp: Date.now() })
    const challenged = payload(await execHealth({ tab_id: TAB }))
    expect((challenged.http_status as Record<string, unknown>).status).toBe(401)
    expect(challenged.auth_prompt_likely).toBe(true)
  })

  it('says nothing about http status when there is no record (no grant, no claim)', async () => {
    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.http_status).toBeUndefined()
    expect(data.auth_prompt_likely).toBeUndefined()
  })

  it('reports held and minted refs with the snapshot url', async () => {
    setRefs(TAB, new Map([['e1', ref(100)], ['e2', ref(101)]]), TAB_URL, 2)

    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.refs).toEqual({ held: 2, minted_total: 2, snapshot_url: TAB_URL })
  })

  it('reports when the tab was last driven and by which command', async () => {
    recordDrive(TAB, 'act')
    // The write is fire-and-forget; let the microtask land.
    await Promise.resolve()

    const data = payload(await execHealth({ tab_id: TAB }))

    const driven = data.last_driven as Record<string, unknown>
    expect(driven.command).toBe('act')
    expect(typeof driven.age_ms).toBe('number')
    expect(data.worker_recycled_since_drive).toBeUndefined()
  })

  it('discloses a worker recycle since the last drive (#179 asymmetry)', async () => {
    // A stamp older than this worker life can only have been written by a
    // previous worker: attach state and buffers reset in between, refs did
    // not, and the read must say so rather than let the zeros read as page
    // facts.
    await chrome.storage.session.set({
      [`nymDriven:${TAB}`]: { at: WORKER_STARTED_AT - 5_000, command: 'act' },
    })

    const data = payload(await execHealth({ tab_id: TAB }))

    expect((data.last_driven as Record<string, unknown>).command).toBe('act')
    expect(data.worker_recycled_since_drive).toBe(true)
  })

  it('ignores a malformed drive stamp instead of reporting garbage', async () => {
    await chrome.storage.session.set({ [`nymDriven:${TAB}`]: { at: 'yesterday', command: 7 } })

    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.last_driven).toBeUndefined()
  })

  it('reports positive delivery evidence with its document check (#202)', async () => {
    recordProvenDelivery(TAB, 'click', TAB_URL, 0)
    await Promise.resolve()

    const data = payload(await execHealth({ tab_id: TAB }))

    const ok = data.input_ok as Record<string, unknown>
    expect(ok.action).toBe('click')
    expect(typeof ok.age_ms).toBe('number')
    expect(ok.url).toBe(TAB_URL)
    expect(ok.on_current_url).toBe(true)
  })

  it('a stamp from an EARLIER document says so instead of masquerading (#202)', async () => {
    // The stale-claim guard: proof about a previous document must not read
    // as evidence about the one the tab now shows.
    recordProvenDelivery(TAB, 'fill', 'https://example.com/checkout/step-1', 0)
    await Promise.resolve()

    const data = payload(await execHealth({ tab_id: TAB }))

    expect((data.input_ok as Record<string, unknown>).on_current_url).toBe(false)
  })

  it('a coincidental RETURN to the stamped URL never reads true: identity is the seq (#202 QA)', async () => {
    // Measured live (v0.13.0 round): a 21s-old stamp read on_current_url
    // true because the tab had navigated AWAY and BACK to the URL the
    // stamp was earned on. Same URL text, different document. The stamp's
    // pre-action commit seq is the identity; a mismatch is false no
    // matter what the URL says.
    recordProvenDelivery(TAB, 'click', TAB_URL, 5)
    await Promise.resolve()

    const data = payload(await execHealth({ tab_id: TAB }))

    const ok = data.input_ok as Record<string, unknown>
    expect(ok.url).toBe(TAB_URL)
    expect(ok.on_current_url).toBe(false)
  })

  it('a cross-recycle stamp shows its url but OMITS the identity claim (#202)', async () => {
    // navWatch's seq lives in worker memory: a stamp from a previous
    // worker cannot be judged against it, and unknown must be absence,
    // never a guess in either direction.
    await chrome.storage.session.set({
      [`nymInputOk:${TAB}`]: {
        at: WORKER_STARTED_AT - 5_000,
        action: 'click',
        url: TAB_URL,
        navSeq: 0,
      },
    })

    const data = payload(await execHealth({ tab_id: TAB }))

    const ok = data.input_ok as Record<string, unknown>
    expect(ok.action).toBe('click')
    expect(ok.url).toBe(TAB_URL)
    expect('on_current_url' in ok).toBe(false)
  })

  it('a stamp without a usable seq also omits the identity claim (#202)', async () => {
    await chrome.storage.session.set({
      [`nymInputOk:${TAB}`]: { at: Date.now(), action: 'click', url: TAB_URL, navSeq: 'zero' },
    })

    const data = payload(await execHealth({ tab_id: TAB }))

    const ok = data.input_ok as Record<string, unknown>
    expect(ok.url).toBe(TAB_URL)
    expect('on_current_url' in ok).toBe(false)
  })

  it('ignores a malformed positive stamp instead of reporting garbage (#202)', async () => {
    await chrome.storage.session.set({ [`nymInputOk:${TAB}`]: { at: true, action: 3, url: 9 } })

    const data = payload(await execHealth({ tab_id: TAB }))

    expect(data.input_ok).toBeUndefined()
  })

  it('reports swallowed-input evidence, including across a worker recycle', async () => {
    recordSwallowedInput(TAB, 'click')
    const live = payload(await execHealth({ tab_id: TAB }))
    const evidence = live.input_swallowed as Record<string, unknown>
    expect(evidence.action).toBe('click')
    expect(typeof evidence.age_ms).toBe('number')

    // Recycle: the in-memory map dies, the storage mirror does not, and the
    // suppression the evidence describes survives workers (measured), so the
    // report must too.
    resetDelivery()
    const hydrated = payload(await execHealth({ tab_id: TAB }))
    expect((hydrated.input_swallowed as Record<string, unknown>).action).toBe('click')
  })

  it('reports a navigation still in flight', async () => {
    installNavWatch()
    const addListener = chrome.webNavigation!.onBeforeNavigate
      .addListener as unknown as ReturnType<typeof vi.fn>
    const listener = addListener.mock.calls.at(-1)?.[0] as (details: unknown) => void
    listener({ tabId: TAB, frameId: 0, url: 'https://example.com/slow', timeStamp: Date.now() })

    const data = payload(await execHealth({ tab_id: TAB }))

    const pending = data.navigation_pending as Record<string, unknown>
    expect(pending.url).toBe('https://example.com/slow')
    expect(typeof pending.age_ms).toBe('number')
  })
})

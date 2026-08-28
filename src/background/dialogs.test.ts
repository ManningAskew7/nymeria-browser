import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquire,
  installCdpEventRouter,
  installDetachHandler,
  release,
  releaseAllHolds,
  resetForTests as resetDebugger,
} from './debuggerSession'
import {
  answerStandingDialog,
  chooserInterceptedSince,
  clearTabDialogState,
  describeResolution,
  dialogStandingSignal,
  expectBeforeunloadAccept,
  lastResolvedDialog,
  resetDialogsForTests,
  resolvedDialogSince,
  standingDialog,
} from './dialogs'

const TAB = 7

type Fire = (tabId: number, method: string, params?: unknown) => void

/**
 * The real event route: re-bind the module's router to the fresh chrome mock
 * and speak to it exactly as Chrome would, so these tests exercise the same
 * path production events take (router -> dialogs handler), not a private
 * seam.
 */
function cdpEvents(): Fire {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const route = addListener.mock.calls.at(-1)![0] as (
    source: { tabId?: number },
    method: string,
    params: unknown,
  ) => void
  return (tabId, method, params = {}) => route({ tabId }, method, params)
}

function mockCdp() {
  const sendCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}))
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

function answersOf(mock: ReturnType<typeof mockCdp>) {
  return mock.mock.calls
    .filter((c) => c[1] === 'Page.handleJavaScriptDialog')
    .map((c) => c[2] as { accept: boolean; promptText?: string })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDebugger()
  resetDialogsForTests()
  ;(chrome.debugger.attach as unknown) = vi.fn(async () => undefined)
  ;(chrome.debugger.detach as unknown) = vi.fn(async () => undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('per-class policy at open', () => {
  it('acknowledges an alert immediately and reports it as history', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    const before = Date.now()

    fire(TAB, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved!', url: 'https://x' })

    // Answered without anyone asking, and never visible as "standing": there
    // is no decision an agent could contribute to an alert.
    expect(standingDialog(TAB)).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(answersOf(cdp)).toEqual([{ accept: true }])

    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    const resolved = resolvedDialogSince(TAB, before)
    expect(resolved?.type).toBe('alert')
    expect(resolved?.message).toBe('Saved!')
    expect(resolved?.by).toBe('policy')
    expect(describeResolution(resolved!)).toMatch(/auto-acknowledged/)
  })

  it('holds a confirm for the agent with the grace deadline armed', () => {
    const cdp = mockCdp()
    const fire = cdpEvents()

    fire(TAB, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Delete this item?',
      url: 'https://x',
    })

    const d = standingDialog(TAB)
    expect(d?.type).toBe('confirm')
    expect(d?.message).toBe('Delete this item?')
    expect(d!.deadlineAt - Date.now()).toBeGreaterThan(50_000)
    expect(answersOf(cdp), 'held means HELD: nothing answered yet').toEqual([])
  })

  it('keeps a prompt default so the agent knows what empty means', () => {
    mockCdp()
    const fire = cdpEvents()

    fire(TAB, 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Name?',
      defaultPrompt: 'anonymous',
    })

    expect(standingDialog(TAB)?.defaultPrompt).toBe('anonymous')
  })

  it('holds a beforeunload like a confirm when no close intent is registered', () => {
    const cdp = mockCdp()
    const fire = cdpEvents()

    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })

    expect(standingDialog(TAB)?.type).toBe('beforeunload')
    expect(answersOf(cdp)).toEqual([])
  })

  it('accepts a beforeunload immediately when a close intent is in flight', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()

    expectBeforeunloadAccept(TAB)
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })

    await vi.advanceTimersByTimeAsync(0)
    expect(answersOf(cdp)).toEqual([{ accept: true }])
    // Consumed: the NEXT beforeunload (nothing to do with the close) is held.
    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    expect(standingDialog(TAB)?.type).toBe('beforeunload')
  })

  it('lets a close intent expire: a much later beforeunload is not its beforeunload', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()

    expectBeforeunloadAccept(TAB)
    await vi.advanceTimersByTimeAsync(16_000) // past the intent TTL

    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    expect(standingDialog(TAB)?.type, 'a stale intent must not auto-leave a page').toBe(
      'beforeunload',
    )
    expect(answersOf(cdp)).toEqual([])
  })
})

describe('answering', () => {
  it('lets the agent answer a standing dialog, and records it as the agent', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?' })

    const result = await answerStandingDialog(TAB, true, 'Nymeria')
    expect(result.outcome).toBe('answered')
    expect(answersOf(cdp)).toEqual([{ accept: true, promptText: 'Nymeria' }])

    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    expect(lastResolvedDialog(TAB)?.by).toBe('agent')
    expect(describeResolution(lastResolvedDialog(TAB)!)).toMatch(/accepted via chrome_dialog/)
  })

  it('dismisses an unanswered confirm at the grace deadline', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    await vi.advanceTimersByTimeAsync(59_000)
    expect(answersOf(cdp)).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(answersOf(cdp), 'the safe default is dismiss').toEqual([{ accept: false }])

    fire(TAB, 'Page.javascriptDialogClosed', { result: false })
    expect(lastResolvedDialog(TAB)?.by).toBe('timeout')
    expect(describeResolution(lastResolvedDialog(TAB)!)).toMatch(/dismissed automatically/)
  })

  it('credits the user when the dialog closes with no answer of ours in flight', async () => {
    mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    fire(TAB, 'Page.javascriptDialogClosed', { result: true })

    expect(standingDialog(TAB)).toBeNull()
    expect(lastResolvedDialog(TAB)?.by).toBe('user')
    // A late chrome_dialog learns what happened instead of a bare "no dialog".
    const late = await answerStandingDialog(TAB, true)
    expect(late.outcome).toBe('already-resolved')
  })

  it('reports none honestly when nothing stands and nothing resolved recently', async () => {
    mockCdp()
    const result = await answerStandingDialog(TAB, true)
    expect(result.outcome).toBe('none')
  })

  it('does not double-send while an answer is already in flight', async () => {
    const cdp = mockCdp()
    cdp.mockImplementation(async (_target: unknown, method: unknown) => {
      if (method === 'Page.handleJavaScriptDialog') return new Promise<never>(() => undefined)
      return {}
    })
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    const first = answerStandingDialog(TAB, true) // hangs on the CDP call
    await vi.advanceTimersByTimeAsync(0)
    const second = await answerStandingDialog(TAB, false)

    expect(second.outcome, 'an in-flight answer is not answerable again').toBe('none')
    expect(answersOf(cdp)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_000) // let the hung call hit its deadline
    await first
  })

  it('stops mentioning a resolved dialog once it is old news', async () => {
    mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    expect(lastResolvedDialog(TAB)).not.toBeNull()

    await vi.advanceTimersByTimeAsync(121_000)

    // A two-minute-old resolution explains nothing about the current page;
    // a late chrome_dialog gets the honest "none", not stale history.
    expect(lastResolvedDialog(TAB)).toBeNull()
    const late = await answerStandingDialog(TAB, true)
    expect(late.outcome).toBe('none')
  })
})

describe('signals and chooser records', () => {
  it('resolves a standing signal the moment a held dialog opens', async () => {
    mockCdp()
    const fire = cdpEvents()
    const sig = dialogStandingSignal(TAB)
    let seen: string | null = null
    void sig.promise.then((d) => {
      seen = d.type
    })

    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toBe('beforeunload')
  })

  it('records an intercepted chooser with its since-window', () => {
    mockCdp()
    const fire = cdpEvents()
    const before = Date.now()

    fire(TAB, 'Page.fileChooserOpened', { mode: 'selectMultiple' })

    expect(chooserInterceptedSince(TAB, before)?.mode).toBe('selectMultiple')
    expect(
      chooserInterceptedSince(TAB, Date.now() + 1),
      'an old interception must not fail a new act',
    ).toBeNull()
  })
})

describe('a failed answer call re-arms the safety net (#169 review)', () => {
  /** Fail the NEXT dialog answer only; enables and everything else succeed. */
  function failNextAnswer(cdp: ReturnType<typeof mockCdp>) {
    let failures = 1
    cdp.mockImplementation(async (_target: unknown, method: unknown) => {
      if (method === 'Page.handleJavaScriptDialog' && failures > 0) {
        failures -= 1
        throw new Error('boom')
      }
      return {}
    })
  }

  it('a failed agent answer leaves the dialog standing WITH a live fallback', async () => {
    const cdp = mockCdp()
    failNextAnswer(cdp)
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    const result = await answerStandingDialog(TAB, true)
    expect(result.outcome).toBe('failed')

    // Standing again, deadline honest (in the future), and the fallback must
    // actually FIRE: without the re-arm the record stood forever with no
    // timer while every message kept promising an automatic dismissal.
    const d = standingDialog(TAB)
    expect(d).not.toBeNull()
    expect(d!.deadlineAt).toBeGreaterThan(Date.now())
    await vi.advanceTimersByTimeAsync(61_000)
    expect(answersOf(cdp).at(-1), 'the class default still answers it').toEqual({ accept: false })
  })

  it('a failed alert acknowledgement arms a retry instead of standing forever', async () => {
    const cdp = mockCdp()
    failNextAnswer(cdp)
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved!' })
    await vi.advanceTimersByTimeAsync(0) // the policy ack goes out and fails

    // The alert path never armed a grace deadline (it answers at open), so
    // the failure must arm one now or deadlineAt stays 0 and the copy lies.
    const d = standingDialog(TAB)
    expect(d).not.toBeNull()
    expect(d!.deadlineAt).toBeGreaterThan(Date.now())
    await vi.advanceTimersByTimeAsync(6_000)
    expect(answersOf(cdp).at(-1), 'the retry still ACKS an alert').toEqual({ accept: true })
  })
})

describe('the attach boundary', () => {
  it('orphans a standing dialog when Chrome detaches externally', () => {
    mockCdp()
    installDetachHandler()
    const fire = cdpEvents()
    const onDetach = (
      chrome.debugger.onDetach.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)![0] as (source: { tabId?: number }, reason: string) => void
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    onDetach({ tabId: TAB }, 'canceled_by_user')

    expect(standingDialog(TAB)).toBeNull()
    const last = lastResolvedDialog(TAB)
    expect(last?.by).toBe('orphaned')
    expect(describeResolution(last!)).toMatch(/only the user can clear it/)
  })

  it('holds a voluntary detach until the standing dialog resolves', async () => {
    // Since the #191 hold, the voluntary detach that meets a standing dialog
    // is ordinarily the TURN-END release (the 120s safety-net linger now
    // outlives the dialog grace, so the timer path rarely races a dialog).
    const cdp = mockCdp()
    const fire = cdpEvents()
    await acquire(TAB)
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    release(TAB)

    // The turn ends with the dialog standing: the detach must WAIT, or
    // ownership would end with an owned dialog unanswered.
    releaseAllHolds()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()

    // The user answers on screen; the gate releases and the detach proceeds.
    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(answersOf(cdp), 'nothing of ours answered it').toEqual([])
  })

  it('answers the class default itself before detaching when nobody else did', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    await acquire(TAB)
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    release(TAB)
    releaseAllHolds()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()

    // Ride past the grace deadline: the timeout default answers, and even
    // with Chrome never confirming via javascriptDialogClosed, the gate's
    // own bound releases the detach instead of pinning the session forever.
    await vi.advanceTimersByTimeAsync(65_000)
    expect(answersOf(cdp)).toEqual([{ accept: false }])
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('forgets a closed tab entirely: dialogs, chooser, and close intent', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    const before = Date.now()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    fire(TAB, 'Page.javascriptDialogClosed', { result: true })
    fire(TAB, 'Page.fileChooserOpened', { mode: 'selectSingle' })
    expectBeforeunloadAccept(TAB)

    clearTabDialogState(TAB)

    expect(standingDialog(TAB)).toBeNull()
    expect(lastResolvedDialog(TAB)).toBeNull()
    expect(chooserInterceptedSince(TAB, before), 'a dead tab cannot fail a new act').toBeNull()
    // The close intent died with the tab: a beforeunload on a REUSED tab id
    // must be held, not auto-accepted by a ghost.
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
    expect(standingDialog(TAB)?.type).toBe('beforeunload')
    expect(answersOf(cdp)).toEqual([])
  })
})

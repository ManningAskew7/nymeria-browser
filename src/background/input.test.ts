import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIONABILITY_FN,
  dispatchKey,
  FOCUS_LANDED_FN,
  HIT_TEST_FN,
  InputBudgetExhausted,
  InputDispatchStalled,
  insertText,
  clearWheelAckLatchForTab,
  modifierMask,
  resetWheelAckLatchForTests,
  SELECTOR_FACTS_FN,
  TEXT_ENTRY_FN,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedWheel,
  typeText,
} from './input'
import { resetForTests as resetDebugger } from './debuggerSession'

const TAB = 1

interface KeyEvent {
  type: string
  text?: string
  key?: string
  code?: string
  modifiers?: number
  windowsVirtualKeyCode?: number
}

function installCdpMock() {
  const sendCommand = vi.fn(async () => ({}))
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

function keyEvents(mock: ReturnType<typeof installCdpMock>): KeyEvent[] {
  return (mock.mock.calls as unknown as [unknown, string, KeyEvent][])
    .filter((c) => c[1] === 'Input.dispatchKeyEvent')
    .map((c) => c[2])
}

beforeEach(() => {
  resetDebugger()
  resetWheelAckLatchForTests()
})

describe('dispatchKey', () => {
  it('sends the character a named key produces, never the key NAME', async () => {
    // Found live, not in review: `text` was set to the key's name, so Enter
    // sent text:"Enter". CDP rejects any text longer than one character with
    // `-32602 Invalid 'text' parameter`, so every named key failed outright
    // and no form could be submitted with the keyboard.
    const mock = installCdpMock()

    await dispatchKey(TAB, 'Enter')

    const events = keyEvents(mock)
    for (const e of events) {
      if (e.text !== undefined) {
        expect(e.text.length, `text must be one character, got ${JSON.stringify(e.text)}`).toBe(1)
      }
    }
    expect(events[0].text).toBe('\r')
    expect(events[0].key).toBe('Enter')
    expect(events[0].windowsVirtualKeyCode).toBe(13)
  })

  it('omits text entirely for keys that produce no character', async () => {
    // Escape and the arrows move or dismiss; they do not insert. Sending any
    // text for them makes Chrome treat the press as character entry.
    const mock = installCdpMock()

    await dispatchKey(TAB, 'Escape')
    await dispatchKey(TAB, 'ArrowDown')

    for (const e of keyEvents(mock)) {
      expect(e.text ?? '').toBe('')
    }
    expect(keyEvents(mock)[0].type).toBe('rawKeyDown')
  })

  it('does not double-insert: one keystroke is keyDown then keyUp, nothing between', async () => {
    // Chrome derives the insertion from `text` on the keyDown, so an extra
    // `char` event is a SECOND insertion. Typing "hi" that way lands "hhii".
    const mock = installCdpMock()

    await typeText(TAB, 'hi')

    const events = keyEvents(mock)
    expect(events.map((e) => e.type)).toEqual(['keyDown', 'keyUp', 'keyDown', 'keyUp'])
    expect(events.filter((e) => e.type === 'char')).toHaveLength(0)
    expect(events.filter((e) => e.text === 'h')).toHaveLength(1)
    expect(events.filter((e) => e.text === 'i')).toHaveLength(1)
  })

  it('suppresses the character for a chord, but not for shift', async () => {
    // ctrl+a selects; it does not type an "a". Shift is the exception: it is
    // how you enter the uppercase character.
    const mock = installCdpMock()

    await dispatchKey(TAB, 'a', modifierMask(['Ctrl']))
    const chord = keyEvents(mock)
    expect(chord.every((e) => !e.text)).toBe(true)
    expect(chord[0].type).toBe('rawKeyDown')

    const shifted = installCdpMock()
    await dispatchKey(TAB, 'A', modifierMask(['Shift']))
    expect(keyEvents(shifted)[0].text).toBe('A')
  })
})

describe('key identity for single characters', () => {
  /**
   * `KeyboardEvent.keyCode` and `.which` are derived from
   * `windowsVirtualKeyCode`. Omitting it lands both at 0, so a page that gates
   * on either ignores an event that is trusted, delivered, and in every other
   * respect correct. Found live: `/key_presses` echoed nothing for a keystroke
   * whose probe confirmed it had reached the page.
   */

  it('gives a letter its virtual key code and its physical code', async () => {
    const mock = installCdpMock()

    await dispatchKey(TAB, 'b')

    const down = keyEvents(mock)[0]
    expect(down.windowsVirtualKeyCode, 'keyCode 0 is invisible to keyCode-gated pages').toBe(66)
    expect(down.code).toBe('KeyB')
    expect(down.key).toBe('b')
    expect(down.text).toBe('b')
  })

  it('uses the uppercase virtual key code for an uppercase letter', async () => {
    // The virtual key names the PHYSICAL key, which is the same one either way.
    const mock = installCdpMock()

    await dispatchKey(TAB, 'B')

    expect(keyEvents(mock)[0].windowsVirtualKeyCode).toBe(66)
    expect(keyEvents(mock)[0].code).toBe('KeyB')
  })

  it('gives a digit a Digit code, not a Key code', async () => {
    const mock = installCdpMock()

    await dispatchKey(TAB, '1')

    const down = keyEvents(mock)[0]
    expect(down.windowsVirtualKeyCode).toBe(49)
    expect(down.code, '"Key1" is not a code any layout produces').toBe('Digit1')
  })

  it('sends no fabricated code for punctuation rather than a wrong one', async () => {
    // A wrong `code` names a different physical key, which is worse than none:
    // the previous behaviour emitted "Key@".
    const mock = installCdpMock()

    await dispatchKey(TAB, '@')

    const down = keyEvents(mock)[0]
    expect(down.code).toBeUndefined()
    expect(down.windowsVirtualKeyCode).toBeUndefined()
    // It still types the character.
    expect(down.text).toBe('@')
  })

  it('leaves named keys exactly as they were', async () => {
    const mock = installCdpMock()

    await dispatchKey(TAB, 'Enter')

    const down = keyEvents(mock)[0]
    expect(down.windowsVirtualKeyCode).toBe(13)
    expect(down.code).toBe('Enter')
    expect(down.text).toBe('\r')
  })

  it('passes an unlisted named key through as its own code', async () => {
    const mock = installCdpMock()

    await dispatchKey(TAB, 'F5')

    expect(keyEvents(mock)[0].code).toBe('F5')
  })

  it('carries the virtual key code through every character of a typed string', async () => {
    // `type` routes through the same helper, so a per-character regression here
    // would silently break every keystroke-driven widget.
    const mock = installCdpMock()

    await typeText(TAB, 'a1')

    const downs = keyEvents(mock).filter((e) => e.type === 'keyDown')
    expect(downs.map((e) => e.windowsVirtualKeyCode)).toEqual([65, 49])
    expect(downs.map((e) => e.code)).toEqual(['KeyA', 'Digit1'])
  })
})

describe('dispatch ack deadline', () => {
  // Chrome acks Input.dispatch* only after the renderer has processed the
  // event, so a handler that raises a dialog synchronously blocks the ack
  // forever. Measured live 2026-08-12; the full story is on the class.

  it('gives up on an unacked dispatch well before the transport does', async () => {
    // The upper bound is what decides whether this does anything: the tool
    // layer kills a browser command at 30s, so a deadline near that costs a
    // round trip and buys nothing. Without this assertion a 29s deadline
    // passes every other test in the file.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))

      let outcome: unknown = null
      const pending = dispatchKey(TAB, 'Enter').catch((e: unknown) => {
        outcome = e
        return e
      })
      await vi.advanceTimersByTimeAsync(12_000)

      expect(outcome, 'must decide well inside the 30s transport timeout').toBeInstanceOf(
        InputDispatchStalled,
      )
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('deadlines every Input.* dispatch, not just the ones with a test each', async () => {
    // A per-method sweep, because the failure mode here is a call site that
    // forgets the wrapper rather than one that gets it wrong: unwrapping
    // insertText, the keyUp half of a keystroke, or the wheel dispatch each
    // survived the whole suite before this existed.
    // `hangFrom` is the 1-indexed Input event to stall on, chosen as the LAST
    // one each gesture emits: stalling the first would leave a later wrapper
    // (a keystroke's keyUp) unproven, which is exactly the gap being closed.
    const dispatches: Array<{ label: string; hangFrom: number; run: () => Promise<unknown> }> = [
      { label: 'Input.insertText', hangFrom: 1, run: () => insertText(TAB, 'hello') },
      { label: 'Input.dispatchKeyEvent (keyUp half)', hangFrom: 2, run: () => dispatchKey(TAB, 'a') },
      // The wheel is deadlined too but resolves 'timeout' instead of
      // throwing (#207: its ack is not load-bearing); its own test below.
      {
        label: 'Input.dispatchMouseEvent (hover)',
        hangFrom: 1,
        run: () => trustedHover(TAB, { x: 5, y: 5 }),
      },
      {
        label: 'Input.dispatchMouseEvent (click release)',
        hangFrom: 3,
        run: () => trustedClick(TAB, { x: 5, y: 5 }),
      },
    ]

    for (const { label, hangFrom, run } of dispatches) {
      vi.useFakeTimers()
      try {
        let sent = 0
        ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) => {
          if (!method.startsWith('Input.')) return Promise.resolve({})
          sent += 1
          return sent >= hangFrom ? new Promise<never>(() => {}) : Promise.resolve({})
        })

        let outcome: unknown = null
        const pending = run().catch((e: unknown) => {
          outcome = e
          return e
        })
        await vi.advanceTimersByTimeAsync(60_000)

        expect(outcome, `${label} must be deadlined`).toBeInstanceOf(InputDispatchStalled)
        await pending
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('the wheel is deadlined too, resolving timeout instead of throwing (#207)', async () => {
    // The wheel's ack is the one that Chromium can mislay while the input
    // still lands (a coalesced-away wheel never acks), so its deadline
    // reports rather than fails. A forgotten wrapper would hang forever
    // and time this test out.
    vi.useFakeTimers()
    resetWheelAckLatchForTests()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      let outcome: unknown = null
      const pending = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 }).then((v) => {
        outcome = v
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await pending
      expect(outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
      resetWheelAckLatchForTests()
    }
  })

  it('latches the widget after a wheel-ack timeout so later wheels pay the short tolerance (#207)', async () => {
    // A desynced widget never acks again; without the latch every later
    // scroll on it would burn the full deadline in wall clock.
    vi.useFakeTimers()
    resetWheelAckLatchForTests()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      const first = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })
      await vi.advanceTimersByTimeAsync(8_100)
      expect(await first).toBe('timeout')

      let outcome: unknown = null
      const second = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 }).then((v) => {
        outcome = v
      })
      await vi.advanceTimersByTimeAsync(600)
      await second
      expect(outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
      resetWheelAckLatchForTests()
    }
  })

  it('a non-deadline wheel error propagates, never resolving timeout (#207 review)', async () => {
    // Only the mislaid RECEIPT is tolerable. A failed attach, a detached
    // session, or a protocol error means the wheel may never have gone
    // out, and resolving 'timeout' there would report input: "trusted"
    // and scrolled: {...} for a wheel that was not dispatched.
    resetWheelAckLatchForTests()
    ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
      method.startsWith('Input.')
        ? Promise.reject(new Error('Detached while handling command'))
        : Promise.resolve({}),
    )

    await expect(trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })).rejects.toThrow(
      /Detached/,
    )
  })

  it('the latch is per WIDGET: another tab and another session keep the full deadline (#207 review)', async () => {
    // The isolation the design rests on: a desynced widget on one tab must
    // not shorten any other widget's deadline.
    vi.useFakeTimers()
    resetWheelAckLatchForTests()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      const first = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })
      await vi.advanceTimersByTimeAsync(8_100)
      expect(await first).toBe('timeout')

      // A different TAB: full deadline (must not resolve at the short one).
      let otherTab = false
      const onOther = trustedWheel(TAB + 1, { x: 5, y: 5 }, { x: 0, y: 100 }).then((v) => {
        otherTab = true
        return v
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(otherTab).toBe(false)
      await vi.advanceTimersByTimeAsync(7_600)
      expect(await onOther).toBe('timeout')

      // A frame SESSION on the latched tab: its widget is its own.
      let frameSession = false
      const onFrame = trustedWheel(
        { tabId: TAB, sessionId: 'frame-1' },
        { x: 5, y: 5 },
        { x: 0, y: 100 },
      ).then((v) => {
        frameSession = true
        return v
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(frameSession).toBe(false)
      await vi.advanceTimersByTimeAsync(7_600)
      expect(await onFrame).toBe('timeout')
    } finally {
      vi.useRealTimers()
      resetWheelAckLatchForTests()
    }
  })

  it('a navigation or tab close clears the latch: the new widget gets the full deadline (#207 review)', async () => {
    // A latched-then-navigated tab kept the short tolerance and turned a
    // slow-but-fine wheel handler into a liveness failure; the latch must
    // die with the widget it measured.
    vi.useFakeTimers()
    resetWheelAckLatchForTests()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      const first = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })
      await vi.advanceTimersByTimeAsync(8_100)
      expect(await first).toBe('timeout')

      clearWheelAckLatchForTab(TAB)

      let resolved = false
      const second = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 }).then((v) => {
        resolved = true
        return v
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(7_600)
      expect(await second).toBe('timeout')
    } finally {
      vi.useRealTimers()
      resetWheelAckLatchForTests()
    }
  })

  it('an arriving ack clears the wheel latch, restoring the full deadline (#207)', async () => {
    vi.useFakeTimers()
    resetWheelAckLatchForTests()
    try {
      const hang = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      ;(chrome.debugger.sendCommand as unknown) = hang
      const first = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })
      await vi.advanceTimersByTimeAsync(8_100)
      expect(await first).toBe('timeout')

      // The widget recovers: an ack arrives, which must clear the latch.
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => Promise.resolve({}))
      expect(await trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 })).toBe('acked')

      // Latch cleared: a fresh hang gets the FULL deadline again, so the
      // short tolerance must NOT resolve it.
      ;(chrome.debugger.sendCommand as unknown) = hang
      let resolved = false
      const third = trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 }).then((v) => {
        resolved = true
        return v
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(7_600)
      expect(await third).toBe('timeout')
    } finally {
      vi.useRealTimers()
      resetWheelAckLatchForTests()
    }
  })

  it('marks a click stalled on its opening pointer move as NOT landed', async () => {
    // trustedClick opens with a mouseMoved to position the pointer, so the
    // first ack that can stall belongs to an event that is not the click. A
    // blocking hover handler must not produce "the click was sent, do not
    // retry" for a press that never went out.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) =>
        method.startsWith('Input.') ? new Promise<never>(() => {}) : Promise.resolve({}),
      )

      let outcome: InputDispatchStalled | null = null
      const pending = trustedClick(TAB, { x: 5, y: 5 }).catch((e: InputDispatchStalled) => {
        outcome = e
        return e
      })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(outcome).toBeInstanceOf(InputDispatchStalled)
      expect(outcome!.landed, 'no button was pressed, so nothing landed').toBe(false)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a stall on the press itself as landed', async () => {
    // The other half of the pair: once the button is down the page has the
    // event, so the do-not-retry warning is earned.
    vi.useFakeTimers()
    try {
      let sent = 0
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) => {
        if (!method.startsWith('Input.')) return Promise.resolve({})
        sent += 1
        return sent >= 2 ? new Promise<never>(() => {}) : Promise.resolve({})
      })

      let outcome: InputDispatchStalled | null = null
      const pending = trustedClick(TAB, { x: 5, y: 5 }).catch((e: InputDispatchStalled) => {
        outcome = e
        return e
      })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(outcome).toBeInstanceOf(InputDispatchStalled)
      expect(outcome!.landed).toBe(true)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the page longer than the liveness probe does', async () => {
    // The lower bound, and the reason these two deadlines must not be unified:
    // a liveness probe times a trivial evaluate, while a dispatch ack waits on
    // the page's OWN handler for that event. A handler that takes a couple of
    // seconds is ordinary, and failing it would abort the rest of a batch.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(
        (_t: unknown, method: string) =>
          new Promise((resolve) => {
            setTimeout(() => resolve({}), method.startsWith('Input.') ? 5_000 : 0)
          }),
      )

      const pending = dispatchKey(TAB, 'Enter').then(
        () => 'ok',
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pending, 'a 5s handler must not read as a suspended page').toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a real protocol error as itself, never as a stall', async () => {
    // A detached session or a closed target is a different failure with its
    // own honest message downstream. Converting it into the "input landed"
    // story would warn the agent off retrying an action that never happened.
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => {
      throw new Error('Detached while handling command')
    })

    await expect(dispatchKey(TAB, 'Enter')).rejects.toThrow('Detached while handling command')
  })

  it('stalls out of a multi-character type mid-string, not only on the first key', async () => {
    // Each character is its own dispatch, and any one of them can be the one
    // whose handler raises the dialog. The loop must not outlive the stall.
    vi.useFakeTimers()
    try {
      // Count only the key events: the session also enables its capture
      // domains through the same chrome.debugger.sendCommand on first use.
      let keyEvents = 0
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_t: unknown, method: string) => {
        if (method !== 'Input.dispatchKeyEvent') return Promise.resolve({})
        keyEvents += 1
        // Third key event: the keyDown of the second character.
        if (keyEvents >= 3) return new Promise<never>(() => {})
        return Promise.resolve({})
      })

      let outcome: unknown = null
      const pending = typeText(TAB, 'hi').catch((e: unknown) => {
        outcome = e
        return e
      })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(outcome).toBeInstanceOf(InputDispatchStalled)
      expect(keyEvents, 'no further keys may be dispatched after the stall').toBe(3)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The three in-page function strings below run for real here (happy-dom),
 * because #160 flagged exactly this class of gap: a probe string no test
 * ever executes is unverified logic wearing a tested function's name.
 */
function pageFn<T>(src: string): (this: Element, ...args: unknown[]) => T {
  return new Function(`return (${src})`)() as (this: Element, ...args: unknown[]) => T
}

describe('hitTest containment (executed in-page fn)', () => {
  const hitTestFn = pageFn<{ hit: boolean; blocker?: string }>(HIT_TEST_FN)

  function domWithTopmost(topmost: Element | null) {
    ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
      topmost
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('accepts the target itself, a descendant, and an ancestor, saying which', () => {
    // WHICH containment accepted it is not decoration: an ancestor hit is
    // the loose one, and a caller whose target cannot receive the click
    // (pointer-events: none) has to tell it from a real one.
    document.body.innerHTML = '<div id="wrap"><button id="btn"><span id="icon"></span></button></div>'
    const wrap = document.getElementById('wrap') as Element
    const btn = document.getElementById('btn') as Element
    const icon = document.getElementById('icon') as Element

    domWithTopmost(btn)
    expect(hitTestFn.call(btn, 1, 1)).toEqual({ hit: true, via: 'self' })
    domWithTopmost(icon)
    expect(hitTestFn.call(btn, 1, 1)).toEqual({ hit: true, via: 'descendant' })
    domWithTopmost(wrap)
    // The ancestor case also names it: that element is what a click would
    // actually target when the containment is the only reason this passed.
    expect(hitTestFn.call(btn, 1, 1)).toEqual({ hit: true, via: 'ancestor', blocker: 'div#wrap' })
  })

  it('names a sibling blocker by tag, id, and first two classes', () => {
    // The CodeMirror 5 shape: render surface and hidden textarea are
    // siblings, so neither containment direction can accept it.
    document.body.innerHTML =
      '<div><textarea id="cm-input"></textarea><pre id="line1" class="CodeMirror-line cm-text extra"></pre></div>'
    const textarea = document.getElementById('cm-input') as Element
    const pre = document.getElementById('line1') as Element

    domWithTopmost(pre)
    expect(hitTestFn.call(textarea, 1, 1)).toEqual({
      hit: false,
      blocker: 'pre#line1.CodeMirror-line.cm-text',
    })
  })

  it('reports nothing-at-point as offscreen rather than as a blocker', () => {
    document.body.innerHTML = '<button id="btn"></button>'
    domWithTopmost(null)
    const out = hitTestFn.call(document.getElementById('btn') as Element, 1, 1)
    expect(out.hit).toBe(false)
    expect(out.blocker).toMatch(/offscreen/)
  })

  it('tests the point in a shadow target\'s OWN root, not the document', () => {
    // The document retargets a shadow-DOM hit to the HOST, and `contains`
    // never crosses that boundary, so every containment check failed and a
    // click on a button inside an open shadow root refused as "covered by"
    // the component wrapping it.
    //
    // MOCK HONESTY: happy-dom ships no `ShadowRoot.elementFromPoint`, so the
    // retargeting itself is stubbed here rather than exercised. What these
    // two tests pin is the probe's WIRING (which scope it asks, and that it
    // still names a light-DOM overlay); the retargeting behaviour they
    // assume is the CSSOM-View algorithm, verified against the spec, not
    // against this suite.
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host') as Element
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="inner">Pay</button>'
    const inner = root.querySelector('#inner') as Element
    domWithTopmost(host)
    ;(root as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => inner

    expect(hitTestFn.call(inner, 1, 1)).toEqual({ hit: true, via: 'self' })
  })

  it('still refuses when a light-DOM overlay covers a shadow target', () => {
    // The other half: crossing the boundary must not blanket-accept. An
    // element from the document tree is not retargeted when the root asks,
    // so the real overlay still reads as a miss and is still named.
    document.body.innerHTML = '<div id="host"></div><div id="cookie-wall"></div>'
    const host = document.getElementById('host') as Element
    const overlay = document.getElementById('cookie-wall') as Element
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="inner">Pay</button>'
    const inner = root.querySelector('#inner') as Element
    ;(root as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => overlay

    expect(hitTestFn.call(inner, 1, 1)).toEqual({ hit: false, blocker: 'div#cookie-wall' })
  })

  it('is not tricked by a property shadowing getRootNode', () => {
    // The named-form-control trap (worlds.ts): `this.getRootNode` can be an
    // ELEMENT, truthy, and calling it throws a TypeError that costs the
    // whole hit test, whose result gates a refusal. happy-dom does not
    // implement that named-property lookup, so the shadowing is modelled
    // directly here; the `typeof === 'function'` guard is what makes it
    // harmless in a real page.
    document.body.innerHTML = '<button id="btn"></button>'
    const btn = document.getElementById('btn') as Element
    Object.defineProperty(btn, 'getRootNode', { configurable: true, value: btn })
    domWithTopmost(btn)

    expect(hitTestFn.call(btn, 1, 1)).toEqual({ hit: true, via: 'self' })
  })

  it('is not tricked by a property shadowing contains either', () => {
    // The same trap two lines further down: `<form><input name="contains">`
    // makes `this.contains` an element, and calling it threw out of a probe
    // whose answer gates a refusal, taking the whole act with it (review
    // round). A shadowed containment test answers "not contained", which is
    // the safe direction: the point is named as a blocker instead.
    document.body.innerHTML = '<div id="wrap"><button id="btn"></button></div>'
    const btn = document.getElementById('btn') as Element
    const wrap = document.getElementById('wrap') as Element
    Object.defineProperty(btn, 'contains', { configurable: true, value: btn })
    domWithTopmost(wrap)

    expect(hitTestFn.call(btn, 1, 1)).toEqual({ hit: true, via: 'ancestor', blocker: 'div#wrap' })
  })

  it('falls back to the document when the root cannot answer the point', () => {
    // A DETACHED node's root is a plain element, which has no
    // elementFromPoint at all: the probe must still answer (a miss, here)
    // rather than throw on the way to a refusal.
    const detached = document.createElement('div')
    detached.innerHTML = '<button id="gone"></button>'
    const btn = detached.querySelector('#gone') as Element
    expect(btn.getRootNode(), 'the premise: the root is not a document').toBe(detached)
    domWithTopmost(null)

    const out = hitTestFn.call(btn, 1, 1)
    expect(out.hit).toBe(false)
    expect(out.blocker).toMatch(/offscreen/)
  })
})

describe('text-entry classification (executed in-page fn)', () => {
  const isTextEntry = pageFn<boolean>(TEXT_ENTRY_FN)

  function el(html: string): Element {
    document.body.innerHTML = html
    return document.body.firstElementChild as Element
  }

  it('accepts the text-entry family: textarea, text-like inputs, contenteditable, textbox roles', () => {
    expect(isTextEntry.call(el('<textarea></textarea>'))).toBe(true)
    expect(isTextEntry.call(el('<input type="text">'))).toBe(true)
    expect(isTextEntry.call(el('<input type="email">'))).toBe(true)
    expect(isTextEntry.call(el('<input>'))).toBe(true)
    expect(isTextEntry.call(el('<div contenteditable="true"></div>'))).toBe(true)
    expect(isTextEntry.call(el('<div role="textbox"></div>'))).toBe(true)
    expect(isTextEntry.call(el('<div role="searchbox"></div>'))).toBe(true)
  })

  it('rejects everything a covered click must still refuse on: buttons, checkboxes, plain elements', () => {
    expect(isTextEntry.call(el('<button></button>'))).toBe(false)
    expect(isTextEntry.call(el('<input type="checkbox">'))).toBe(false)
    expect(isTextEntry.call(el('<input type="radio">'))).toBe(false)
    expect(isTextEntry.call(el('<input type="submit">'))).toBe(false)
    expect(isTextEntry.call(el('<input type="file">'))).toBe(false)
    expect(isTextEntry.call(el('<div></div>'))).toBe(false)
    expect(isTextEntry.call(el('<a href="#"></a>'))).toBe(false)
  })
})

describe('focus landed (executed in-page fn)', () => {
  const focusLanded = pageFn<boolean>(FOCUS_LANDED_FN)

  it('is true when focus is on the target or inside it', () => {
    document.body.innerHTML =
      '<div id="editor"><textarea id="inner"></textarea></div><input id="other">'
    const editor = document.getElementById('editor') as Element
    const inner = document.getElementById('inner') as HTMLElement

    inner.focus()
    expect(focusLanded.call(inner)).toBe(true)
    expect(focusLanded.call(editor), 'focus inside the target counts').toBe(true)
  })

  it('is false when nothing is focused at all (activeElement is body)', () => {
    // The vacuous-truth trap: with nothing focused, document.activeElement is
    // body, and body.contains(target) is true for every light-DOM target. A
    // non-focusable overlay (a plain div banner) that swallows the click
    // leaves focus exactly there, and this must read as a miss, not a landing.
    document.body.innerHTML = '<textarea id="cm"></textarea><div id="banner"></div>'
    const cm = document.getElementById('cm') as Element
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    expect(focusLanded.call(cm)).toBe(false)
  })

  it('is false when focus went somewhere unrelated', () => {
    document.body.innerHTML = '<textarea id="cm"></textarea><input id="other">'
    const cm = document.getElementById('cm') as Element
    const other = document.getElementById('other') as HTMLElement

    other.focus()
    expect(focusLanded.call(cm)).toBe(false)
  })
})

describe('actionability probe (executed in-page fn)', () => {
  const actionability = pageFn<Record<string, unknown>>(ACTIONABILITY_FN)

  function el(html: string): Element {
    document.body.innerHTML = html
    return document.body.firstElementChild as Element
  }

  it('answers connected, and reports a removed node as disconnected', () => {
    const node = el('<button id="b">Pay</button>')
    expect(actionability.call(node).connected).toBe(true)

    node.remove()
    expect(actionability.call(node).connected).toBe(false)
  })

  it('names a disabled control, and leaves the field ABSENT on an enabled one', () => {
    // Absent, not `false`: every caller refuses on an explicit `true` only,
    // so a fact the probe cannot compute must be indistinguishable from a
    // fact it computed as no.
    expect(actionability.call(el('<button disabled>Pay</button>')).disabled).toBe(true)
    expect('disabled' in actionability.call(el('<button>Pay</button>'))).toBe(false)
  })

  it('names a readonly text field alongside the text-entry verdict that qualifies it', () => {
    const readonlyInput = actionability.call(el('<input type="text" readonly>'))
    expect(readonlyInput.readonly).toBe(true)
    expect(readonlyInput.textEntry, 'the readonly refusal is gated on this').toBe(true)

    // `readOnly` is true here too, and means nothing on a checkbox: the
    // text-entry verdict is what keeps it from refusing a legitimate act.
    const readonlyCheckbox = actionability.call(el('<input type="checkbox" readonly>'))
    expect(readonlyCheckbox.readonly).toBe(true)
    expect(readonlyCheckbox.textEntry).toBe(false)

    expect('readonly' in actionability.call(el('<input type="text">'))).toBe(false)
  })

  it('reports opacity-0 as not visible while a plain element is visible', () => {
    // R-07's actual case: transparent, still hit-testable, still the thing
    // the click lands on.
    expect(actionability.call(el('<button style="opacity:0">Pay</button>')).visible).toBe(false)
    expect(actionability.call(el('<button>Pay</button>')).visible).toBe(true)
  })

  it('names pointer-events:none, and leaves the field ABSENT otherwise', () => {
    expect(
      actionability.call(el('<button style="pointer-events:none">Pay</button>')).pointerEventsNone,
    ).toBe(true)
    expect('pointerEventsNone' in actionability.call(el('<button>Pay</button>'))).toBe(false)
  })

  it('answers the other facts when one of them throws', () => {
    // Per-fact try/catch, not one around the lot: an element whose
    // checkVisibility is hostile or missing must not cost the disabled
    // answer that refuses a dead click.
    const node = el('<button disabled>Pay</button>')
    Object.defineProperty(node, 'checkVisibility', {
      configurable: true,
      value: () => {
        throw new Error('no')
      },
    })

    const out = actionability.call(node)
    expect(out.disabled).toBe(true)
    expect(out.connected).toBe(true)
    expect('visible' in out, 'the throwing fact is simply absent').toBe(false)
  })

  it('cannot be tricked by a named form control shadowing a property', () => {
    // Probe-body discipline (worlds.ts): named DOM properties follow you
    // across isolated worlds, so `form.readOnly` can resolve to a CONTROL
    // named "readOnly". Every comparison here is `=== true`, which is what
    // makes that harmless.
    const form = el('<form><input name="readOnly"><input name="disabled"></form>')
    const out = actionability.call(form)
    expect('readonly' in out).toBe(false)
    expect('disabled' in out).toBe(false)
    expect(out.connected).toBe(true)
  })
})

describe('selector facts probe (executed in-page fn)', () => {
  const facts = pageFn<Record<string, unknown>>(SELECTOR_FACTS_FN)

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('carries the six actionability facts through, so a selector act gates like a ref act', () => {
    document.body.innerHTML = '<button class="go" disabled>Pay</button>'
    const node = document.querySelector('.go') as Element

    const out = facts.call(node, '.go', 'css')

    expect(out.disabled, 'the composed body must not drop the refusal facts').toBe(true)
    expect(out.connected).toBe(true)
    expect(out.visible).toBe(true)
  })

  it('counts what else the same rule matched, and says nothing about a shadow root', () => {
    document.body.innerHTML = '<a class="row"></a><a class="row"></a><a class="row"></a>'
    const first = document.querySelector('.row') as Element

    const out = facts.call(first, '.row', 'css')

    expect(out.matchCount).toBe(3)
    expect('shadowMatch' in out, 'a light-DOM match has no provenance to report').toBe(false)
  })

  it('reports a shadow-root match and counts across EVERY root the walk searched', () => {
    // Measured in review: counting inside the matched element's own root
    // reported 1 for three matches spread over two roots, which retires the
    // ambiguity warning exactly where it is needed. The count has to cover
    // the same scopes the resolution searched, or it is worse than no count.
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const rootA = (document.getElementById('a') as Element).attachShadow({ mode: 'open' })
    rootA.innerHTML = '<button class="go"></button><button class="go"></button>'
    const rootB = (document.getElementById('b') as Element).attachShadow({ mode: 'open' })
    rootB.innerHTML = '<button class="go"></button>'
    const inner = rootA.querySelector('.go') as Element

    const out = facts.call(inner, '.go', 'css')

    expect(out.shadowMatch).toBe(true)
    expect(out.matchCount).toBe(3)
  })

  it('counts the DOCUMENT alone when the document matched, the way the resolution resolves', () => {
    // Light DOM wins in the resolution, so the count must not walk past it
    // and add shadow matches to a number describing a light-DOM target.
    document.body.innerHTML = '<a class="row"></a><div id="host"></div>'
    const root = (document.getElementById('host') as Element).attachShadow({ mode: 'open' })
    root.innerHTML = '<a class="row"></a><a class="row"></a>'
    const light = document.querySelector('.row') as Element

    expect(facts.call(light, '.row', 'css').matchCount).toBe(1)
  })

  it('answers about an element whose named properties shadow DOM methods', () => {
    // Probe-body discipline (worlds.ts): named DOM properties follow you
    // across isolated worlds, so a `<form>` holding controls named after DOM
    // methods answers ELEMENTS for them. Nothing in this body may call one
    // blind. happy-dom does not implement that named-property lookup, so the
    // shadowing is modelled directly.
    document.body.innerHTML = '<button class="go"></button>'
    const node = document.querySelector('.go') as Element
    Object.defineProperty(node, 'getRootNode', { configurable: true, value: node })
    Object.defineProperty(node, 'contains', { configurable: true, value: node })

    const out = facts.call(node, '.go', 'css')

    expect(out.connected, 'the actionability facts survive').toBe(true)
    expect(out.matchCount, 'and so does the count').toBe(1)
    expect('shadowMatch' in out, 'a light-DOM match has no provenance to report').toBe(false)
  })

  it('says when a bound cut the count short, instead of passing a floor off as a total', () => {
    // 60 hosts, one match each, against a 50-root budget. The count that
    // comes back is 50: rendered bare, that is a measured-sounding claim
    // about a page with sixty matches (measured in review).
    for (let i = 0; i < 60; i += 1) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      host.attachShadow({ mode: 'open' }).innerHTML = '<button class="go"></button>'
    }

    const out = facts.call(document.querySelector('div')!.shadowRoot!.querySelector('.go')!, '.go', 'css')

    expect(out.matchCount).toBe(50)
    expect(out.matchCountCapped, 'the number is a floor and says so').toBe(true)
    expect(out.shadowMatch).toBe(true)
  })

  it('leaves the capped flag off a search that finished', () => {
    document.body.innerHTML = '<div id="host"></div>'
    const root = (document.getElementById('host') as Element).attachShadow({ mode: 'open' })
    root.innerHTML = '<button class="go"></button>'

    const out = facts.call(root.querySelector('.go') as Element, '.go', 'css')

    expect(out.matchCount).toBe(1)
    expect('matchCountCapped' in out, 'no furniture on the ordinary case').toBe(false)
  })

  it('takes the shadow verdict from the DOCUMENT query, not from the element', () => {
    // Authoritative provenance: the document query is what the resolution
    // branched on, and unlike `getRootNode()` a page cannot shadow it with a
    // named form control. Asked of the element, this fact went ABSENT on
    // such a page and the backend then rendered the absence as a definite
    // light-DOM match (review round).
    document.body.innerHTML = '<div id="host"></div>'
    const root = (document.getElementById('host') as Element).attachShadow({ mode: 'open' })
    root.innerHTML = '<button class="go"></button>'
    const inner = root.querySelector('.go') as Element
    Object.defineProperty(inner, 'getRootNode', { configurable: true, value: inner })

    expect(facts.call(inner, '.go', 'css').shadowMatch).toBe(true)
  })

  it('counts an xpath through a document snapshot, the only tree it can address', () => {
    // happy-dom ships no XPath engine, so the call itself is stubbed; what
    // this pins is the wiring the probe cannot get wrong silently (the
    // ORDERED_NODE_SNAPSHOT result type, and reading snapshotLength).
    document.body.innerHTML = '<p id="p"></p>'
    const node = document.getElementById('p') as Element
    const seen: unknown[] = []
    const g = globalThis as unknown as Record<string, unknown>
    g.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7 }
    ;(document as unknown as { evaluate: unknown }).evaluate = (...args: unknown[]) => {
      seen.push(args)
      return { snapshotLength: 4 }
    }
    try {
      const out = facts.call(node, '//p', 'xpath')

      expect(out.matchCount).toBe(4)
      expect((seen[0] as unknown[])[0]).toBe('//p')
      expect((seen[0] as unknown[])[3], 'a snapshot type, not the first-node one').toBe(7)
    } finally {
      delete g.XPathResult
      delete (document as unknown as { evaluate?: unknown }).evaluate
    }
  })

  it('keeps the actionability facts when the count cannot be computed', () => {
    // An unanswerable extra must not cost the facts that refuse a dead act:
    // the selector half is wrapped separately for exactly this.
    document.body.innerHTML = '<input readonly>'
    const node = document.querySelector('input') as Element

    const out = facts.call(node, 'input:::not-a-selector', 'css')

    expect(out.readonly).toBe(true)
    expect(out.textEntry).toBe(true)
    expect('matchCount' in out, 'an invalid rule counts nothing rather than lying').toBe(false)
  })
})

describe('wall-clock budget (#162)', () => {
  /** A typed mock: the file-level one is zero-arg, and these tests read args. */
  function installBudgetCdpMock(onEvent?: (method: string, params?: unknown) => void) {
    const sendCommand = vi.fn(async (_t: unknown, method: string, params?: unknown) => {
      onEvent?.(method, params)
      return {}
    })
    ;(chrome.debugger.sendCommand as unknown) = sendCommand
    return sendCommand
  }
  const mouseTypes = (mock: ReturnType<typeof installBudgetCdpMock>) =>
    mock.mock.calls
      .filter((c) => c[1] === 'Input.dispatchMouseEvent')
      .map((c) => (c[2] as { type: string }).type)
  const keyEventCount = (mock: ReturnType<typeof installBudgetCdpMock>) =>
    mock.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent').length

  it('typeText stops at a character boundary with exact progress', async () => {
    // The overrun class this exists for: every individual ack is healthy, the
    // SUM is what reaches the budget. Two dispatches per character at 1s each
    // against a 4.5s deadline: characters 0-2 go out (the check before the
    // third still passes at t=4s), the check before the fourth throws.
    vi.useFakeTimers()
    try {
      const mock = installBudgetCdpMock((method) => {
        if (method === 'Input.dispatchKeyEvent') vi.setSystemTime(Date.now() + 1_000)
      })
      const deadline = Date.now() + 4_500

      let thrown: unknown
      try {
        await typeText(TAB, 'abcdef', deadline)
      } catch (e) {
        thrown = e
      }

      expect(thrown).toBeInstanceOf(InputBudgetExhausted)
      const e = thrown as InputBudgetExhausted
      expect(e.delivered).toBe(3)
      expect(e.requested).toBe(6)
      expect(e.unit).toBe('characters')
      // The delivered characters really went out: 3 chars, keyDown + keyUp.
      expect(keyEventCount(mock)).toBe(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('trustedClick refuses the second click of a double-click, naming one delivered', async () => {
    vi.useFakeTimers()
    try {
      const mock = installBudgetCdpMock((method, params) => {
        if (method === 'Input.dispatchMouseEvent' && (params as { type?: string })?.type === 'mouseReleased') {
          vi.setSystemTime(Date.now() + 5_000)
        }
      })
      const deadline = Date.now() + 4_000

      await expect(
        trustedClick(TAB, { x: 10, y: 10 }, { clickCount: 2, deadline }),
      ).rejects.toMatchObject({ name: 'InputBudgetExhausted', delivered: 1, requested: 2, unit: 'clicks' })

      // One complete click went out; the second never started.
      expect(mouseTypes(mock)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('trustedDrag past its budget skips the glide but ALWAYS releases the button', async () => {
    // The degrade path: once the button is down, throwing would leave it held
    // in the page. The intermediate moves are droppable; the release is not.
    vi.useFakeTimers()
    try {
      const mock = installBudgetCdpMock((method, params) => {
        if (method === 'Input.dispatchMouseEvent' && (params as { type?: string })?.type === 'mousePressed') {
          vi.setSystemTime(Date.now() + 10_000)
        }
      })
      const deadline = Date.now() + 5_000

      const outcome = await trustedDrag(TAB, { x: 0, y: 0 }, { x: 100, y: 80 }, 0, deadline)

      // The caller needs to KNOW the glide was dropped: a zero-glide drag can
      // register as a plain click on delta-tracking pages, and only this
      // return value lets act.ts mark the payload drag_degraded.
      expect(outcome.degraded).toBe(true)
      expect(outcome.movesSent).toBe(0)
      expect(mouseTypes(mock)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
      const release = mock.mock.calls.find(
        (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mouseReleased',
      )?.[2] as { x: number; y: number }
      expect(release.x, 'the release lands at the destination').toBe(100)
      expect(release.y).toBe(80)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a drag never throws mid-gesture, even started on a spent clock', async () => {
    // Deliberately NOT a refusal: trustedDrag has no pre-press throw, because
    // an exception between press and release would abandon a held button in
    // the page. The refusal to START a drag on a spent budget is the caller's
    // (act.ts checks before dispatching; covered in act.test.ts). Once called,
    // the gesture always completes press-to-release, degraded if it must be.
    vi.useFakeTimers()
    try {
      const mock = installBudgetCdpMock()
      const deadline = Date.now() - 1

      const outcome = await trustedDrag(TAB, { x: 0, y: 0 }, { x: 10, y: 10 }, 0, deadline)

      expect(outcome).toEqual({ degraded: true, movesSent: 0 })
      expect(mouseTypes(mock)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unhurried drag reports itself whole', async () => {
    // The healthy path must be distinguishable from the degraded one, or
    // drag_degraded could be stamped onto every drag and nobody would notice.
    const mock = installBudgetCdpMock()

    const outcome = await trustedDrag(TAB, { x: 0, y: 0 }, { x: 100, y: 80 }, 0, Date.now() + 60_000)

    expect(outcome.degraded).toBe(false)
    expect(outcome.movesSent).toBeGreaterThan(0)
    expect(mouseTypes(mock).at(-1)).toBe('mouseReleased')
  })
})

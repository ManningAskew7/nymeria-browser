import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchKey,
  InputDispatchStalled,
  insertText,
  modifierMask,
  trustedClick,
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

beforeEach(() => resetDebugger())

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
      {
        label: 'Input.dispatchMouseEvent (wheel)',
        hangFrom: 1,
        run: () => trustedWheel(TAB, { x: 5, y: 5 }, { x: 0, y: 100 }),
      },
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchKey, modifierMask, typeText } from './input'
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

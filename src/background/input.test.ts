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

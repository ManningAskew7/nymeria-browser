import { sendCommand, type Cdp } from './debuggerSession'

/**
 * Trusted input primitives.
 *
 * The distinction this module exists for: events synthesized from page JS
 * (`el.click()`, `new MouseEvent(...)`) carry `isTrusted: false`. Real sites
 * notice. Payment forms, anti-bot layers, and plenty of ordinary widgets
 * either ignore untrusted events or flag them, which is exactly the class of
 * page the agent most needs to work on.
 *
 * `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`
 * go in at the browser level, so the page cannot tell them from a human. They
 * are coordinate-based, hence the geometry helpers here.
 *
 * Geometry note: element rects come from `getBoundingClientRect()` rather than
 * CDP `DOM.getBoxModel`. Both are CSS pixels but they disagree on coordinate
 * space in ways that vary by Chrome version, whereas `getBoundingClientRect`
 * is unambiguously viewport-relative, which is what `Input.*` wants. Elements
 * inside an iframe report rects relative to THAT frame's viewport, so
 * frame-offset compensation is required before this reaches cross-frame
 * targets.
 */

export interface Point {
  x: number
  y: number
}

export type MouseButton = 'left' | 'right'

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Control: 2,
  Meta: 4,
  Cmd: 4,
  Command: 4,
  Shift: 8,
}

export function modifierMask(mods?: string[]): number {
  if (!mods) return 0
  return mods.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0)
}

/**
 * Translate user-facing key names to the CDP `Input.dispatchKeyEvent` subset.
 * CDP wants a Windows virtual-key code for many control keys.
 */
/**
 * `text` is the CHARACTER the key produces, which is not the key's name.
 *
 * Most of these produce no character at all: Escape and the arrows move or
 * dismiss, they do not insert. Only Enter (a carriage return), Tab and Space
 * do. CDP rejects a `text` longer than one character outright, so sending the
 * NAME ("Enter") fails with `-32602 Invalid 'text' parameter` and the key
 * never reaches the page. Omitting `text` here is meaningful, not lazy.
 */
export const KEY_TABLE: Record<
  string,
  { code: string; key: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { code: 'PageUp', key: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
  Delete: { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32, text: ' ' },
}

/** CDP modifier bits. Shift still produces a character; the others do not. */
const SHIFT_BIT = 8

/**
 * `code` and `windowsVirtualKeyCode` for a single printable character.
 *
 * `KeyboardEvent.keyCode` and `.which` are derived from
 * `windowsVirtualKeyCode`, and omitting it lands them both at 0. A page that
 * gates on either then ignores an event that is trusted, delivered, and to
 * every other appearance correct: the same class of dishonesty as reporting
 * success for input that never arrived.
 *
 * Punctuation is deliberately left bare. Its virtual-key code depends on the
 * keyboard layout, and a wrong one names a different physical key, which is
 * worse than none. The previous fabrication (`Key@`, `Key1`) was never a real
 * `code` value in any layout.
 */
function charKeyInfo(ch: string): { code?: string; windowsVirtualKeyCode?: number } {
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase()
    return { code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(ch)) {
    return { code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) }
  }
  return {}
}

export async function callOn<T = unknown>(
  target: Cdp,
  objectId: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  const r = await sendCommand<{ result: { value?: T } }>(target, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((v) => ({ value: v })),
    returnByValue: true,
    awaitPromise: true,
  })
  return r.result.value as T
}

/** Scroll the element into view. Best-effort: a detached node just fails. */
export async function scrollIntoView(target: Cdp, objectId: string): Promise<void> {
  await callOn(
    target,
    objectId,
    'function(){ this.scrollIntoView({block: "center", inline: "center", behavior: "instant"}); }',
  )
}

/**
 * Viewport-relative centre of the element, or null when it has no layout box
 * (`display:none`, zero-size, detached). A null here is the signal to fall
 * back to synthetic dispatch rather than to fail: hidden file inputs are a
 * legitimate target and have no box by design.
 */
export async function elementGeometry(target: Cdp, objectId: string): Promise<{ point: Point } | null> {
  const rect = await callOn<{ x: number; y: number; w: number; h: number } | null>(
    target,
    objectId,
    `function(){
      const r = this.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }`,
  )
  if (!rect) return null
  return { point: { x: rect.x, y: rect.y } }
}

/**
 * Origin of a cross-origin frame in ROOT viewport coordinates.
 *
 * An element inside an iframe reports a rect relative to that frame's own
 * viewport, but `Input.*` is dispatched on the root session in root
 * coordinates (Chrome hit-tests and routes the event into the frame's widget
 * for us). The two must be composed or every click inside a frame lands at
 * the wrong place on the page.
 *
 * Handles one level of nesting: a frame whose parent is the main document.
 * Deeper nesting would need the chain walked, which no real checkout has
 * needed so far; the offset simply degrades to the outermost frame.
 */
export async function frameOffset(tabId: number, frameId: string): Promise<Point> {
  const zero = { x: 0, y: 0 }
  try {
    const owner = await sendCommand<{ backendNodeId?: number }>(tabId, 'DOM.getFrameOwner', {
      frameId,
    })
    if (!owner.backendNodeId) return zero
    const resolved = await sendCommand<{ object?: { objectId?: string } }>(
      tabId,
      'DOM.resolveNode',
      { backendNodeId: owner.backendNodeId },
    )
    const objectId = resolved.object?.objectId
    if (!objectId) return zero
    const offset = await callOn<Point | null>(
      tabId,
      objectId,
      `function(){
        const r = this.getBoundingClientRect();
        const cs = getComputedStyle(this);
        const px = (v) => parseFloat(v || '0') || 0;
        return {
          x: r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth),
          y: r.top + px(cs.paddingTop) + px(cs.borderTopWidth),
        };
      }`,
    )
    return offset ?? zero
  } catch {
    return zero
  }
}

export interface HitTest {
  hit: boolean
  blocker?: string
}

/**
 * Does a click at `point` actually land on this element?
 *
 * An overlay (cookie banner, modal backdrop, sticky header) intercepting the
 * point is the difference between "clicked the thing" and "clicked the
 * overlay and reported success". Naming the interceptor lets the agent
 * dismiss it instead of retrying blindly.
 */
export async function hitTest(target: Cdp, objectId: string, point: Point): Promise<HitTest> {
  return callOn<HitTest>(
    target,
    objectId,
    `function(x, y){
      const top = document.elementFromPoint(x, y);
      if (!top) return { hit: false, blocker: 'nothing at point (offscreen?)' };
      if (top === this || this.contains(top) || top.contains(this)) return { hit: true };
      const id = top.id ? '#' + top.id : '';
      const cls = typeof top.className === 'string' && top.className
        ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      return { hit: false, blocker: top.tagName.toLowerCase() + id + cls };
    }`,
    [point.x, point.y],
  )
}

/** Bitfield of buttons currently HELD, which is not the same as the button
 *  this event is about. 1 = left, 2 = right, 4 = middle. */
const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 }

async function mouseEvent(
  target: Cdp,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number; held?: MouseButton } = {},
): Promise<void> {
  const button = opts.button ?? (type === 'mouseMoved' ? 'none' : 'left')
  // Held during a press, and during a drag's intermediate moves; released by
  // definition on mouseReleased.
  const held = opts.held ?? (type === 'mousePressed' ? button : 'none')
  await sendCommand(target, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button,
    buttons: BUTTON_BIT[held] ?? 0,
    clickCount: opts.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
    modifiers: opts.modifiers ?? 0,
  })
}

/** Move the pointer first so hover handlers fire before the press. */
export async function trustedHover(target: Cdp, point: Point, modifiers = 0): Promise<void> {
  await mouseEvent(target, 'mouseMoved', point, { modifiers })
}

export async function trustedClick(
  target: Cdp,
  point: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
  const button = opts.button ?? 'left'
  const modifiers = opts.modifiers ?? 0
  const clickCount = opts.clickCount ?? 1
  await mouseEvent(target, 'mouseMoved', point, { modifiers })
  for (let n = 1; n <= clickCount; n += 1) {
    await mouseEvent(target, 'mousePressed', point, { button, clickCount: n, modifiers })
    await mouseEvent(target, 'mouseReleased', point, { button, clickCount: n, modifiers })
  }
}

export async function trustedDrag(target: Cdp, from: Point, to: Point, modifiers = 0): Promise<void> {
  await mouseEvent(target, 'mouseMoved', from, { modifiers })
  await mouseEvent(target, 'mousePressed', from, { button: 'left', clickCount: 1, modifiers })
  // A couple of intermediate moves: drag implementations that listen for
  // movement deltas ignore a single teleporting move.
  const steps = 4
  for (let i = 1; i <= steps; i += 1) {
    await mouseEvent(
      target,
      'mouseMoved',
      { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      { button: 'left', held: 'left', modifiers },
    )
  }
  await mouseEvent(target, 'mouseReleased', to, { button: 'left', clickCount: 1, modifiers })
}

export async function focusElement(target: Cdp, objectId: string): Promise<void> {
  await sendCommand(target, 'DOM.focus', { objectId })
}

/**
 * Insert text as one edit. Generates a real `input` event but no per-character
 * key events, so it is fast and reliable for ordinary fields. Use
 * `typeText` for widgets that listen for keydown.
 */
export async function insertText(target: Cdp, text: string): Promise<void> {
  await sendCommand(target, 'Input.insertText', { text })
}

/**
 * One keystroke: `keyDown` then `keyUp`, and nothing in between.
 *
 * Chrome derives the character insertion from `text` on the keyDown itself, so
 * a separate `char` event is not a belt-and-braces addition, it is a second
 * insertion: typing "hi" that way lands "hhii" in the field. A key that
 * produces no character uses `rawKeyDown`, which is how Chrome distinguishes
 * "a key was pressed" from "a character was entered".
 */
export async function dispatchKey(target: Cdp, key: string, modifiers = 0): Promise<void> {
  const entry = KEY_TABLE[key]
  const isChar = !entry && key.length === 1
  // A chord (ctrl+a) presses the key without entering its character; shift is
  // the exception, since shift is how you enter the uppercase one.
  const suppressed = (modifiers & ~SHIFT_BIT) !== 0
  const text = suppressed ? '' : entry ? (entry.text ?? '') : isChar ? key : ''
  const common = {
    modifiers,
    key: entry ? entry.key : key,
    ...(entry
      ? { code: entry.code, windowsVirtualKeyCode: entry.windowsVirtualKeyCode }
      : isChar
        ? charKeyInfo(key)
        : // A named key we do not carry (F1, Insert): its `code` IS its name,
          // so pass it through rather than inventing one.
          { code: key }),
  }
  await sendCommand(target, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...common,
    ...(text ? { text } : {}),
  })
  await sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** Per-character key events, for widgets that need keydown/keyup per key. */
export async function typeText(target: Cdp, text: string): Promise<void> {
  for (const ch of text) {
    await dispatchKey(target, ch)
  }
}

/** Select the whole current value so the next insert replaces it. */
export async function selectAllIn(target: Cdp, objectId: string): Promise<void> {
  await callOn(
    target,
    objectId,
    `function(){
      if (typeof this.select === 'function') { this.select(); return; }
      const range = document.createRange();
      range.selectNodeContents(this);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }`,
  )
}

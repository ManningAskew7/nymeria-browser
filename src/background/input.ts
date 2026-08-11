import { sendCommand } from './debuggerSession'

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

export interface ElementGeometry {
  point: Point
  width: number
  height: number
}

export type MouseButton = 'left' | 'right' | 'middle'

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
export const KEY_TABLE: Record<string, { code: string; key?: string; windowsVirtualKeyCode?: number }> = {
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
  Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
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
  Space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32 },
}

export async function callOn<T = unknown>(
  tabId: number,
  objectId: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  const r = await sendCommand<{ result: { value?: T } }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((v) => ({ value: v })),
    returnByValue: true,
    awaitPromise: true,
  })
  return r.result.value as T
}

/** Scroll the element into view. Best-effort: a detached node just fails. */
export async function scrollIntoView(tabId: number, objectId: string): Promise<void> {
  await callOn(
    tabId,
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
export async function elementGeometry(tabId: number, objectId: string): Promise<ElementGeometry | null> {
  const rect = await callOn<{ x: number; y: number; w: number; h: number } | null>(
    tabId,
    objectId,
    `function(){
      const r = this.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }`,
  )
  if (!rect) return null
  return { point: { x: rect.x, y: rect.y }, width: rect.w, height: rect.h }
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
export async function hitTest(tabId: number, objectId: string, point: Point): Promise<HitTest> {
  return callOn<HitTest>(
    tabId,
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

async function mouseEvent(
  tabId: number,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: opts.button ?? (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: opts.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
    modifiers: opts.modifiers ?? 0,
  })
}

/** Move the pointer first so hover handlers fire before the press. */
export async function trustedHover(tabId: number, point: Point, modifiers = 0): Promise<void> {
  await mouseEvent(tabId, 'mouseMoved', point, { modifiers })
}

export async function trustedClick(
  tabId: number,
  point: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
  const button = opts.button ?? 'left'
  const modifiers = opts.modifiers ?? 0
  const clickCount = opts.clickCount ?? 1
  await mouseEvent(tabId, 'mouseMoved', point, { modifiers })
  for (let n = 1; n <= clickCount; n += 1) {
    await mouseEvent(tabId, 'mousePressed', point, { button, clickCount: n, modifiers })
    await mouseEvent(tabId, 'mouseReleased', point, { button, clickCount: n, modifiers })
  }
}

export async function trustedDrag(tabId: number, from: Point, to: Point, modifiers = 0): Promise<void> {
  await mouseEvent(tabId, 'mouseMoved', from, { modifiers })
  await mouseEvent(tabId, 'mousePressed', from, { button: 'left', clickCount: 1, modifiers })
  // A couple of intermediate moves: drag implementations that listen for
  // movement deltas ignore a single teleporting move.
  const steps = 4
  for (let i = 1; i <= steps; i += 1) {
    await mouseEvent(
      tabId,
      'mouseMoved',
      { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      { button: 'left', modifiers },
    )
  }
  await mouseEvent(tabId, 'mouseReleased', to, { button: 'left', clickCount: 1, modifiers })
}

export async function focusElement(tabId: number, objectId: string): Promise<void> {
  await sendCommand(tabId, 'DOM.focus', { objectId })
}

/**
 * Insert text as one edit. Generates a real `input` event but no per-character
 * key events, so it is fast and reliable for ordinary fields. Use
 * `typeText` for widgets that listen for keydown.
 */
export async function insertText(tabId: number, text: string): Promise<void> {
  await sendCommand(tabId, 'Input.insertText', { text })
}

export async function dispatchKey(tabId: number, key: string, modifiers = 0): Promise<void> {
  const entry = KEY_TABLE[key]
  const text = entry ? entry.key ?? '' : key.length === 1 ? key : ''
  const code = entry ? entry.code : key.length === 1 ? `Key${key.toUpperCase()}` : key
  const keyName = entry ? entry.key ?? key : key
  const common = {
    modifiers,
    text,
    key: keyName,
    code,
    ...(entry?.windowsVirtualKeyCode != null
      ? { windowsVirtualKeyCode: entry.windowsVirtualKeyCode }
      : {}),
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
  // A modified chord (ctrl+a) must not emit a character.
  if (text && modifiers === 0) {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...common })
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** Per-character key events, for widgets that need keydown/keyup per key. */
export async function typeText(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    await dispatchKey(tabId, ch)
  }
}

/** Select the whole current value so the next insert replaces it. */
export async function selectAllIn(tabId: number, objectId: string): Promise<void> {
  await callOn(
    tabId,
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

export const __test = { MODIFIER_BITS }

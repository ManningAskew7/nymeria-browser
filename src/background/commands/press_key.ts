import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

interface PressKeyArgs {
  tab_id: number
  key: string
  modifiers?: ('Ctrl' | 'Shift' | 'Alt' | 'Meta')[]
}

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Control: 2,
  Meta: 4,
  Shift: 8,
}

function modifierMask(mods?: string[]): number {
  if (!mods) return 0
  return mods.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0)
}

/**
 * Translate user-facing key names to the CDP Input.dispatchKeyEvent
 * subset. CDP wants a Windows virtual-key code for many control keys.
 */
const KEY_TABLE: Record<string, { code: string; key?: string; windowsVirtualKeyCode?: number }> = {
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

export async function execPressKey(args: unknown): Promise<CommandResult> {
  const a = args as PressKeyArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.key) return { ok: false, status: 'error', error: 'key required' }
  const mods = modifierMask(a.modifiers)
  const entry = KEY_TABLE[a.key]
  const text = entry ? entry.key ?? '' : a.key.length === 1 ? a.key : ''
  const code = entry ? entry.code : a.key.length === 1 ? `Key${a.key.toUpperCase()}` : a.key
  const keyName = entry ? entry.key ?? a.key : a.key

  const common = {
    modifiers: mods,
    text,
    key: keyName,
    code,
    ...(entry?.windowsVirtualKeyCode != null ? { windowsVirtualKeyCode: entry.windowsVirtualKeyCode } : {}),
  }
  try {
    await sendCommand(a.tab_id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
    if (text) await sendCommand(a.tab_id, 'Input.dispatchKeyEvent', { type: 'char', ...common })
    await sendCommand(a.tab_id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    return { ok: true, status: 'success', data: { key: a.key, modifiers: a.modifiers ?? [] } }
  } catch (e) {
    return { ok: false, status: 'error', error: `press_key failed: ${String(e)}` }
  }
}

export const __test = { modifierMask, KEY_TABLE }

import type { CommandResult } from '../../shared/types'
import { dispatchKey, modifierMask, KEY_TABLE } from '../input'

/**
 * Standalone key press against whatever currently has focus.
 *
 * The key machinery itself lives in `background/input.ts` alongside the other
 * trusted-input primitives, so `act`'s `key` action and this command cannot
 * drift apart.
 */

interface PressKeyArgs {
  tab_id: number
  key: string
  modifiers?: ('Ctrl' | 'Shift' | 'Alt' | 'Meta')[]
}

export async function execPressKey(args: unknown): Promise<CommandResult> {
  const a = args as PressKeyArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.key) return { ok: false, status: 'error', error: 'key required' }
  try {
    await dispatchKey(a.tab_id, a.key, modifierMask(a.modifiers))
    return { ok: true, status: 'success', data: { key: a.key, modifiers: a.modifiers ?? [] } }
  } catch (e) {
    return { ok: false, status: 'error', error: `press_key failed: ${String(e)}` }
  }
}

export const __test = { modifierMask, KEY_TABLE }

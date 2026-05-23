import { backgroundLogger as logger } from '../../utils/logger'
import { postCommandResult } from '../api'
import type { BrowserCommandEvent, CommandResult, CommandType } from '../../shared/types'
import { execAct } from './act'
import { execCdp } from './cdp'
import { execConsole } from './console'
import { execDialog } from './dialog'
import { execExtractText } from './extract_text'
import { execHistory } from './history'
import { execNavigate } from './navigate'
import { execPressKey } from './press_key'
import { execScreenshot } from './screenshot'
import { execScroll } from './scroll'
import { execSnapshot } from './snapshot'
import { execTabs } from './tabs'

type Executor = (args: unknown) => Promise<CommandResult>

export const EXECUTORS: Record<CommandType, Executor> = {
  tabs: execTabs,
  navigate: execNavigate,
  history: execHistory,
  snapshot: execSnapshot,
  act: execAct,
  press_key: execPressKey,
  scroll: execScroll,
  extract_text: execExtractText,
  screenshot: execScreenshot,
  console: execConsole,
  dialog: execDialog,
  cdp: execCdp,
}

function errorToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export interface DispatchHooks {
  onStart?: (event: BrowserCommandEvent) => void
  onResult?: (event: BrowserCommandEvent, result: CommandResult) => void
}

let hooks: DispatchHooks = {}

export function setDispatchHooks(h: DispatchHooks): void {
  hooks = h
}

export async function dispatchBrowserCommand(event: BrowserCommandEvent): Promise<void> {
  const { command_id, command_type, args } = event
  const executor = EXECUTORS[command_type]
  hooks.onStart?.(event)
  let payload: CommandResult
  if (!executor) {
    payload = { ok: false, status: 'error', error: `unknown command_type: ${String(command_type)}` }
  } else {
    try {
      payload = await executor(args)
    } catch (e) {
      payload = { ok: false, status: 'error', error: errorToString(e) }
    }
  }
  hooks.onResult?.(event, payload)
  try {
    const { delivered } = await postCommandResult(command_id, payload)
    if (!delivered) {
      logger.warn(`result for ${command_id} arrived after the agent moved on (delivered=false)`)
    }
  } catch (e) {
    logger.error(`failed to POST result for ${command_id}:`, e)
  }
}

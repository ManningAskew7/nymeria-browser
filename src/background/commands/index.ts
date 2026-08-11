import { backgroundLogger as logger } from '../../utils/logger'
import { postCommandResult } from '../api'
import type { BrowserCommandEvent, CommandResult, CommandType } from '../../shared/types'
import { execAct } from './act'
import { execBatch } from './batch'
import { execCdp } from './cdp'
import { execConsole } from './console'
import { execDialog } from './dialog'
import { execExtractText } from './extract_text'
import { execHistory } from './history'
import { execNavigate } from './navigate'
import { execNetwork } from './network'
import { execScreenshot } from './screenshot'
import { execSnapshot } from './snapshot'
import { execTabs } from './tabs'

type Executor = (args: unknown) => Promise<CommandResult>

/**
 * Safety valve on the result body, not a model-facing cap.
 *
 * The wire can carry a lot; the agent's context cannot. Model-facing limits
 * (and spilling the overflow into the workspace) belong on the backend, which
 * is where the workspace actually is. This bound only stops one runaway
 * command from posting an unbounded body, which is a transport concern.
 */
const MAX_RESULT_BYTES = 8_000_000

async function runSingle(type: string, args: unknown): Promise<CommandResult> {
  const executor = EXECUTORS[type as CommandType]
  if (!executor) {
    return { ok: false, status: 'error', error: `unknown command_type: ${String(type)}` }
  }
  return executor(args)
}

export const EXECUTORS: Record<CommandType, Executor> = {
  tabs: execTabs,
  navigate: execNavigate,
  history: execHistory,
  snapshot: execSnapshot,
  act: execAct,
  batch: (args) => execBatch(args, runSingle),
  extract_text: execExtractText,
  screenshot: execScreenshot,
  console: execConsole,
  network: execNetwork,
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

/** Replace an oversized body with an honest description of what was dropped. */
function capResult(payload: CommandResult, commandType: string): CommandResult {
  let size: number
  try {
    size = JSON.stringify(payload).length
  } catch {
    return {
      ok: false,
      status: 'error',
      error: `${commandType} produced a result that could not be serialized`,
    }
  }
  if (size <= MAX_RESULT_BYTES) return payload
  return {
    ok: false,
    status: 'error',
    error:
      `${commandType} produced a ${Math.round(size / 1_000_000)}MB result, over the ` +
      `${MAX_RESULT_BYTES / 1_000_000}MB transport limit. Narrow it (a selector, a smaller ` +
      'detail level, or a lower limit) and retry.',
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
  payload = capResult(payload, String(command_type))
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

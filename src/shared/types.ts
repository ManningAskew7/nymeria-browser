export interface MeResponse {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user' | string
}

export interface AutonomousEvent {
  type: string
  thread_id?: string
  task_id?: string
  timestamp?: string
  [key: string]: unknown
}

export type CommandType =
  | 'tabs'
  | 'navigate'
  | 'history'
  | 'snapshot'
  | 'act'
  | 'batch'
  | 'extract_text'
  | 'screenshot'
  | 'console'
  | 'network'
  | 'dialog'
  | 'health'
  | 'cdp'
  | 'reload_extension'

export interface BrowserCommandEvent extends AutonomousEvent {
  type: 'browser_command'
  command_id: string
  command_type: CommandType
  args: Record<string, unknown>
  timeout_seconds: number
}

export interface CommandResult {
  ok: boolean
  status: 'success' | 'error' | 'aborted'
  data?: unknown
  error?: string
}

export type ConnectionStatus =
  | { kind: 'unconfigured' }
  | { kind: 'connecting'; since: number }
  | { kind: 'connected'; since: number; identity: MeResponse }
  | { kind: 'disconnected'; reason: string; nextRetryAt: number; attempt: number }

export interface BackgroundSnapshot {
  status: ConnectionStatus
  lastEvent: { event: AutonomousEvent; receivedAt: number } | null
  eventCount: number
  commandCount: number
  lastCommandType: CommandType | null
  debuggerTabs: number[]
}

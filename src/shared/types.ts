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

export type ConnectionStatus =
  | { kind: 'unconfigured' }
  | { kind: 'connecting'; since: number }
  | { kind: 'connected'; since: number; identity: MeResponse }
  | { kind: 'disconnected'; reason: string; nextRetryAt: number; attempt: number }

export interface BackgroundSnapshot {
  status: ConnectionStatus
  lastEvent: { event: AutonomousEvent; receivedAt: number } | null
  eventCount: number
}

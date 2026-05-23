import type { BackgroundSnapshot, MeResponse } from './types'

export type PopupRequest =
  | { kind: 'get-snapshot' }
  | { kind: 'connect'; baseUrl: string; token: string }
  | { kind: 'disconnect' }
  | { kind: 'forget' }

export type PopupResponse =
  | { ok: true; snapshot: BackgroundSnapshot }
  | { ok: true; identity: MeResponse }
  | { ok: true }
  | { ok: false; error: string }

export const BROADCAST_CHANNEL = 'nymeria-browser/snapshot'

export interface SnapshotBroadcast {
  channel: typeof BROADCAST_CHANNEL
  snapshot: BackgroundSnapshot
}

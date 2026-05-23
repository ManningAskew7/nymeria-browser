import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSnapshot,
  loadFromStorage,
  recordCommand,
  recordDebuggerTabs,
  recordEvent,
  resetSnapshot,
  setStatus,
} from './state'

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-23T00:00:00Z'))
  await resetSnapshot()
})

describe('snapshot state machine', () => {
  it('starts unconfigured with no events', () => {
    const snap = getSnapshot()
    expect(snap.status.kind).toBe('unconfigured')
    expect(snap.eventCount).toBe(0)
    expect(snap.lastEvent).toBeNull()
  })

  it('transitions through connecting → connected', async () => {
    await setStatus({ kind: 'connecting', since: Date.now() })
    expect(getSnapshot().status.kind).toBe('connecting')

    await setStatus({
      kind: 'connected',
      since: Date.now(),
      identity: { id: 'u1', email: 'a@b', display_name: 'A', role: 'user' },
    })
    const snap = getSnapshot()
    expect(snap.status.kind).toBe('connected')
    if (snap.status.kind === 'connected') {
      expect(snap.status.identity.email).toBe('a@b')
    }
  })

  it('records events and increments the counter', async () => {
    await recordEvent({ type: 'tool_call', thread_id: 't1' })
    await recordEvent({ type: 'response', thread_id: 't1' })
    const snap = getSnapshot()
    expect(snap.eventCount).toBe(2)
    expect(snap.lastEvent?.event.type).toBe('response')
    expect(snap.lastEvent?.event.thread_id).toBe('t1')
  })

  it('persists the snapshot to chrome.storage.local on each mutation', async () => {
    await setStatus({ kind: 'connecting', since: Date.now() })
    await recordEvent({ type: 'thinking', thread_id: 't2' })
    const stored = await chrome.storage.local.get(['snapshot'])
    expect((stored as { snapshot: { eventCount: number } }).snapshot.eventCount).toBe(1)
  })

  it('loadFromStorage restores event counters but resets live status', async () => {
    await recordEvent({ type: 'x' })
    await setStatus({
      kind: 'connected',
      since: Date.now(),
      identity: { id: 'u', email: 'e', display_name: 'd', role: 'user' },
    })
    await loadFromStorage()
    const snap = getSnapshot()
    expect(snap.eventCount).toBe(1)
    expect(snap.status.kind).toBe('unconfigured')
  })

  it('reset clears everything', async () => {
    await recordEvent({ type: 'x' })
    await recordCommand('navigate')
    await recordDebuggerTabs([42])
    await resetSnapshot()
    const snap = getSnapshot()
    expect(snap.eventCount).toBe(0)
    expect(snap.lastEvent).toBeNull()
    expect(snap.commandCount).toBe(0)
    expect(snap.lastCommandType).toBeNull()
    expect(snap.debuggerTabs).toEqual([])
  })

  it('recordCommand bumps the counter and tracks last type', async () => {
    await recordCommand('navigate')
    await recordCommand('snapshot')
    const snap = getSnapshot()
    expect(snap.commandCount).toBe(2)
    expect(snap.lastCommandType).toBe('snapshot')
  })

  it('recordDebuggerTabs reflects active debugger sessions', async () => {
    await recordDebuggerTabs([7, 12])
    expect(getSnapshot().debuggerTabs).toEqual([7, 12])
    await recordDebuggerTabs([])
    expect(getSnapshot().debuggerTabs).toEqual([])
  })
})

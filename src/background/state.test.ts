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

  it('journals an upload envelope as its shape, never its bytes', async () => {
    // The journal lands on the USER'S DISK and chrome.storage.local is capped
    // at 10MB, which a single upload envelope can exceed on its own. Keeping
    // the base64 also rejected the write, which used to eat the command.
    const bytes = 'A'.repeat(20_000)
    await recordEvent({
      type: 'browser_command',
      thread_id: 't9',
      command_id: 'cmd-1',
      command_type: 'act',
      args: { tab_id: 3, action: 'upload', file_base64: bytes },
    })

    const stored = (await chrome.storage.local.get(['snapshot'])) as {
      snapshot: { lastEvent: { event: Record<string, unknown> } }
    }
    const journalled = JSON.stringify(stored.snapshot.lastEvent.event)
    expect(journalled).not.toContain(bytes)
    expect(journalled).not.toContain('AAAA')
    expect(journalled.length).toBeLessThan(2_000)
    // The popup's surface still renders, and the shape is still legible.
    const event = stored.snapshot.lastEvent.event
    expect(event.type).toBe('browser_command')
    expect(event.thread_id).toBe('t9')
    expect(event.command_type).toBe('act')
    const args = event.args as Record<string, unknown>
    expect(args.action).toBe('upload')
    expect(args.file_base64).toBe(`[${bytes.length} chars omitted]`)
  })

  it('keeps an ordinary event verbatim', async () => {
    await recordEvent({ type: 'browser_command', command_type: 'snapshot', args: { tab_id: 3 } })

    const event = getSnapshot().lastEvent?.event as Record<string, unknown>
    expect(event.args).toEqual({ tab_id: 3 })
  })

  it('keeps working when the storage write fails', async () => {
    // Storage is bookkeeping. A rejected write (the quota is the realistic
    // cause) must cost the write only: if it propagated, the connection
    // path's own `await setStatus(...)` would take the stream down with it.
    const failing = vi.fn(async () => {
      throw new Error('QUOTA_BYTES quota exceeded')
    })
    const original = chrome.storage.local.set
    chrome.storage.local.set = failing as unknown as typeof chrome.storage.local.set
    try {
      await expect(recordEvent({ type: 'browser_command', thread_id: 't9' })).resolves.toBeUndefined()
      await expect(setStatus({ kind: 'connecting', since: Date.now() })).resolves.toBeUndefined()
    } finally {
      chrome.storage.local.set = original
    }

    // In-memory state still moved, so the popup still reflects reality.
    expect(failing).toHaveBeenCalled()
    expect(getSnapshot().eventCount).toBe(1)
    expect(getSnapshot().status.kind).toBe('connecting')
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

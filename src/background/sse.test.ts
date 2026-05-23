import { describe, expect, it } from 'vitest'
import { frameToData, parseSseFrames } from './sse'

describe('parseSseFrames', () => {
  it('returns no frames for an empty buffer', () => {
    expect(parseSseFrames('')).toEqual({ frames: [], rest: '' })
  })

  it('returns no frames when no terminator yet (partial buffer)', () => {
    expect(parseSseFrames('data: hello')).toEqual({ frames: [], rest: 'data: hello' })
  })

  it('splits one complete frame and leaves the rest', () => {
    const out = parseSseFrames('data: hi\n\ndata: half')
    expect(out.frames).toEqual(['data: hi'])
    expect(out.rest).toBe('data: half')
  })

  it('splits multiple complete frames in one buffer', () => {
    const out = parseSseFrames('data: 1\n\ndata: 2\n\ndata: 3\n\n')
    expect(out.frames).toEqual(['data: 1', 'data: 2', 'data: 3'])
    expect(out.rest).toBe('')
  })

  it('handles multi-line data inside a frame', () => {
    const out = parseSseFrames('event: x\ndata: a\ndata: b\n\nrest')
    expect(out.frames).toEqual(['event: x\ndata: a\ndata: b'])
    expect(out.rest).toBe('rest')
  })
})

describe('frameToData', () => {
  it('returns null when there are no data lines', () => {
    expect(frameToData('event: ping\n')).toBeNull()
    expect(frameToData(':comment\n')).toBeNull()
  })

  it('extracts a single-line data payload, stripping the leading space', () => {
    expect(frameToData('data: hello')).toBe('hello')
    expect(frameToData('data:hello')).toBe('hello')
  })

  it('joins multiple data lines with newlines (per SSE spec)', () => {
    expect(frameToData('data: a\ndata: b\ndata: c')).toBe('a\nb\nc')
  })

  it('ignores comment lines', () => {
    expect(frameToData(':keepalive\ndata: payload')).toBe('payload')
  })

  it('roundtrips an event JSON envelope', () => {
    const json = '{"type":"tool_call","thread_id":"t1"}'
    const data = frameToData(`event: tool_call\ndata: ${json}`)
    expect(data).toBe(json)
    expect(JSON.parse(data as string)).toEqual({ type: 'tool_call', thread_id: 't1' })
  })
})

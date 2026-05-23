import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct, __test } from './act'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { clearAll as clearRefs, set as setRefs } from '../snapshotRefs'

beforeEach(() => {
  clearRefs()
  resetDebugger()
})

describe('execAct target resolution', () => {
  it('returns error when @ref is not in the snapshot cache', async () => {
    const result = await execAct({ tab_id: 1, target: '@e99', method: 'click' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown ref/)
  })

  it('resolves a cached @ref through DOM.resolveNode and runs click', async () => {
    setRefs(1, new Map([['e1', 100]]))
    const sendCommand = vi.fn(async (_target, method: string) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'objId-1' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: undefined } }
      return {}
    })
    ;(chrome.debugger.sendCommand as unknown) = sendCommand
    const result = await execAct({ tab_id: 1, target: '@e1', method: 'click' })
    expect(result.ok).toBe(true)
    if (result.ok && result.data && typeof result.data === 'object') {
      expect((result.data as { action: string }).action).toBe('click')
    }
    const methods = sendCommand.mock.calls.map((c) => c[1])
    expect(methods).toContain('DOM.resolveNode')
    expect(methods.filter((m) => m === 'Runtime.callFunctionOn')).toHaveLength(2) // scrollIntoView + click
  })

  it('rejects unknown target formats', async () => {
    const result = await execAct({ tab_id: 1, target: 'plain-string', method: 'click' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/target must start with/)
  })

  it('fill requires value', async () => {
    setRefs(1, new Map([['e1', 100]]))
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async (_target, method: string) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'objId-1' } }
      return {}
    })
    const result = await execAct({ tab_id: 1, target: '@e1', method: 'fill' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/fill requires value/)
  })

  it('resolveTarget handles css= prefix via Runtime.evaluate', async () => {
    const sendCommand = vi.fn(async (_target, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'css-obj' } }
      return {}
    })
    ;(chrome.debugger.sendCommand as unknown) = sendCommand
    const { objectId, error } = await __test.resolveTarget(1, 'css=.btn-primary')
    expect(error).toBeUndefined()
    expect(objectId).toBe('css-obj')
    expect(sendCommand.mock.calls[0][1]).toBe('Runtime.evaluate')
  })

  it('resolveTarget returns error when css= matches nothing', async () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { subtype: 'null' } }))
    const { objectId, error } = await __test.resolveTarget(1, 'css=#missing')
    expect(objectId).toBeNull()
    expect(error).toMatch(/css selector matched no element/)
  })
})

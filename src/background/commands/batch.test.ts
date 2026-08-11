import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/types'
import { execBatch, MAX_BATCH_ACTIONS } from './batch'

const TAB = 1

function okResult(data: unknown = {}): CommandResult {
  return { ok: true, status: 'success', data }
}

function failResult(error: string): CommandResult {
  return { ok: false, status: 'error', error }
}

/** Drive chrome.tabs.get through a scripted sequence of URLs. */
function scriptUrls(urls: string[]): void {
  const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
  let i = 0
  get.mockImplementation(async () => {
    const url = urls[Math.min(i, urls.length - 1)]
    i += 1
    return { id: TAB, url }
  })
}

beforeEach(() => {
  scriptUrls(['https://example.com'])
})

describe('execBatch', () => {
  it('runs actions in order and reports every result', async () => {
    const run = vi.fn(async (type: string) => okResult({ type }))

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'navigate' }, { type: 'act' }, { type: 'snapshot' }] },
      run,
    )

    expect(result.ok).toBe(true)
    const data = result.data as { results: { type: string }[]; completed: number; remaining: number }
    expect(data.results.map((r) => r.type)).toEqual(['navigate', 'act', 'snapshot'])
    expect(data.completed).toBe(3)
    expect(data.remaining).toBe(0)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('stops at the first failure and leaves the tail unrun', async () => {
    const run = vi.fn(async (type: string) =>
      type === 'navigate' ? failResult('element not found') : okResult(),
    )

    const result = await execBatch(
      {
        tab_id: TAB,
        actions: [
          { type: 'act' },
          { type: 'act' },
          { type: 'navigate' },
          { type: 'act' },
          { type: 'snapshot' },
        ],
      },
      run,
    )

    expect(result.ok).toBe(false)
    const data = result.data as { completed: number; remaining: number; aborted: string }
    expect(data.completed).toBe(2)
    expect(data.remaining).toBe(2)
    expect(data.aborted).toMatch(/action 3 \("navigate"\) failed/)
    expect(result.error).toMatch(/2 completed, 2 not run/)
    // Actions 4 and 5 were never attempted.
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('aborts the remainder when the page navigates mid-batch', async () => {
    scriptUrls([
      'https://example.com/cart', // before action 1
      'https://example.com/cart', // after action 1
      'https://example.com/checkout', // after action 2: navigated
    ])
    const run = vi.fn(async () => okResult())

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }, { type: 'act' }, { type: 'act' }] },
      run,
    )

    expect(result.ok).toBe(false)
    const data = result.data as { aborted: string; completed: number }
    expect(data.aborted).toMatch(/navigated to https:\/\/example\.com\/checkout/)
    expect(data.aborted).toMatch(/written against the previous page/)
    expect(data.completed).toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not abort on navigation caused by the final action', async () => {
    scriptUrls(['https://example.com/cart', 'https://example.com/thanks'])
    const run = vi.fn(async () => okResult())

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }] }, run)

    expect(result.ok).toBe(true)
    expect((result.data as { aborted?: string }).aborted).toBeUndefined()
  })

  it('honours continue_on_url_change for a deliberately cross-page sequence', async () => {
    scriptUrls([
      'https://example.com/login',
      'https://example.com/home',
      'https://example.com/home',
    ])
    const run = vi.fn(async () => okResult())

    const result = await execBatch(
      {
        tab_id: TAB,
        actions: [{ type: 'act' }, { type: 'act' }],
        continue_on_url_change: true,
      },
      run,
    )

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('passes the batch tab_id down to actions that omit it', async () => {
    const run = vi.fn(async () => okResult())
    await execBatch({ tab_id: TAB, actions: [{ type: 'act', args: { ref: '@e1' } }] }, run)
    expect(run).toHaveBeenCalledWith('act', { tab_id: TAB, ref: '@e1' })
  })

  it('lets an action override the batch tab_id', async () => {
    const run = vi.fn(async () => okResult())
    await execBatch({ tab_id: TAB, actions: [{ type: 'act', args: { tab_id: 9 } }] }, run)
    expect(run).toHaveBeenCalledWith('act', { tab_id: 9 })
  })

  it('treats a thrown executor as a failed action rather than crashing', async () => {
    const run = vi.fn(async () => {
      throw new Error('debugger detached')
    })

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(false)
    const data = result.data as { results: { error?: string }[] }
    expect(data.results[0].error).toMatch(/debugger detached/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses the privileged command types outright, not just nested batches', async () => {
    const run = vi.fn(async () => okResult())

    // chrome_cdp is classified SENSITIVE and deliberately left out of the
    // browser-control kit. If a batch step can name it, the kit's exclusion is
    // decorative: the MODERATE chrome_batch becomes a route to raw CDP.
    for (const type of ['cdp', 'dialog', 'console', 'network']) {
      const result = await execBatch({ tab_id: TAB, actions: [{ type }] }, run)
      expect(result.ok, `${type} should be refused`).toBe(false)
      expect(result.error).toMatch(/cannot run inside a batch/)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a nested batch', async () => {
    const run = vi.fn(async () => okResult())
    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'batch' }] }, run)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cannot run inside a batch/)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an empty action list', async () => {
    const result = await execBatch({ tab_id: TAB, actions: [] }, vi.fn())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/non-empty array/)
  })

  it('refuses more actions than the cap', async () => {
    const actions = Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ type: 'act' }))
    const run = vi.fn(async () => okResult())
    const result = await execBatch({ tab_id: TAB, actions }, run)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(new RegExp(`limited to ${MAX_BATCH_ACTIONS} actions`))
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an action with no type', async () => {
    const run = vi.fn(async () => okResult())
    const result = await execBatch({ tab_id: TAB, actions: [{} as never] }, run)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/string "type"/)
    expect(run).not.toHaveBeenCalled()
  })
})

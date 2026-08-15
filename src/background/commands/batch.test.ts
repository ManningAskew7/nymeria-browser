import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/types'
import { execBatch, MAX_BATCH_ACTIONS } from './batch'
import { installNavWatch, resetForTests as resetNavWatch } from '../navWatch'

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

/** Wire navWatch and hand back its webNavigation listeners for firing. */
function wireNav() {
  installNavWatch()
  const last = (fn: unknown) =>
    (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as (details: {
      tabId: number
      url: string
      frameId: number
    }) => void
  return {
    beforeNavigate: last(chrome.webNavigation!.onBeforeNavigate.addListener),
    committed: last(chrome.webNavigation!.onCommitted.addListener),
  }
}

beforeEach(() => {
  resetNavWatch()
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

  it('stops at an unmet wait condition: the gate the agent armed (#168)', async () => {
    const run = vi.fn(async (type: string) =>
      okResult(type === 'act' ? { found: false, condition: 'text:Order confirmed' } : {}),
    )

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }, { type: 'act' }] },
      run,
    )

    expect(result.ok).toBe(false)
    const data = result.data as {
      results: { ok: boolean }[]
      aborted: string
      completed: number
      remaining: number
    }
    expect(data.aborted).toMatch(/wait condition \(text:Order confirmed\) was not met/)
    expect(data.results[0].ok, 'the act itself succeeded; the gate is not its failure').toBe(true)
    expect(data.completed).toBe(1)
    expect(data.remaining).toBe(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('an unmet condition on the last action gates nothing', async () => {
    const run = vi.fn(async () => okResult({ found: false, condition: 'text:x' }))

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }] }, run)

    expect(result.ok).toBe(true)
    expect((result.data as { aborted?: string }).aborted).toBeUndefined()
  })

  it('a met condition does not stop the batch', async () => {
    const run = vi.fn(async () => okResult({ found: true, condition: 'text:Saved' }))

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a met condition carries the batch across the navigation it implies', async () => {
    // "Click sign in, wait for 'Welcome back', then act on the new page" is
    // the canonical sequence. The met condition IS the consent: aborting on
    // the very navigation the agent named as the expected outcome would
    // refuse the sequence the feature was built for.
    let url = 'https://example.com/login'
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url }))
    const nav = wireNav()
    const run = vi.fn(async (_type: string, args: unknown) => {
      const a = args as { wait_for?: { text?: string } }
      if (a.wait_for?.text) {
        url = 'https://example.com/home'
        nav.committed({ tabId: TAB, url, frameId: 0 })
        return okResult({ found: true, condition: `text:${a.wait_for.text}` })
      }
      return okResult({})
    })

    const result = await execBatch(
      {
        tab_id: TAB,
        actions: [
          { type: 'act', args: { action: 'click', wait_for: { text: 'Welcome back' } } },
          { type: 'act', args: { action: 'click', coordinate: [10, 10] } },
        ],
      },
      run,
    )

    expect(result.ok).toBe(true)
    expect((result.data as { aborted?: string }).aborted).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a step that leaves a dialog standing stops the batch with the answer route', async () => {
    // Every executor refuses on a standing dialog, so charging on would only
    // convert this named cause into a one-step-later refusal, with the tail
    // aimed at a page paused on an unanswered question.
    const run = vi.fn(async () =>
      okResult({
        dialog: {
          state: 'standing',
          type: 'confirm',
          message: 'Delete this item?',
          answer_with: 'chrome_dialog(tab_id=1, action="accept" or "dismiss")',
        },
      }),
    )

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(false)
    const data = result.data as { aborted: string }
    expect(data.aborted).toMatch(/confirm dialog standing/)
    expect(data.aborted).toMatch(/Delete this item\?/)
    expect(data.aborted).toMatch(/chrome_dialog\(tab_id=1/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a RESOLVED dialog in the payload does not stop the batch', async () => {
    // An auto-acknowledged alert is history, not a standing question.
    const run = vi.fn(async () =>
      okResult({ dialog: { state: 'resolved', type: 'alert', message: 'Saved!' } }),
    )

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a same-URL commit (reload) aborts the remainder: refs died with the document', async () => {
    scriptUrls(['https://example.com/cart'])
    const nav = wireNav()
    const run = vi.fn(async () => {
      nav.committed({ tabId: TAB, url: 'https://example.com/cart', frameId: 0 })
      return okResult()
    })

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(false)
    const data = result.data as { aborted: string }
    expect(data.aborted).toMatch(/same URL, new page/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a navigation still in flight at step end stops the batch a beat early', async () => {
    scriptUrls(['https://example.com/cart'])
    const nav = wireNav()
    const run = vi.fn(async () => {
      nav.beforeNavigate({ tabId: TAB, url: 'https://slow.example/next', frameId: 0 })
      return okResult()
    })

    const result = await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }] }, run)

    expect(result.ok).toBe(false)
    const data = result.data as { aborted: string }
    expect(data.aborted).toMatch(/still in flight/)
    expect(data.aborted).toMatch(/slow\.example\/next/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('continue_on_url_change also spans a reload and an in-flight navigation', async () => {
    scriptUrls(['https://example.com/cart'])
    const nav = wireNav()
    const run = vi.fn(async () => {
      nav.committed({ tabId: TAB, url: 'https://example.com/cart', frameId: 0 })
      nav.beforeNavigate({ tabId: TAB, url: 'https://slow.example/next', frameId: 0 })
      return okResult()
    })

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'act' }], continue_on_url_change: true },
      run,
    )

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('passes the batch tab_id down to actions that omit it', async () => {
    const run = vi.fn(async () => okResult())
    await execBatch({ tab_id: TAB, actions: [{ type: 'act', args: { ref: '@e1' } }] }, run)
    expect(run).toHaveBeenCalledWith('act', { tab_id: TAB, ref: '@e1' }, undefined)
  })

  it('lets an action override the batch tab_id', async () => {
    const run = vi.fn(async () => okResult())
    await execBatch({ tab_id: TAB, actions: [{ type: 'act', args: { tab_id: 9 } }] }, run)
    expect(run).toHaveBeenCalledWith('act', { tab_id: 9 }, undefined)
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

    // chrome_cdp is classified SENSITIVE and taught as a last resort whose
    // every use is stated and justified. If a batch step can name it, that
    // framing is decorative: the MODERATE chrome_batch becomes a route to
    // raw CDP, buried mid-sequence.
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

describe('batch wall-clock budget (#162)', () => {
  it('threads the batch deadline into every step: one pool, not per-step grants', async () => {
    // The backend budgets a batch from what the whole sequence contains, so
    // the extension-side wall clock must be shared: a step that dawdles
    // spends the tail's time, and the LAST step still sees the same deadline.
    const run = vi.fn<(type: string, args: unknown, ctx?: unknown) => Promise<CommandResult>>(
      async () => okResult(),
    )
    const ctx = { deadline: Date.now() + 50_000, budgetMs: 60_000 }

    await execBatch({ tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }] }, run, ctx)

    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][2]).toBe(ctx)
    expect(run.mock.calls[1][2]).toBe(ctx)
  })

  it('stops spending when the next step cannot afford to run honestly', async () => {
    // The failure this designs out: step 1 dawdles, the batch charges on, and
    // step 2 dies on some INTERNAL deadline with copy that blames the page.
    // Stopping between steps is where the honest answer is still cheap.
    vi.useFakeTimers()
    try {
      const run = vi.fn<(type: string, args: unknown, ctx?: unknown) => Promise<CommandResult>>(
        async () => {
          vi.setSystemTime(Date.now() + 55_000)
          return okResult()
        },
      )
      const ctx = { deadline: Date.now() + 57_000, budgetMs: 60_000 }

      const result = await execBatch(
        { tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }, { type: 'extract_text' }] },
        run,
        ctx,
      )

      expect(run, 'the second step must never start').toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(false)
      const err = String(result.error)
      expect(err).toMatch(/60s time budget/)
      expect(err).toMatch(/NOT attempted/)
      expect(err, 'names the step that will not run').toMatch(/"snapshot"/)
      const data = result.data as { completed: number; remaining: number }
      expect(data.completed).toBe(1)
      expect(data.remaining).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a load verb needs the bigger floor: 20s left runs a snapshot but not a navigate', async () => {
    // navigate/history/tabs-create/reload internally wait up to ~25s for the
    // load; starting one with 20s on the clock is starting it to fail, while
    // a snapshot with the same 20s is fine. The floor must discriminate.
    vi.useFakeTimers()
    try {
      const mkRun = () =>
        vi.fn<(type: string, args: unknown, ctx?: unknown) => Promise<CommandResult>>(async () => {
          vi.setSystemTime(Date.now() + 40_000)
          return okResult()
        })
      const start = Date.now()

      const runA = mkRun()
      const snap = await execBatch(
        { tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }] },
        runA,
        { deadline: start + 60_000, budgetMs: 60_000 },
      )
      expect(snap.ok).toBe(true)
      expect(runA).toHaveBeenCalledTimes(2)

      vi.setSystemTime(start)
      const runB = mkRun()
      const nav = await execBatch(
        { tab_id: TAB, actions: [{ type: 'act' }, { type: 'navigate' }] },
        runB,
        { deadline: start + 60_000, budgetMs: 60_000 },
      )
      expect(nav.ok).toBe(false)
      expect(runB, 'the navigate must not start on 20s').toHaveBeenCalledTimes(1)

      vi.setSystemTime(start)
      const runC = mkRun()
      const reload = await execBatch(
        { tab_id: TAB, actions: [{ type: 'act' }, { type: 'tabs', args: { action: 'reload' } }] },
        runC,
        { deadline: start + 60_000, budgetMs: 60_000 },
      )
      expect(reload.ok, 'tabs reload is a load verb too').toBe(false)
      expect(runC).toHaveBeenCalledTimes(1)

      vi.setSystemTime(start)
      const runD = mkRun()
      const list = await execBatch(
        { tab_id: TAB, actions: [{ type: 'act' }, { type: 'tabs', args: { action: 'list' } }] },
        runD,
        { deadline: start + 60_000, budgetMs: 60_000 },
      )
      expect(list.ok, 'tabs list loads nothing and keeps the small floor').toBe(true)
      expect(runD).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without a budget the stop-spending gate never fires', async () => {
    const run = vi.fn(async () => okResult())

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'navigate' }] },
      run,
    )

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('an unmet condition on a clamped window says the budget cut it, not just the page', async () => {
    // The gate still stops the batch (the checkpoint was NOT confirmed), but
    // an agent reading "condition was not met" after a 1s clamped watch of a
    // 10s ask would wrongly conclude the page never got there.
    const run = vi.fn<(type: string, args: unknown, ctx?: unknown) => Promise<CommandResult>>(
      async () =>
        okResult({ found: false, condition: 'text:Welcome', waited_ms: 900, budget_clamped: true }),
    )
    const ctx = { deadline: Date.now() + 50_000, budgetMs: 60_000 }

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }] },
      run,
      ctx,
    )

    expect(result.ok).toBe(false)
    const err = String(result.error)
    expect(err).toMatch(/wait condition \(text:Welcome\)/)
    expect(err).toMatch(/cut short by the batch time budget/)
    expect(err).toMatch(/re-check the page/)
  })

  it('an unmet condition with an unclamped window keeps the plain copy', async () => {
    const run = vi.fn<(type: string, args: unknown, ctx?: unknown) => Promise<CommandResult>>(
      async () => okResult({ found: false, condition: 'text:Welcome', waited_ms: 10_000 }),
    )
    const ctx = { deadline: Date.now() + 50_000, budgetMs: 60_000 }

    const result = await execBatch(
      { tab_id: TAB, actions: [{ type: 'act' }, { type: 'snapshot' }] },
      run,
      ctx,
    )

    expect(result.ok).toBe(false)
    expect(String(result.error)).not.toMatch(/cut short/)
  })
})

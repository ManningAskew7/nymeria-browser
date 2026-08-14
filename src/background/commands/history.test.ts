import { beforeEach, describe, expect, it, vi } from 'vitest'
import { raceStandingDialog, standingDialog } from '../dialogs'
import { execHistory } from './history'

const TAB = 1
const START = 'https://example.com/page2'

vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return {
    ...actual,
    raceStandingDialog: vi.fn(actual.raceStandingDialog),
    standingDialog: vi.fn(actual.standingDialog),
  }
})

function installTabsMock(opts: { status?: string } = {}) {
  const { status = 'complete' } = opts
  ;(chrome.tabs.get as unknown) = vi.fn(async () => ({
    id: TAB,
    url: START,
    title: 'Example',
    status,
  }))
  ;(chrome.tabs.goBack as unknown) = vi.fn(async () => undefined)
  ;(chrome.tabs.goForward as unknown) = vi.fn(async () => undefined)
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(raceStandingDialog).mockImplementation(async (_tabId, work) => ({
    kind: 'work' as const,
    value: await work,
  }))
  vi.mocked(standingDialog).mockReturnValue(null)
})

describe('execHistory', () => {
  it('reports an honest back on a loaded destination', async () => {
    installTabsMock()

    const result = await execHistory({ tab_id: TAB, direction: 'back' })

    expect(result.ok).toBe(true)
    expect((result.data as { complete?: boolean }).complete).toBe(true)
  })

  it('names a beforeunload that holds the back navigation (#169)', async () => {
    installTabsMock({ status: 'loading' })
    vi.mocked(raceStandingDialog).mockResolvedValue({
      kind: 'dialog',
      dialog: {
        type: 'beforeunload' as const,
        message: '',
        url: START,
        openedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
      },
    })

    const result = await execHistory({ tab_id: TAB, direction: 'back' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/asked to confirm leaving/)
    expect(String(result.error)).toMatch(/chrome_dialog\(tab_id=1/)
    expect((result.data as { dialog?: unknown }).dialog).toBeDefined()
  })

  it('catches a dialog even when a stale complete-read wins the race', async () => {
    // Same trap as navigate: the OLD page still reads status:"complete" when
    // waitForTabComplete early-outs, so the race can be won by a stale read
    // while a beforeunload stands. The post-race re-check is the belt.
    installTabsMock()
    vi.mocked(standingDialog).mockReturnValue({
      type: 'beforeunload' as const,
      message: '',
      url: START,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    })

    const result = await execHistory({ tab_id: TAB, direction: 'back' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/asked to confirm leaving/)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { raceStandingDialog, standingDialog } from '../dialogs'
import { execNavigate } from './navigate'

// The dialogs seam is mocked so a test can INJECT a dialog opening mid-load;
// the event plumbing has its own tests in dialogs.test.ts.
vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return {
    ...actual,
    raceStandingDialog: vi.fn(actual.raceStandingDialog),
    standingDialog: vi.fn(actual.standingDialog),
  }
})

const TAB = 1
const START = 'https://example.com/'
const TARGET = 'https://example.org/'

/**
 * `chrome.tabs` as this command uses it. Note `get` is called three times: once
 * before the update, once inside `waitForTabComplete`, and once after. Only the
 * FIRST is the starting state, so the mock switches after it rather than
 * counting calls, which is what a naive sequence gets wrong.
 *
 * `landsOn` is where the tab ends up: the starting url models a navigation that
 * never left, any other url models one that committed.
 */
function installTabsMock(opts: { landsOn: string; status?: string; startUrl?: string }) {
  const { landsOn, status = 'complete', startUrl = START } = opts
  const title = 'Example Domain'
  let asked = false
  const get = vi.fn(async () => {
    const url = asked ? landsOn : startUrl
    asked = true
    return { id: TAB, url, title, status }
  })
  const update = vi.fn(async (_id: number, props: { url: string }) => ({
    id: TAB,
    url: landsOn,
    title,
    status,
    pendingUrl: props.url,
  }))
  ;(chrome.tabs.get as unknown) = get
  ;(chrome.tabs.update as unknown) = update
  return { get, update }
}

beforeEach(() => {
  vi.restoreAllMocks()
  // Restored to no-op above; the default must be "no dialog ever opens",
  // i.e. the raced work simply resolves.
  vi.mocked(raceStandingDialog).mockImplementation(async (_tabId, work) => ({
    kind: 'work' as const,
    value: await work,
  }))
  vi.mocked(standingDialog).mockReturnValue(null)
})

describe('execNavigate', () => {
  it('rejects a scheme that is not http or https', async () => {
    // file: and javascript: would turn a navigation into a local-file read or
    // script injection on whatever origin the tab is sitting on.
    const result = await execNavigate({ tab_id: TAB, url: 'javascript:alert(1)' })

    expect(result.ok).toBe(false)
  })

  it('reports success when the tab actually arrives', async () => {
    installTabsMock({ landsOn: TARGET })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
    expect((result.data as { url?: string }).url).toBe(TARGET)
  })

  it('does not fail a redirect, where the landing url legitimately differs', async () => {
    // The test is "did not leave the starting page", NOT "did not reach the
    // requested url". A redirect moves the url and must stay a success, or every
    // shortened link and every login bounce would report as blocked.
    installTabsMock({ landsOn: 'https://example.org/landing' })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
  })

})

describe('beforeunload holds the navigation (#169)', () => {
  it('fails fast, names the dialog, and stays honest about where the tab is', async () => {
    // Before ownership this was the documented lie: ok:true with the tab
    // still on its old page. The dialog signal now wins the race against the
    // load wait, and the answer route is real.
    installTabsMock({ landsOn: START, status: 'loading' })
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

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/asked to confirm leaving/)
    expect(error).toMatch(/chrome_dialog\(tab_id=1, action="accept"\)/)
    expect(error, 'unsaved state is the user cue').toMatch(/unsaved/)
    const data = result.data as { url?: string; requested_url?: string; dialog?: unknown }
    expect(data.url, 'the tab has NOT moved and the payload must say so').toBe(START)
    expect(data.requested_url).toBe(TARGET)
    expect(data.dialog).toBeDefined()
  })

  it('catches a dialog even when a stale complete-read wins the race', async () => {
    // waitForTabComplete can win by reading the OLD page's status:"complete"
    // before the load it just triggered starts (settle.ts documents exactly
    // this trap), and a beforeunload standing at that instant would ride the
    // early-out back to the pre-#169 dishonest success. Whichever way the
    // race goes, a dialog standing NOW is the story.
    installTabsMock({ landsOn: START })
    vi.mocked(standingDialog).mockReturnValue({
      type: 'beforeunload' as const,
      message: '',
      url: START,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/asked to confirm leaving/)
    expect((result.data as { url?: string }).url).toBe(START)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execNavigate } from './navigate'

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

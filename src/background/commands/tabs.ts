import type { CommandResult } from '../../shared/types'
import { expectBeforeunloadAccept } from '../dialogs'
import { statusPayload } from '../statusWatch'
import { TAB_LOAD_WAIT_MS, waitForTabComplete, watchForTabComplete } from '../settle'

interface TabsArgs {
  action: 'list' | 'create' | 'switch' | 'close' | 'reload' | 'zoom'
  tab_id?: number
  url?: string
  zoom?: number
}

/** Chrome's own accepted zoom range, 25% to 500%. */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5.0

/**
 * `chrome.tabs.create` and `.reload` both resolve the instant Chrome accepts
 * the request, with the tab still `loading` and the previous document (or no
 * document) in place. Every reader then races the commit: measured 2026-08-12,
 * a `read_page` immediately after a `create` returned a one-element tree for a
 * page whose buttons were plainly there, and the same asymmetry is why a
 * `navigate` after a `create` REPLACES the uncommitted history entry instead
 * of pushing one, which kills back/forward.
 *
 * So these two wait exactly as `navigate` does, on the same shared bound. One
 * mental model across all three: the command returns a page you can read, and
 * says `complete: false` rather than pretending when it could not get one.
 */

/**
 * Which window a driven tab opens in: another normal window when one exists,
 * the user's current one only as the fallback.
 *
 * Creating in the last-focused window rips the user's view away mid-task
 * (measured 2026-08-16: the operator was watching a stream in the focused
 * window and every driven tab landed on top of it). A second window is the
 * natural "agent workspace": the tab is created active WITHIN it, so it
 * keeps rendering and compositing, but the window itself is not focused, so
 * nothing is stolen from the user. Minimized windows are skipped for the
 * same reason the second window is chosen at all: a tab there stops
 * compositing, which is the measured screenshot-hang and auth-cancel state
 * (#165); incognito windows are skipped because the driven session must be
 * the user's ordinary logged-in one. With a single usable window (or the
 * query failing) the old behavior stands: there is nowhere politer to go.
 */
async function drivenWindowId(): Promise<number | undefined> {
  try {
    const [wins, last] = await Promise.all([
      chrome.windows.getAll({ windowTypes: ['normal'] }),
      chrome.windows.getLastFocused().catch(() => null),
    ])
    const other = wins.find(
      (w) =>
        typeof w.id === 'number' &&
        w.id !== last?.id &&
        w.state !== 'minimized' &&
        w.incognito !== true,
    )
    return other?.id
  } catch {
    return undefined
  }
}

/** The one payload shape for a tab; the health read shares it (#188) so a
 * tab looks the same in chrome_tabs and chrome_health. */
export function describe(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    index: tab.index,
    status: tab.status,
  }
}

export async function execTabs(args: unknown): Promise<CommandResult> {
  const a = args as TabsArgs
  switch (a.action) {
    case 'list': {
      const tabs = await chrome.tabs.query({})
      return { ok: true, status: 'success', data: { tabs: tabs.map(describe) } }
    }
    case 'create': {
      if (!a.url) return { ok: false, status: 'error', error: 'create requires url' }
      const t0 = Date.now()
      const windowId = await drivenWindowId()
      const tab = await chrome.tabs.create({
        url: a.url,
        ...(windowId === undefined ? {} : { windowId }),
      })
      if (typeof tab.id !== 'number') {
        // No id means nothing downstream can address this tab, and a success
        // payload silently missing `complete` is worse than saying so.
        return { ok: false, status: 'error', error: 'Chrome created a tab with no id' }
      }
      const waited = await waitForTabComplete(tab.id, TAB_LOAD_WAIT_MS)
      // Re-read: the tab handed back by create carries the state at creation,
      // so its url and title are the pre-load ones even after the wait.
      const loaded = await chrome.tabs.get(tab.id).catch(() => null)
      if (!loaded) {
        return {
          ok: false,
          status: 'error',
          error: `the tab was closed while it was loading (tab_id ${tab.id})`,
        }
      }
      // `waitForTabComplete` reads the status and only then attaches its
      // listener, so a completion landing in that gap is missed and the wait
      // runs to its bound. The re-read is already in hand and settles it, and
      // without this the payload could say `status: "complete"` next to
      // `complete: false`.
      const complete = waited || loaded.status === 'complete'
      return {
        ok: true,
        status: 'success',
        data: {
          tab: describe(loaded),
          complete,
          // #175: same claim rules as navigate's committed branch. Create is
          // the kit's recommended first step, so it has the identical
          // error-page blind spot; absent means unknown, never OK.
          ...statusPayload(tab.id, t0, [loaded.url]),
        },
      }
    }
    case 'switch': {
      if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'switch requires tab_id' }
      const tab = await chrome.tabs.update(a.tab_id, { active: true })
      if (tab && tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
      }
      return { ok: true, status: 'success', data: { tab: tab ? describe(tab) : null } }
    }
    case 'close': {
      if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'close requires tab_id' }
      // Close is the recovery path and must always clear the tab, so a
      // beforeunload it raises is auto-accepted rather than held for the
      // agent (#169). Only effective while the tab is attached (ownership
      // rides the attach); an unattached "Leave site?" tab can still refuse
      // its own close, which SKILL.md's matrix covers.
      expectBeforeunloadAccept(a.tab_id)
      await chrome.tabs.remove(a.tab_id)
      return { ok: true, status: 'success', data: { closed: a.tab_id } }
    }
    case 'reload': {
      if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'reload requires tab_id' }
      const t0 = Date.now()
      // Armed BEFORE the reload: the tab still reads `complete` from the old
      // document at this point, so anything with an already-complete early-out
      // would return instantly having waited for nothing.
      const settled = watchForTabComplete(a.tab_id, TAB_LOAD_WAIT_MS)
      try {
        await chrome.tabs.reload(a.tab_id)
      } catch (e) {
        // The watcher is already armed, and its timer would otherwise keep the
        // service worker awake for the full bound after this command returned.
        await settled.catch(() => undefined)
        return { ok: false, status: 'error', error: `reload failed: ${String(e)}` }
      }
      const complete = await settled
      // url and title too: a reload can redirect or land on a login wall, and
      // the agent is told to check exactly those fields after a navigation.
      const reloaded = await chrome.tabs.get(a.tab_id).catch(() => null)
      return {
        ok: true,
        status: 'success',
        data: {
          reloaded: a.tab_id,
          complete,
          ...(reloaded ? { tab: describe(reloaded) } : {}),
          // #175: a reload re-fetches the document, so a page that started
          // serving errors since the first load shows it here.
          ...statusPayload(a.tab_id, t0, [reloaded?.url]),
        },
      }
    }
    case 'zoom': {
      if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'zoom requires tab_id' }
      const report = async (extra: Record<string, unknown>) => {
        const factor = await chrome.tabs.getZoom(a.tab_id as number)
        const settings = await chrome.tabs.getZoomSettings(a.tab_id as number).catch(() => null)
        return {
          ok: true as const,
          status: 'success' as const,
          // Read BACK rather than echoing what was asked: Chrome clamps, and
          // changing the scope can itself move the factor.
          data: {
            tab_id: a.tab_id,
            zoom: factor,
            percent: Math.round(factor * 100),
            scope: settings?.scope ?? null,
            ...extra,
          },
        }
      }

      // No factor given is a READ. Cheap, and the only way for a driving agent
      // to discover it is on a zoomed page at all: page zoom silently breaks
      // every coordinate the capture path produces (#231).
      if (a.zoom === undefined || a.zoom === null) return report({})

      // 0 is the UNDO, and it is a scope restore rather than a factor. Setting
      // the scope back to per-origin makes the tab follow the USER's own saved
      // preference again, which is the true inverse of what a set did. Zeroing
      // the factor instead would leave the tab pinned per-tab, still ignoring
      // that preference and silently diverging from every other tab on the
      // origin.
      if (a.zoom === 0) {
        await chrome.tabs.setZoomSettings(a.tab_id, { scope: 'per-origin' })
        return report({ restored_to_user_setting: true })
      }

      if (!(a.zoom >= ZOOM_MIN && a.zoom <= ZOOM_MAX)) {
        return {
          ok: false,
          status: 'error',
          error:
            `zoom must be between ${ZOOM_MIN} and ${ZOOM_MAX} (Chrome's own range), ` +
            `or 0 to restore the user's own setting; got ${String(a.zoom)}`,
        }
      }

      // PER-TAB on purpose. Chrome's default zoom scope is per-ORIGIN and
      // PERSISTENT: setting it the ordinary way would rewrite a preference of
      // the user's, for every tab on that site, permanently, as a side effect
      // of an agent wanting accurate coordinates for one capture. Per-tab
      // scope confines it to this tab and lets navigation return the tab to
      // the user's setting on its own. The cost is that it does not survive a
      // navigation, which the payload says out loud rather than leaving the
      // agent to discover mid-drive.
      await chrome.tabs.setZoomSettings(a.tab_id, { scope: 'per-tab' })
      await chrome.tabs.setZoom(a.tab_id, a.zoom)
      return report({ resets_on_navigation: true })
    }
    default:
      return { ok: false, status: 'error', error: `unknown action: ${String(a.action)}` }
  }
}

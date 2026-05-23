import type { CommandResult } from '../../shared/types'

interface TabsArgs {
  action: 'list' | 'create' | 'switch' | 'close' | 'reload'
  tab_id?: number
  url?: string
}

function describe(tab: chrome.tabs.Tab) {
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
      const tab = await chrome.tabs.create({ url: a.url })
      return { ok: true, status: 'success', data: { tab: describe(tab) } }
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
      await chrome.tabs.remove(a.tab_id)
      return { ok: true, status: 'success', data: { closed: a.tab_id } }
    }
    case 'reload': {
      if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'reload requires tab_id' }
      await chrome.tabs.reload(a.tab_id)
      return { ok: true, status: 'success', data: { reloaded: a.tab_id } }
    }
    default:
      return { ok: false, status: 'error', error: `unknown action: ${String(a.action)}` }
  }
}

import { beforeEach, vi } from 'vitest'

interface StorageArea {
  data: Record<string, unknown>
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

function makeStorageArea(): StorageArea {
  const area: StorageArea = {
    data: {},
    get: async (keys) => {
      if (keys === null || keys === undefined) return { ...area.data }
      const requested: string[] = Array.isArray(keys)
        ? keys
        : typeof keys === 'string'
          ? [keys]
          : Object.keys(keys)
      const out: Record<string, unknown> = {}
      for (const k of requested) if (k in area.data) out[k] = area.data[k]
      return out
    },
    set: async (items) => {
      Object.assign(area.data, items)
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) delete area.data[k]
    },
  }
  return area
}

interface TabRecord {
  id: number
  url?: string
  title?: string
  active?: boolean
  windowId?: number
  index?: number
  status?: string
}

interface MockChrome {
  runtime: {
    id: string
    sendMessage: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    getManifest: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
    onInstalled: { addListener: ReturnType<typeof vi.fn> }
    onStartup: { addListener: ReturnType<typeof vi.fn> }
  }
  storage: { local: StorageArea; sync: StorageArea; session: StorageArea }
  alarms: { create: ReturnType<typeof vi.fn>; onAlarm: { addListener: ReturnType<typeof vi.fn> } }
  permissions: { request: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn> }
  tabs: {
    query: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    goBack: ReturnType<typeof vi.fn>
    goForward: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    captureVisibleTab: ReturnType<typeof vi.fn>
    onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
    onRemoved: { addListener: ReturnType<typeof vi.fn> }
    _tabs: TabRecord[]
  }
  scripting: { executeScript: ReturnType<typeof vi.fn> }
  debugger: {
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
    onEvent: { addListener: ReturnType<typeof vi.fn> }
    onDetach: { addListener: ReturnType<typeof vi.fn> }
  }
  windows: {
    update: ReturnType<typeof vi.fn>
    getAll: ReturnType<typeof vi.fn>
    getLastFocused: ReturnType<typeof vi.fn>
  }
  webNavigation?: {
    onCommitted: { addListener: ReturnType<typeof vi.fn> }
    onBeforeNavigate: { addListener: ReturnType<typeof vi.fn> }
    onErrorOccurred: { addListener: ReturnType<typeof vi.fn> }
    onReferenceFragmentUpdated: { addListener: ReturnType<typeof vi.fn> }
    onHistoryStateUpdated: { addListener: ReturnType<typeof vi.fn> }
  }
  webRequest?: {
    onResponseStarted: { addListener: ReturnType<typeof vi.fn> }
  }
  notifications?: { create: ReturnType<typeof vi.fn> }
}

function makeMockChrome(): MockChrome {
  return {
    runtime: {
      id: 'test-extension-id-aaaaaaaaaaaaaaaa',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
      getManifest: vi.fn(() => ({ version: '9.9.9' })),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: { local: makeStorageArea(), sync: makeStorageArea(), session: makeStorageArea() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    permissions: {
      request: vi.fn().mockResolvedValue(true),
      contains: vi.fn().mockResolvedValue(true),
    },
    tabs: {
      _tabs: [
        { id: 1, url: 'https://example.com', title: 'Example', active: true, windowId: 100, index: 0, status: 'complete' },
        { id: 2, url: 'about:blank', title: 'New Tab', active: false, windowId: 100, index: 1, status: 'complete' },
      ],
      query: vi.fn(async function (this: MockChrome['tabs']) {
        return this._tabs.slice()
      }),
      create: vi.fn(async function (this: MockChrome['tabs'], props: { url: string }) {
        const tab: TabRecord = {
          id: 100 + this._tabs.length,
          url: props.url,
          title: 'created',
          active: true,
          windowId: 100,
          index: this._tabs.length,
          status: 'complete',
        }
        this._tabs.push(tab)
        return tab
      }),
      update: vi.fn(async function (this: MockChrome['tabs'], tabId: number, props: Partial<TabRecord>) {
        const tab = this._tabs.find((t) => t.id === tabId)
        if (!tab) throw new Error('no such tab')
        Object.assign(tab, props)
        return tab
      }),
      remove: vi.fn(async function (this: MockChrome['tabs'], tabId: number) {
        const idx = this._tabs.findIndex((t) => t.id === tabId)
        if (idx >= 0) this._tabs.splice(idx, 1)
      }),
      reload: vi.fn(async () => undefined),
      goBack: vi.fn(async () => undefined),
      goForward: vi.fn(async () => undefined),
      get: vi.fn(async function (this: MockChrome['tabs'], tabId: number) {
        const tab = this._tabs.find((t) => t.id === tabId)
        if (!tab) throw new Error('no such tab')
        return tab
      }),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,aGVsbG8='),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { found: true, text: 'mock text' } }]),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    windows: {
      update: vi.fn(async () => undefined),
      // Default: one window, focused. Multi-window placement tests override.
      getAll: vi.fn(async () => [{ id: 100, focused: true, type: 'normal' }]),
      getLastFocused: vi.fn(async () => ({ id: 100, focused: true, type: 'normal' })),
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn() },
      onBeforeNavigate: { addListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn() },
      onReferenceFragmentUpdated: { addListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn() },
    },
    webRequest: {
      onResponseStarted: { addListener: vi.fn() },
    },
    notifications: { create: vi.fn() },
  }
}

function install(): void {
  ;(globalThis as unknown as { chrome: MockChrome }).chrome = makeMockChrome()
}

install()

beforeEach(() => {
  install()
})

export type { MockChrome }

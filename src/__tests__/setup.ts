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

interface MockChrome {
  runtime: {
    id: string
    sendMessage: ReturnType<typeof vi.fn>
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
    onInstalled: { addListener: ReturnType<typeof vi.fn> }
    onStartup: { addListener: ReturnType<typeof vi.fn> }
  }
  storage: { local: StorageArea; sync: StorageArea }
  alarms: { create: ReturnType<typeof vi.fn>; onAlarm: { addListener: ReturnType<typeof vi.fn> } }
  permissions: { request: ReturnType<typeof vi.fn> }
}

function makeMockChrome(): MockChrome {
  return {
    runtime: {
      id: 'test-extension-id-aaaaaaaaaaaaaaaa',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: { local: makeStorageArea(), sync: makeStorageArea() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    permissions: { request: vi.fn().mockResolvedValue(true) },
  }
}

function install(): void {
  ;(globalThis as unknown as { chrome: MockChrome }).chrome = makeMockChrome()
}

install()

beforeEach(() => {
  install()
})

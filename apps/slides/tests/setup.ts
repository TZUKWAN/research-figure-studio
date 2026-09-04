// Node 22 exposes an experimental global localStorage object without the
// Storage methods when no --localstorage-file is configured. It can also leak
// through jsdom's window proxy, so install a per-worker browser-compatible
// implementation for renderer tests.
const values = new Map<string, string>()

// React 19 uses this flag to enable act() environment diagnostics.
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const storage: Storage = {
  get length() {
    return values.size
  },
  clear() {
    values.clear()
  },
  getItem(key: string) {
    return values.get(String(key)) ?? null
  },
  key(index: number) {
    return Array.from(values.keys())[index] ?? null
  },
  removeItem(key: string) {
    values.delete(String(key))
  },
  setItem(key: string, value: string) {
    values.set(String(key), String(value))
  },
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: storage,
})

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

/**
 * Augmentable global counter bag for app-specific instrumentation read by meters.
 *
 * Apps augment the `DebugBag` interface to declare their counters, then call
 * `incrDebug` / `setDebug` at the instrumentation site. Meter presets read via
 * `getDebug`. Values default to `0` when missing.
 *
 * @example
 *   declare module '@overeng/meters/debug-bag' {
 *     interface DebugBag {
 *       RpcInFlight: number
 *       ReactRender1: number
 *     }
 *   }
 *
 *   incrDebug('RpcInFlight')
 *   const v = getDebug('RpcInFlight')
 */

export interface DebugBag {
  // Augmented per-app via `declare module`
}

type Key = keyof DebugBag & string

const DEBUG_GLOBAL_KEY = '__debug'

type Bag = Record<string, number>

const getBag = (): Bag => {
  const g = globalThis as unknown as Record<string, unknown>
  let bag = g[DEBUG_GLOBAL_KEY] as Bag | undefined
  if (bag === undefined) {
    bag = {}
    g[DEBUG_GLOBAL_KEY] = bag
  }
  return bag
}

export const getDebug = <K extends Key>(key: K): number => getBag()[key] ?? 0

export const setDebug = <K extends Key>(key: K, value: number): void => {
  getBag()[key] = value
}

export const incrDebug = <K extends Key>(key: K, by: number = 1): void => {
  const bag = getBag()
  bag[key] = (bag[key] ?? 0) + by
}

export const resetDebug = <K extends Key>(key: K): number => {
  const bag = getBag()
  const prev = bag[key] ?? 0
  bag[key] = 0
  return prev
}

export const snapshotDebug = (): Readonly<Record<string, number>> => ({ ...getBag() })

/**
 * Runtime-keyed counter increment. Use when the key is computed at runtime
 * (e.g. derived from a component prop). For type-checked keys, prefer
 * `incrDebug` with `declare module` augmentation.
 */
export const incrDebugRuntime = (key: string, by: number = 1): void => {
  const bag = getBag()
  bag[key] = (bag[key] ?? 0) + by
}

/**
 * Runtime-keyed counter read. Returns 0 when the key has never been written.
 * Pair with `incrDebugRuntime` for runtime-string keys.
 */
export const getDebugRuntime = (key: string): number => getBag()[key] ?? 0

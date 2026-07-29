/**
 * Single rAF-driven engine that powers both the visual MeterGrid and any
 * headless consumers (RPC, OTEL, regression tests). All frame bookkeeping
 * (FPS calibration, frame-number derivation, skipped-frame counting,
 * trailing-window stats, per-block value pumping) lives here so the visual
 * and headless paths cannot drift.
 */

import { snapshotDebug } from './debug-bag.ts'
import type { MeterBlock, MeterBlockFn } from './grid/MeterGrid.tsx'

export type FrameSample = {
  /** Current FPS bucket the engine has calibrated to (60/120/144/160/240). */
  systemFps: number
  /**
   * Wall-clock-derived bucket index: `Math.floor(now / (1000 / systemFps))`.
   * NOT a "since start" counter — it can jump when the rAF loop falls behind
   * the bucket and is reset to a fresh wall-clock bucket on `reset()`.
   * Use `framesCaptured` from {@link EngineSnapshot} for a monotonic count.
   */
  frameNumber: number
  /** Frames the rAF loop missed since the previous tick (>= 0). */
  skippedFrames: number
  /** ms since the previous captured tick. 0 on the first captured tick. */
  frameDuration: number
  /** Each block's getFrameValue() result for this tick (parallel to engine `blocks` config). */
  latestPerBlock: ReadonlyArray<unknown>
}

export type EngineSnapshot = {
  systemFps: number
  /** Trailing average FPS over windowSizeMs. 0 before first tick. */
  averageFps: number
  /** Cumulative skipped frames since start/reset. */
  frameDrops: number
  /** Cumulative captured frames since start/reset. */
  framesCaptured: number
  p50Ms: number
  p99Ms: number
  /** Wall-clock ms since start (or last reset). 0 before start. */
  uptimeMs: number
  /**
   * Most recent value for each block (parallel to input blocks). Each slot
   * is `undefined` until that block's first tick fires; before any tick
   * fires the array is `[undefined, undefined, ...]`.
   */
  latestPerBlock: ReadonlyArray<unknown | undefined>
}

export type MetersEngineOptions = {
  blocks: ReadonlyArray<MeterBlockFn<any>>
  /** Trailing window for averageFps/p50/p99. Defaults to 2000ms. */
  windowSizeMs?: number
}

/**
 * Opaque handle returned by {@link MetersEngine.beginMeasure} and consumed by
 * {@link MetersEngine.endMeasure}. The handle captures the engine + DebugBag
 * state at bracket-start so deltas can be computed without coordinating two
 * globals at end-time.
 *
 * `engineId` lets `endMeasure` reject handles minted by a different engine
 * instance. It is a string (not a Symbol) so the handle survives the
 * Playwright JSON round-trip via `page.evaluate`.
 */
export type MeasurementHandle = {
  readonly id: number
  readonly engineId: string
  readonly startedAtMs: number
  readonly beforeSnapshot: EngineSnapshot
  readonly beforeDebug: Readonly<Record<string, number>>
}

/**
 * Per-window delta + summary stats. Returned from
 * {@link MetersEngine.endMeasure} and (via {@link MetersEngine.measureWindow})
 * the sugar form. `debugDelta` covers any DebugBag key that changed during
 * the bracket, including app-defined render counters (e.g. `Renders.sidebar`).
 *
 * Bracket-scoped: `averageFps` is computed strictly from the bracket's
 * `framesCaptured / durationMs`, not from the engine's trailing window. For
 * percentile stats over the engine's trailing window, call
 * {@link MetersEngine.snapshot} separately (see T07).
 */
export type MeasurementResult = {
  /** Frames the rAF loop missed during the bracket (delta). */
  frameDrops: number
  /** Frames captured during the bracket (delta). */
  framesCaptured: number
  /** Wall-clock ms from beginMeasure() to endMeasure(). */
  durationMs: number
  /**
   * Bracket-scoped average fps: `round(framesCaptured * 1000 / durationMs)`.
   * 0 when the bracket captured no frames or had zero duration.
   */
  averageFps: number
  /**
   * Per-key DebugBag delta over the bracket. Only keys whose value changed
   * are included (zero deltas omitted). Counters are read non-destructively;
   * meter blocks that visualize the same keys must compute their own
   * per-frame deltas (see `makeRenderProfilerBlock`).
   */
  debugDelta: Readonly<Record<string, number>>
}

export type EndMeasureOptions = {
  /**
   * How many additional captured frames to wait for before snapshotting.
   * Defaults to 0 — `endMeasure` resolves on the next microtask. Useful from
   * Playwright when you want explicit settling without a wall-clock timeout.
   */
  settleFrames?: number
}

export type MeasureWindowOptions = {
  /**
   * How many additional captured frames to wait for after `work` resolves
   * before closing the window. Defaults to 30 (~500ms @60fps).
   */
  settleFrames?: number
}

/**
 * Render-only view of a {@link MeterBlock}. Excludes `getFrameValue` so
 * renderers cannot accidentally pump values out-of-band — only the engine
 * owns the value pump.
 */
export type ResolvedMeterBlock<TVal = unknown> = Pick<
  MeterBlock<TVal>,
  'width' | 'height' | 'draw' | 'uninitializedValue'
>

export type MetersEngine = {
  start: () => void
  stop: () => void
  reset: () => void
  /**
   * Stop the loop and clear all subscribers. After dispose() the engine
   * cannot be restarted: subsequent `start()` and `subscribe()` calls
   * become no-ops (subscribe returns a no-op unsubscribe). Any in-flight
   * `endMeasure(...)` settle promises are rejected with
   * `Error('engine disposed during settle')` — silent resolution would mask
   * teardown ordering bugs.
   */
  dispose: () => void
  isRunning: () => boolean
  snapshot: () => EngineSnapshot
  /**
   * Subscribe for per-tick {@link FrameSample}s. Returns an unsubscribe.
   * Late subscribers do not receive a synchronous current-state sample;
   * they wait until the next rAF tick. For a synchronous read, call
   * {@link snapshot} first.
   */
  subscribe: (listener: (sample: FrameSample) => void) => () => void
  /**
   * Resolved blocks for the given frameBarWidth using the engine's current
   * systemFps. Returned blocks are render-only ({@link ResolvedMeterBlock}):
   * the engine owns the value pump, so callers cannot accidentally invoke
   * `getFrameValue`. Re-call after fps recalibration if needed.
   */
  getResolvedBlocks: (frameBarWidth: number) => ReadonlyArray<ResolvedMeterBlock<any>>
  /**
   * Capture a bracket-start snapshot. The engine must be running when called;
   * throws otherwise. Pair with {@link endMeasure}; the two together compose
   * a measurement that works across the node↔browser boundary (Playwright):
   *
   *   const handle = await page.evaluate(() => __metersEngine.beginMeasure());
   *   await page.click('[data-testid="filter"]');
   *   const result = await page.evaluate(
   *     (h) => __metersEngine.endMeasure(h),
   *     handle,
   *   );
   */
  beginMeasure: () => MeasurementHandle
  /**
   * Close a bracket and return the delta. Optionally waits for additional
   * captured frames before snapshotting (`settleFrames`, default 0). Returns
   * a Promise so `settleFrames > 0` can be awaited cleanly.
   *
   * Throws synchronously when called on a stopped or disposed engine, or
   * when the handle was minted by a different engine instance.
   *
   * Teardown semantics for an in-flight settle:
   *  - `stop()` resolves pending settle promises with whatever was captured
   *    so far — stopping mid-bracket is a legitimate teardown path.
   *  - `dispose()` rejects pending settle promises with
   *    `Error('engine disposed during settle')` — disposed is terminal and
   *    silently resolving would mask bugs.
   */
  endMeasure: (handle: MeasurementHandle, options?: EndMeasureOptions) => Promise<MeasurementResult>
  /**
   * Convenience: bracket a (possibly async) browser-side function and return
   * its result alongside the measurement. Sugar over begin/end with
   * `settleFrames` defaulting to 30 (~500ms @60fps). Use this when both
   * `work` and the assertion run in the same JS realm; from Playwright,
   * prefer `beginMeasure` + `endMeasure` so `page.click` can sit in between.
   */
  measureWindow: <T>(
    work: () => T | Promise<T>,
    options?: MeasureWindowOptions,
  ) => Promise<{ result: T; measurement: MeasurementResult }>
}

const supportedFps = [60, 120, 144, 160, 240]

const closestSupportedFps = (raw: number): number | undefined => {
  let best: number | undefined
  let bestDelta = Infinity
  for (const fps of supportedFps) {
    const delta = Math.abs(raw - fps)
    if (delta < bestDelta && delta < 10) {
      best = fps
      bestDelta = delta
    }
  }
  return best
}

export const createMetersEngine = (opts: MetersEngineOptions): MetersEngine => {
  const windowSizeMs = opts.windowSizeMs ?? 2000
  const blockFns = opts.blocks

  /**
   * Resolve each block once with placeholder layout params for the value pump.
   * `getFrameValue` and `uninitializedValue` MUST NOT depend on `systemFps` /
   * `frameBarWidth` (all current presets satisfy this — see the doc on
   * {@link MeterBlockFn}); `draw` / `width` / `height` are obtained via
   * {@link getResolvedBlocks} when a renderer needs them.
   */
  const valuePumpBlocks = blockFns.map((fn) => fn({ frameBarWidth: 1, systemFps: 60 }))

  let raf: number | undefined
  let startedAt: number | undefined
  let previousFrameTime = 0
  let previousFrameNumber = 0
  let firstTickPending = true
  let systemFps = 60
  let frameDrops = 0
  let framesCaptured = 0
  let disposed = false

  const last500FrameDurations: number[] = Array.from<number>({ length: 500 }).fill(0)
  let last500WriteIdx = 0

  // Trailing window of recent frame durations, bounded for the highest fps bucket.
  const maxBuffer = Math.ceil((windowSizeMs / 1000) * 240) + 16
  const recentDurations: number[] = []

  const latestPerBlock: unknown[] = blockFns.map(() => undefined)

  const listeners = new Set<(sample: FrameSample) => void>()

  const readjustSystemFps = () => {
    const nonZero = last500FrameDurations.filter((d) => d > 0).sort((a, b) => a - b)
    if (nonZero.length < 10) return

    const medianIndex = Math.floor(nonZero.length / 2)
    const tenAroundMedian = nonZero.slice(medianIndex - 5, medianIndex + 5)
    const sum = tenAroundMedian.reduce((acc, d) => acc + d, 0)
    if (sum <= 0) return
    const newSystemFps = Math.round(10_000 / sum)

    const closest = closestSupportedFps(newSystemFps)
    if (closest === undefined) {
      console.warn(`Unsupported system FPS ${newSystemFps}`)
      return
    }

    if (closest !== systemFps) {
      systemFps = closest
    }
  }

  const tick = (now: number) => {
    raf = globalThis.requestAnimationFrame(tick)

    const resolutionInMs = 1000 / systemFps
    const frameNumber = Math.floor(now / resolutionInMs)

    let skippedFrames: number
    let frameDuration: number
    if (firstTickPending) {
      skippedFrames = 0
      frameDuration = 0
      firstTickPending = false
    } else {
      skippedFrames = Math.max(0, frameNumber - previousFrameNumber - 1)
      frameDuration = now - previousFrameTime
    }
    frameDrops += skippedFrames
    previousFrameNumber = frameNumber
    previousFrameTime = now
    framesCaptured += 1

    if (frameDuration > 0) {
      recentDurations.push(frameDuration)
      if (recentDurations.length > maxBuffer) recentDurations.shift()

      last500FrameDurations[last500WriteIdx] = frameDuration
      last500WriteIdx = (last500WriteIdx + 1) % last500FrameDurations.length
    }

    for (let i = 0; i < valuePumpBlocks.length; i++) {
      latestPerBlock[i] = valuePumpBlocks[i]!.getFrameValue()
    }

    if (framesCaptured % 100 === 0) {
      readjustSystemFps()
    }

    const sample: FrameSample = {
      systemFps,
      frameNumber,
      skippedFrames,
      frameDuration,
      latestPerBlock: latestPerBlock.slice(),
    }

    // Snapshot listeners so subscribe/unsubscribe during dispatch is safe.
    const snapshotListeners = [...listeners]
    for (const listener of snapshotListeners) {
      try {
        listener(sample)
      } catch (err) {
        console.error('MetersEngine listener error', err)
      }
    }

    // Drive in-flight endMeasure settles. Decoupled from `listeners` so a
    // settle in progress doesn't pollute subscribe/unsubscribe semantics.
    tickSettlers()
  }

  const reset = () => {
    // Reject any in-flight settle promises before we wipe the counters they
    // depend on — otherwise endMeasure would compute negative deltas
    // (after.framesCaptured - handle.beforeSnapshot.framesCaptured).
    if (pendingSettlers.size > 0) {
      const entries = [...pendingSettlers]
      pendingSettlers.clear()
      for (const s of entries) {
        try {
          s.reject(new Error('MetersEngine reset during settle'))
        } catch (err) {
          console.error('MetersEngine settle reject error', err)
        }
      }
    }
    startedAt = globalThis.performance.now()
    previousFrameTime = 0
    previousFrameNumber = 0
    firstTickPending = true
    frameDrops = 0
    framesCaptured = 0
    recentDurations.length = 0
    last500FrameDurations.fill(0)
    last500WriteIdx = 0
    systemFps = 60
    for (let i = 0; i < latestPerBlock.length; i++) latestPerBlock[i] = undefined
  }

  const snapshot = (): EngineSnapshot => {
    const now = globalThis.performance.now()
    let acc = 0
    let count = 0
    const recent: number[] = []
    let walked = 0
    for (let i = recentDurations.length - 1; i >= 0; i--) {
      const d = recentDurations[i]!
      walked += d
      recent.push(d)
      acc += d
      count += 1
      if (walked >= windowSizeMs) break
    }
    const averageFps = count > 0 && acc > 0 ? Math.round(1000 / (acc / count)) : 0

    const sortedRecent = [...recent].sort((a, b) => a - b)
    const p50Ms =
      sortedRecent.length > 0 ? (sortedRecent[Math.floor(sortedRecent.length * 0.5)] ?? 0) : 0
    const p99Ms =
      sortedRecent.length > 0 ? (sortedRecent[Math.floor(sortedRecent.length * 0.99)] ?? 0) : 0

    return {
      systemFps,
      averageFps,
      frameDrops,
      framesCaptured,
      p50Ms,
      p99Ms,
      uptimeMs: startedAt === undefined ? 0 : now - startedAt,
      latestPerBlock: latestPerBlock.slice(),
    }
  }

  /**
   * Track pending {@link endMeasure} settle promises out-of-band from the
   * public `listeners` set so settle handlers don't pollute subscribe /
   * unsubscribe semantics. `stop()` resolves these (graceful teardown);
   * `dispose()` rejects them (loud-fail terminal state).
   */
  type Settler = { remaining: number; resolve: () => void; reject: (err: Error) => void }
  const pendingSettlers = new Set<Settler>()

  const tickSettlers = () => {
    if (pendingSettlers.size === 0) return
    // Snapshot so resolve() removing entries during iteration is safe.
    const entries = [...pendingSettlers]
    for (const s of entries) {
      s.remaining -= 1
      if (s.remaining <= 0) {
        pendingSettlers.delete(s)
        s.resolve()
      }
    }
  }

  const stop = () => {
    if (raf !== undefined) globalThis.cancelAnimationFrame(raf)
    raf = undefined
    // Resolve in-flight settles with whatever was captured so far. A
    // mid-bracket stop is legitimate teardown — don't reject.
    if (pendingSettlers.size > 0) {
      const entries = [...pendingSettlers]
      pendingSettlers.clear()
      for (const s of entries) s.resolve()
    }
  }

  // Engine-scoped id so endMeasure can reject handles minted by another
  // engine. String (not Symbol) so the handle survives the JSON round-trip
  // through Playwright's page.evaluate.
  const engineId = `meters-engine-${Math.random().toString(36).slice(2)}`
  let nextHandleId = 1

  const waitForFrames = (count: number): Promise<void> => {
    if (count <= 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      pendingSettlers.add({ remaining: count, resolve, reject })
    })
  }

  const beginMeasure = (): MeasurementHandle => {
    if (disposed) {
      throw new Error('beginMeasure called on disposed engine')
    }
    if (raf === undefined) {
      throw new Error('beginMeasure requires the engine to be running. Call start() first.')
    }
    return {
      id: nextHandleId++,
      engineId,
      startedAtMs: globalThis.performance.now(),
      beforeSnapshot: snapshot(),
      beforeDebug: snapshotDebug(),
    }
  }

  const computeDebugDelta = (
    before: Readonly<Record<string, number>>,
    after: Readonly<Record<string, number>>,
  ): Record<string, number> => {
    const out: Record<string, number> = {}
    const seen = new Set<string>()
    for (const k of Object.keys(after)) {
      seen.add(k)
      const d = after[k]! - (before[k] ?? 0)
      if (d !== 0) out[k] = d
    }
    for (const k of Object.keys(before)) {
      if (seen.has(k)) continue
      const d = (after[k] ?? 0) - before[k]!
      if (d !== 0) out[k] = d
    }
    return out
  }

  const endMeasure = async (
    handle: MeasurementHandle,
    options: EndMeasureOptions = {},
  ): Promise<MeasurementResult> => {
    if (disposed) throw new Error('endMeasure called on disposed engine')
    if (raf === undefined) throw new Error('endMeasure called on stopped engine')
    if (handle.engineId !== engineId) {
      throw new Error('endMeasure called with handle from a different engine')
    }
    await waitForFrames(options.settleFrames ?? 0)
    const after = snapshot()
    const afterDebug = snapshotDebug()
    const framesCaptured = after.framesCaptured - handle.beforeSnapshot.framesCaptured
    const durationMs = globalThis.performance.now() - handle.startedAtMs
    const averageFps =
      framesCaptured > 0 && durationMs > 0 ? Math.round((framesCaptured * 1000) / durationMs) : 0
    return {
      frameDrops: after.frameDrops - handle.beforeSnapshot.frameDrops,
      framesCaptured,
      durationMs,
      averageFps,
      debugDelta: computeDebugDelta(handle.beforeDebug, afterDebug),
    }
  }

  const measureWindow = async <T>(
    work: () => T | Promise<T>,
    options: MeasureWindowOptions = {},
  ): Promise<{ result: T; measurement: MeasurementResult }> => {
    const handle = beginMeasure()
    const result = await work()
    const measurement = await endMeasure(handle, { settleFrames: options.settleFrames ?? 30 })
    return { result, measurement }
  }

  return {
    start: () => {
      if (disposed) return
      if (raf !== undefined) return
      reset()
      raf = globalThis.requestAnimationFrame(tick)
    },
    stop,
    reset,
    dispose: () => {
      // Capture pending settlers BEFORE stop() resolves them — disposed is
      // terminal and pending settles must reject, not silently succeed.
      const settlersToReject = [...pendingSettlers]
      pendingSettlers.clear()
      stop()
      listeners.clear()
      disposed = true
      for (const s of settlersToReject) {
        s.reject(new Error('engine disposed during settle'))
      }
    },
    isRunning: () => raf !== undefined,
    snapshot,
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getResolvedBlocks: (frameBarWidth) =>
      blockFns.map((fn) => {
        const block = fn({ frameBarWidth, systemFps })
        return {
          width: block.width,
          height: block.height,
          draw: block.draw,
          uninitializedValue: block.uninitializedValue,
        }
      }),
    beginMeasure,
    endMeasure,
    measureWindow,
  }
}

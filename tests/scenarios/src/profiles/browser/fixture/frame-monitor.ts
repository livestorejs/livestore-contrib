import type { BrowserFrameTiming } from '../protocol.ts'

/** Frames at or below this gap count as on time at 60 Hz and are only counted, not listed. */
const SLOW_FRAME_THRESHOLD_MS = 20

export interface FrameMonitor {
  /**
   * Runs work the scenario harness drives inside the page (actions, observations). Frames that overlap it are reported
   * as harness-affected so frame metrics can exclude main-thread time the application did not cause.
   */
  readonly harness: <A>(label: string, run: () => Promise<A>) => Promise<A>
  /** Returns everything recorded since the previous drain, with times relative to the moment of the drain. */
  readonly drain: () => BrowserFrameTiming
  readonly stop: () => void
}

/**
 * Measures main-thread responsiveness the way a user perceives it: the gap between consecutive animation frames.
 * A long gap means the page could not paint, whatever kept the main thread busy. Long animation frame entries
 * (Chromium) add the blocking time the browser itself attributes to those frames.
 */
export const startFrameMonitor = (): FrameMonitor => {
  let windowStart = performance.now()
  let frameCount = 0
  let slowFrames: Array<readonly [number, number]> = []
  let longAnimationFrames: Array<readonly [number, number, number, string]> = []
  let harnessIntervals: Array<readonly [number, number, string]> = []
  let previousFrame: number | undefined
  let running = true

  const onFrame = (timestamp: number) => {
    if (running === false) return
    if (previousFrame !== undefined) {
      const gap = timestamp - previousFrame
      frameCount += 1
      if (gap > SLOW_FRAME_THRESHOLD_MS) slowFrames.push([previousFrame, gap])
    }
    previousFrame = timestamp
    requestAnimationFrame(onFrame)
  }
  requestAnimationFrame(onFrame)

  let observer: PerformanceObserver | undefined
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame') === true) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const frame = entry as PerformanceEntry & {
          readonly blockingDuration?: number
          readonly scripts?: ReadonlyArray<{
            readonly invokerType: string
            readonly invoker: string
            readonly duration: number
          }>
        }
        longAnimationFrames.push([
          entry.startTime,
          entry.duration,
          frame.blockingDuration ?? 0,
          describeScripts(frame.scripts),
        ])
      }
    })
    observer.observe({ type: 'long-animation-frame', buffered: false })
  }

  return {
    harness: async (label, run) => {
      const started = performance.now()
      try {
        return await run()
      } finally {
        harnessIntervals.push([started, performance.now() - started, label])
      }
    },
    drain: () => {
      const now = performance.now()
      const relative = (time: number) => Math.round((time - now) * 10) / 10
      const round = (duration: number) => Math.round(duration * 10) / 10
      const timing: BrowserFrameTiming = {
        windowMs: round(now - windowStart),
        frameCount,
        slowFrames: slowFrames.map(([start, gap]) => [relative(start), round(gap)]),
        longAnimationFrames: longAnimationFrames.map(([start, duration, blocking, scripts]) => [
          relative(start),
          round(duration),
          round(blocking),
          scripts,
        ]),
        harnessIntervals: harnessIntervals.map(([start, duration, label]) => [relative(start), round(duration), label]),
        longAnimationFramesSupported: observer !== undefined,
      }
      windowStart = now
      frameCount = 0
      slowFrames = []
      longAnimationFrames = []
      harnessIntervals = []
      return timing
    },
    stop: () => {
      running = false
      observer?.disconnect()
    },
  }
}

/** The longest scripts of a long animation frame, e.g. `user-callback:TimerHandler:setTimeout 120ms`. */
const describeScripts = (
  scripts: ReadonlyArray<{ readonly invokerType: string; readonly invoker: string; readonly duration: number }> = [],
): string =>
  scripts
    .toSorted((left, right) => right.duration - left.duration)
    .slice(0, 3)
    .map((script) => `${script.invokerType}:${script.invoker} ${Math.round(script.duration)}ms`)
    .join(', ')

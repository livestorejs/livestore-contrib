import React from 'react'

import { createMetersEngine, type MetersEngine, type ResolvedMeterBlock } from '../engine.ts'
import { shouldNeverHappen } from '../internal/utils.ts'

export const PR = typeof window === 'undefined' ? 1 : Math.round(window.devicePixelRatio || 1)

/**
 * `getFrameValue` and `uninitializedValue` MUST NOT depend on `systemFps` or
 * `frameBarWidth` — the engine resolves a block once with placeholder layout
 * params for the value pump, and recomputes layout-dependent fields (`width`,
 * `height`, `draw`) lazily via {@link MetersEngine.getResolvedBlocks}. Only
 * `width`, `height`, and `draw` may legitimately depend on those params.
 */
export type MeterBlockFn<TVal = number> = (_: {
  systemFps: number
  frameBarWidth: number
}) => MeterBlock<TVal>

export type MeterBlock<TVal = number> = {
  width: number
  height: number
  getFrameValue: () => TVal
  uninitializedValue: TVal
  draw: (
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number,
    values: ReadonlyArray<TVal | FRAME_MISS>,
    frameNumber: number,
  ) => void
}

export type MeterGridProps<TBlocks extends ReadonlyArray<MeterBlockFn<any>>> = {
  className?: string
  blocks: TBlocks
  onClick?: (e: React.MouseEvent) => void
  /** Gap in px */
  gap?: number
  pauseRenderingRef?: React.RefObject<boolean>
  orientation?: 'vertical' | 'horizontal'
  /**
   * If provided, the grid's internal {@link MetersEngine} is exposed via this
   * ref so headless consumers (snapshots, subscriptions) can share the same
   * rAF loop instead of starting a second one.
   */
  engineRef?: React.RefObject<MetersEngine | undefined>
}

export const FRAME_MISS = Symbol('FRAME_MISS')
export type FRAME_MISS = typeof FRAME_MISS

const frameBarWidthForFps = (fps: number): number => {
  if (fps <= 60) return 2
  if (fps <= 144) return 1
  return 0.5
}

export const MeterGrid = <TBlocks extends ReadonlyArray<MeterBlockFn<any>>>({
  className,
  blocks: blocks_,
  onClick,
  gap = 0,
  pauseRenderingRef,
  orientation = 'vertical',
  engineRef,
}: MeterGridProps<TBlocks>) => {
  // Track the previous engine so we can stop it when `blocks_` identity
  // changes mid-life (the cleanup return in `useMemo` doesn't fire).
  const previousEngineRef = React.useRef<MetersEngine | undefined>(undefined)
  const engine = React.useMemo(() => {
    previousEngineRef.current?.stop()
    const e = createMetersEngine({ blocks: blocks_ })
    previousEngineRef.current = e
    return e
  }, [blocks_])

  // Engine lifecycle is owned by component lifetime, NOT canvas attach/detach.
  // This keeps headless consumers using `engineRef` working even when the
  // canvas hasn't mounted yet, and prevents engine restarts on re-renders.
  React.useEffect(() => {
    engine.start()
    if (engineRef !== undefined) engineRef.current = engine
    return () => {
      engine.stop()
      if (engineRef !== undefined && engineRef.current === engine) {
        engineRef.current = undefined
      }
    }
  }, [engine, engineRef])

  // Use the engine's calibrated FPS at resolve-time. The canvas subscription
  // mutates the per-block ring buffer + frameBarWidth refs in place when the
  // bucket changes, avoiding a React-state ping-pong with the engine.
  const initialFps = engine.snapshot().systemFps
  const initialFrameBarWidth = frameBarWidthForFps(initialFps)
  const blocks = React.useMemo(
    () => engine.getResolvedBlocks(initialFrameBarWidth),
    [engine, initialFrameBarWidth],
  )

  let width: number
  let height: number
  let adjustedWidth: number
  let adjustedHeight: number

  if (orientation === 'vertical') {
    width = blocks[0]!.width
    height = blocks.reduce((acc, block) => acc + block.height + gap, 0)
    adjustedWidth = Math.round(width * PR)
    adjustedHeight = Math.round(height * PR)
  } else {
    width = blocks.reduce((acc, block) => acc + block.width + gap, 0)
    height = Math.max(...blocks.map((block) => block.height))
    adjustedWidth = Math.round(width * PR)
    adjustedHeight = Math.round(height * PR)
  }

  const adjustedGap = gap * PR

  const canvasRef = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return

      const ctx = canvas.getContext('2d')!

      // Local mutable state for this canvas attachment. We subscribe to the
      // engine for samples and react to FPS-bucket changes by rebuilding the
      // ring buffer + resolved blocks in place — no React state involved.
      let currentFps = engine.snapshot().systemFps
      let currentFrameBarWidth = frameBarWidthForFps(currentFps)
      let currentBlocks: ReadonlyArray<ResolvedMeterBlock<any>> =
        engine.getResolvedBlocks(currentFrameBarWidth)

      const computeFrameCounts = (
        bs: ReadonlyArray<ResolvedMeterBlock<any>>,
        frameBarW: number,
      ): { numberOfVisibleFrames: number | undefined; perBlock: number[] | undefined } => {
        if (orientation === 'vertical') {
          return {
            numberOfVisibleFrames: Math.floor(adjustedWidth / frameBarW),
            perBlock: undefined,
          }
        }
        return {
          numberOfVisibleFrames: undefined,
          perBlock: bs.map((block) => Math.floor(Math.round(block.width * PR) / frameBarW)),
        }
      }

      const buildBlockValues = (
        bs: ReadonlyArray<ResolvedMeterBlock<any>>,
        counts: ReturnType<typeof computeFrameCounts>,
      ): (unknown | FRAME_MISS)[][] =>
        orientation === 'vertical'
          ? bs.map((block) =>
              Array.from({ length: counts.numberOfVisibleFrames! }, () => block.uninitializedValue),
            )
          : bs.map((block, idx) => {
              const framesForBlock =
                counts.perBlock?.[idx] ??
                shouldNeverHappen('Expected frame count for horizontal block')
              return Array.from({ length: framesForBlock }, () => block.uninitializedValue)
            })

      let counts = computeFrameCounts(currentBlocks, currentFrameBarWidth)
      let blockValues: (unknown | FRAME_MISS)[][] = buildBlockValues(currentBlocks, counts)

      const draw = (frameNumber: number) => {
        ctx.clearRect(0, 0, adjustedWidth, adjustedHeight)

        if (orientation === 'vertical') {
          const originX = 0
          let originY = 0
          for (let blockIndex = 0; blockIndex < currentBlocks.length; blockIndex++) {
            const block = currentBlocks[blockIndex]!
            ctx.fillStyle = 'rgba(0, 0, 0, 0.2)'
            ctx.fillRect(0, originY, adjustedWidth, block.height * PR)
            block.draw(ctx, originX, originY, blockValues[blockIndex]!, frameNumber)
            originY += block.height * PR + adjustedGap
          }
          if (currentBlocks.length > 1) {
            let sepY = currentBlocks[0]!.height * PR
            for (let i = 0; i < currentBlocks.length - 1; i++) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'
              ctx.fillRect(0, sepY, adjustedWidth, PR)
              sepY += currentBlocks[i + 1]!.height * PR + adjustedGap
            }
          }
        } else {
          let originX = 0
          const originY = 0
          for (let blockIndex = 0; blockIndex < currentBlocks.length; blockIndex++) {
            const block = currentBlocks[blockIndex]!
            ctx.fillStyle = 'rgba(0, 0, 0, 0.2)'
            ctx.fillRect(originX, originY, block.width * PR, adjustedHeight)
            block.draw(ctx, originX, originY, blockValues[blockIndex]!, frameNumber)
            originX += block.width * PR + adjustedGap
          }
          if (currentBlocks.length > 1) {
            let sepX = currentBlocks[0]!.width * PR
            for (let i = 0; i < currentBlocks.length - 1; i++) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'
              ctx.fillRect(sepX, 0, PR, adjustedHeight)
              sepX += currentBlocks[i + 1]!.width * PR + adjustedGap
            }
          }
        }
      }

      const unsubscribe = engine.subscribe((sample) => {
        // FPS bucket changed: re-resolve blocks and rebuild the ring buffer.
        if (sample.systemFps !== currentFps) {
          currentFps = sample.systemFps
          currentFrameBarWidth = frameBarWidthForFps(currentFps)
          currentBlocks = engine.getResolvedBlocks(currentFrameBarWidth)
          counts = computeFrameCounts(currentBlocks, currentFrameBarWidth)
          blockValues = buildBlockValues(currentBlocks, counts)
        }

        for (let blockIndex = 0; blockIndex < currentBlocks.length; blockIndex++) {
          const values = blockValues[blockIndex]!

          for (let i = 0; i < sample.skippedFrames; i++) {
            values.shift()
            values.push(FRAME_MISS)
          }

          values.shift()
          values.push(sample.latestPerBlock[blockIndex])
        }

        if (pauseRenderingRef?.current !== true) {
          draw(sample.frameNumber)
        }
      })

      return () => {
        unsubscribe()
      }
    },
    [engine, adjustedWidth, adjustedHeight, orientation, adjustedGap, pauseRenderingRef],
  )

  return (
    <canvas
      width={adjustedWidth}
      height={adjustedHeight}
      className={className}
      onClick={onClick}
      ref={canvasRef}
      style={{ width, height, transform: `translateZ(0)`, contain: 'paint' }}
    />
  )
}

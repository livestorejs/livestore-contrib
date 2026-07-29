import type { MeterBlockFn } from './MeterGrid.tsx'
import { FRAME_MISS, PR } from './MeterGrid.tsx'

export const FRAME_UNINITIALIZED = Symbol('FRAME_UNINITIALIZED')
export type FRAME_UNINITIALIZED = typeof FRAME_UNINITIALIZED

export const makeFpsMeterBlock =
  ({
    height,
    width,
  }: {
    height: number
    width: number
  }): MeterBlockFn<number | FRAME_UNINITIALIZED> =>
  ({ frameBarWidth, systemFps }) => {
    const adjustedHeight = Math.round(height * PR)
    const adjustedWidth = Math.round(width * PR)

    const numberOfVisibleFrames = Math.floor(adjustedWidth / frameBarWidth)

    // NOTE larger values can result in more items taken from array than it has and makes stuff go boom
    const numberOfSecondsForAverageFps = 2

    const numberOfFramesForAverageFps = Math.min(
      numberOfSecondsForAverageFps * systemFps,
      numberOfVisibleFrames,
    )

    if (numberOfFramesForAverageFps > numberOfVisibleFrames) {
      throw new Error(
        `numberOfFramesForAverageFps (${numberOfFramesForAverageFps}) must be smaller than numberOfVisibleFrames (${numberOfVisibleFrames}). Either increase the width or increase the resolutionInMs.`,
      )
    }

    const chunkWidth = (1 / frameBarWidth) * 8

    return {
      width,
      height,
      getFrameValue: () => 1,
      uninitializedValue: FRAME_UNINITIALIZED,
      draw: (ctx, originX, originY, values, frameNumber) => {
        for (let i = 0; i < numberOfVisibleFrames; i++) {
          const frameVal = values[i]!
          if (frameVal === FRAME_UNINITIALIZED) continue

          const x = originX + i * frameBarWidth

          // NOTE the alternating colors are meant as an indication that the app rendering is not blocked
          const isEvenChunk = (frameNumber + i) % (chunkWidth * 2) < chunkWidth
          ctx.fillStyle =
            frameVal === FRAME_MISS
              ? 'rgba(255, 0, 0, 1)'
              : isEvenChunk
                ? 'rgba(255, 255, 255, 0.37)'
                : 'rgba(255, 255, 255, 0.4)'
          ctx.fillRect(x, originY + adjustedHeight, frameBarWidth, -adjustedHeight)
        }

        let frameCount = 0
        let numberOfInitializedFrames = 0
        for (let i = 0; i < numberOfFramesForAverageFps; i++) {
          const frameVal = values.at(-i - 1)!
          if (frameVal !== FRAME_UNINITIALIZED) {
            frameCount += frameVal === FRAME_MISS ? 0 : frameVal
            numberOfInitializedFrames++
          }
        }
        if (numberOfInitializedFrames >= numberOfFramesForAverageFps) {
          ctx.fillStyle = 'white'
          const fontSize = PR * 10
          ctx.font = `${fontSize}px monospace`

          const averageFps = Math.round((systemFps * frameCount) / numberOfInitializedFrames)
          ctx.fillText(`${averageFps} FPS`, originX + 2 * PR, originY + 12 * PR)
        }
      },
    }
  }

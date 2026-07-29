import { casesHandled } from '../internal/utils.ts'
import type { MeterBlock, MeterBlockFn } from './MeterGrid.tsx'
import { FRAME_MISS, PR } from './MeterGrid.tsx'

export type TextMode =
  | 'max'
  | 'avg'
  | 'latest'
  | 'latest-non-zero'
  | 'sum'
  | 'p-95'
  | 'sum-last-sec'

export const makeValueMeterBlock =
  ({
    getFrameColor = () => 'rgba(255, 255, 255, 0.3)',
    getText,
    textMode,
    getFrameValue,
    height,
    width,
  }: {
    getFrameColor?: (value: number) => string
    getText: (val: number) => string
    textMode: TextMode
  } & Pick<MeterBlock<number>, 'getFrameValue' | 'height' | 'width'>): MeterBlockFn<number> =>
  ({ frameBarWidth, systemFps }) => {
    const adjustedHeight = height * PR
    const getTextValue = makeGetTextValue(textMode, systemFps)

    return {
      height,
      width,
      getFrameValue,
      uninitializedValue: -1,
      draw: (ctx, originX, originY, values) => {
        const maxValue = maxFromValues(values) * 1.1 // add 10% headroom

        const heightNormalizeFactor = adjustedHeight / maxValue

        for (let i = 0; i < values.length; i++) {
          const value = values[i]!

          const x = originX + i * frameBarWidth

          if (value === FRAME_MISS || value <= 0) continue

          const height = value * heightNormalizeFactor

          ctx.fillStyle = getFrameColor(value)
          ctx.fillRect(x, originY + adjustedHeight, frameBarWidth, -height)
        }

        ctx.fillStyle = 'white'
        const fontSize = PR * 10
        ctx.font = `${fontSize}px monospace`

        ctx.fillText(getText(getTextValue(values)), originX + 2 * PR, originY + 12 * PR)
      },
    }
  }

const makeGetTextValue = (
  mode: TextMode,
  numberOfValuesPerSecond: number,
): ((values: ReadonlyArray<number | FRAME_MISS>) => number) => {
  switch (mode) {
    case 'max': {
      return (values) => maxFromValues(values)
    }
    case 'sum': {
      return (values) => {
        let sum = 0
        for (const value of values) {
          if (value === FRAME_MISS) continue
          sum += Math.max(value, 0)
        }
        return sum
      }
    }
    case 'avg': {
      return (values) => {
        let sum = 0
        for (const value of values) {
          if (value === FRAME_MISS) continue
          sum += Math.max(value, 0)
        }
        return sum / values.length
      }
    }
    case 'latest': {
      return (values) => {
        const v = values.at(-1)
        return v === undefined || v === FRAME_MISS ? 0 : v
      }
    }
    case 'latest-non-zero': {
      return (values) => {
        for (let i = values.length - 1; i >= 0; i--) {
          const value = values[i]!
          if (value !== FRAME_MISS && value > 0) return value
        }
        return 0
      }
    }
    case 'p-95': {
      return (values) => {
        const sortedValues = values
          .filter((_): _ is number => _ !== FRAME_MISS)
          .sort((a, b) => a - b)
        const index = Math.floor(sortedValues.length * 0.95)
        return sortedValues[index] ?? 0
      }
    }
    case 'sum-last-sec': {
      return (values) => {
        const lowerBound = values.length - numberOfValuesPerSecond - 1
        let sum = 0

        for (let i = values.length - 1; i >= lowerBound; i--) {
          const value = values[i]!
          if (value === FRAME_MISS) continue
          sum += Math.max(value, 0)
        }

        return sum
      }
    }
    default: {
      return casesHandled(mode)
    }
  }
}

const maxFromValues = (values: ReadonlyArray<number | FRAME_MISS>): number => {
  let max = 0
  for (const value of values) {
    if (value === FRAME_MISS) continue
    max = Math.max(max, value)
  }
  return max
}

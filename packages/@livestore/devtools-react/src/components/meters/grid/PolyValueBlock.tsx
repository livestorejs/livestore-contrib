import type { MeterBlock, MeterBlockFn } from './MeterGrid.tsx'
import { FRAME_MISS, PR } from './MeterGrid.tsx'

export const makePolyValueMeterBlock =
  <TRec extends Record<string, number>>({
    getValColor = () => 'rgba(255, 255, 255, 0.3)',
    getTextLines,
    getFrameValue,
    uninitializedValue,
    height,
    width,
  }: {
    getValColor?: (val: number, key: keyof TRec & string) => string
    getTextLines: (rec: ReadonlyArray<TRec | FRAME_MISS>) => string[]
  } & Pick<
    MeterBlock<TRec>,
    'getFrameValue' | 'height' | 'width' | 'uninitializedValue'
  >): MeterBlockFn<TRec> =>
  ({ frameBarWidth }) => {
    const adjustedHeight = height * PR

    return {
      height,
      width,
      getFrameValue,
      uninitializedValue,
      draw: (ctx, originX, originY, values) => {
        const maxValue = maxFromValues(values) * 1.1

        const heightNormalizeFactor = adjustedHeight / maxValue

        for (let i = 0; i < values.length; i++) {
          const rec = values[i]!

          const x = originX + i * frameBarWidth

          if (rec === FRAME_MISS || sumOfRec(rec) <= 0) continue

          let offsetY = 0
          for (const key in rec) {
            const value = rec[key]!
            if (value === 0) continue

            const height = value * heightNormalizeFactor

            ctx.fillStyle = getValColor(value, key)
            ctx.fillRect(x, originY + adjustedHeight - offsetY, frameBarWidth, -height)

            offsetY += height
          }
        }

        ctx.fillStyle = 'white'
        const fontSize = PR * 10
        ctx.font = `${fontSize}px monospace`

        const textLines = getTextLines(values)
        let textOffsetY = 0
        for (let i = 0; i < textLines.length; i++) {
          ctx.fillText(textLines[i]!, originX + 2 * PR, originY + 12 * PR + textOffsetY)
          textOffsetY += 13 * PR
        }
      },
    }
  }

const maxFromValues = (values: ReadonlyArray<Record<string, number> | FRAME_MISS>): number => {
  let max = 0
  for (const value of values) {
    if (value === FRAME_MISS) continue
    max = Math.max(max, sumOfRec(value))
  }
  return max
}

export const sumOfRec = (rec: Record<string, number>): number => {
  let sum = 0
  for (const key in rec) {
    sum += rec[key]!
  }
  return sum
}

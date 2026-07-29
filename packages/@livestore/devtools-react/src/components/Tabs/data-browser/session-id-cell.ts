import * as GDG from '@glideapps/glide-data-grid'
import { Predicate } from '@livestore/utils/effect'

/**
 * Custom GDG cell that shows a "current session" pill next to session-bound IDs.
 */
export type SessionIdCellData = {
  readonly kind: 'session-id-cell'
  readonly text: string
  readonly isCurrentSession: boolean
}

export type SessionIdCell = GDG.CustomCell<SessionIdCellData>

const SESSION_ID_LABEL_TEXT = 'current session'
const SESSION_ID_LABEL_SPACING = 8
const SESSION_ID_LABEL_PADDING_X = 6
const SESSION_ID_LABEL_PADDING_Y = 3
const SESSION_ID_LABEL_RADIUS = 6

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

export const sessionIdBadgeExtraWidth = (theme: Partial<GDG.Theme>): number => {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : undefined
  const ctx = canvas?.getContext('2d')
  const fontSize = theme.baseFontStyle ?? '11px'
  const fontFamily = theme.fontFamily ?? 'Menlo, monospace'
  const fallbackCharWidth = 7

  if (ctx) {
    ctx.font = `${fontSize} ${fontFamily}`.trim()
    return (
      ctx.measureText(SESSION_ID_LABEL_TEXT).width +
      SESSION_ID_LABEL_PADDING_X * 2 +
      SESSION_ID_LABEL_SPACING
    )
  }

  return (
    SESSION_ID_LABEL_TEXT.length * fallbackCharWidth +
    SESSION_ID_LABEL_PADDING_X * 2 +
    SESSION_ID_LABEL_SPACING
  )
}

export const sessionIdCellRenderer: GDG.CustomRenderer<SessionIdCell> = {
  kind: GDG.GridCellKind.Custom,
  isMatch: (cell): cell is SessionIdCell =>
    Predicate.hasProperty(cell.data, 'kind') && cell.data.kind === 'session-id-cell',
  draw: (args, cell) => {
    const { ctx, rect, theme } = args
    const font = `${theme.baseFontStyle ?? '11px'} ${theme.fontFamily ?? ''}`.trim()
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.font = font
    ctx.fillStyle = theme.textDark

    const textX = rect.x + (theme.cellHorizontalPadding ?? 8)
    const textY = rect.y + rect.height / 2 + GDG.getMiddleCenterBias(ctx, theme)
    const textWidth = ctx.measureText(cell.data.text).width
    ctx.fillText(cell.data.text, textX, textY)

    if (cell.data.isCurrentSession) {
      const labelMetrics = ctx.measureText(SESSION_ID_LABEL_TEXT)
      const labelWidth = labelMetrics.width + SESSION_ID_LABEL_PADDING_X * 2
      const labelTextHeight =
        (labelMetrics.actualBoundingBoxAscent ?? 0) + (labelMetrics.actualBoundingBoxDescent ?? 0)
      const parsedFontSize = Number.parseInt(theme.baseFontStyle ?? '11', 10)
      const fallbackFontSize = Number.isNaN(parsedFontSize) ? 11 : parsedFontSize
      const labelHeight = Math.max(
        labelTextHeight + SESSION_ID_LABEL_PADDING_Y * 2,
        fallbackFontSize + SESSION_ID_LABEL_PADDING_Y * 2,
      )
      const labelX = textX + textWidth + SESSION_ID_LABEL_SPACING
      const labelY = rect.y + (rect.height - labelHeight) / 2

      ctx.fillStyle = theme.bgBubbleSelected ?? theme.accentColor
      drawRoundedRect(
        ctx,
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        Math.min(SESSION_ID_LABEL_RADIUS, labelHeight / 2),
      )
      ctx.fill()

      ctx.fillStyle = theme.textBubble ?? theme.textDark
      const labelTextY = labelY + labelHeight / 2 + GDG.getMiddleCenterBias(ctx, theme)
      ctx.fillText(SESSION_ID_LABEL_TEXT, labelX + SESSION_ID_LABEL_PADDING_X, labelTextY)
    }

    ctx.restore()
    return true
  },
  measure: (ctx, cell, theme) => {
    const font = `${theme.baseFontStyle ?? '11px'} ${theme.fontFamily ?? ''}`.trim()
    ctx.save()
    ctx.font = font
    const textWidth = ctx.measureText(cell.data.text).width
    const labelWidth = cell.data.isCurrentSession
      ? ctx.measureText(SESSION_ID_LABEL_TEXT).width +
        SESSION_ID_LABEL_PADDING_X * 2 +
        SESSION_ID_LABEL_SPACING
      : 0
    ctx.restore()
    return textWidth + labelWidth + (theme.cellHorizontalPadding ?? 8) * 2
  },
}

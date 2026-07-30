/* eslint-disable react-perf/jsx-no-new-object-as-prop -- The portalled tooltip position is derived from the current DOM anchor on every opening. */
import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

export interface TooltipDetail {
  readonly label: string
  readonly value: string
}

export interface TooltipContent {
  readonly title: string
  readonly status?: string
  readonly details?: ReadonlyArray<TooltipDetail>
}

export interface TooltipAnchor {
  readonly left: number
  readonly top: number
  readonly width: number
}

const tooltipOpenedEvent = 'livestore-viewer-tooltip-opened'

export const claimTooltip = (id: string): void => {
  window.dispatchEvent(new CustomEvent<string>(tooltipOpenedEvent, { detail: id }))
}

export interface TooltipTriggerProps {
  readonly 'aria-describedby'?: string
  readonly onPointerEnter?: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerLeave?: (event: PointerEvent<HTMLElement>) => void
  readonly onFocus?: (event: FocusEvent<HTMLElement>) => void
  readonly onBlur?: (event: FocusEvent<HTMLElement>) => void
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

export const Tooltip = ({
  children,
  content,
}: {
  readonly children: ReactElement<TooltipTriggerProps>
  readonly content: TooltipContent
}) => {
  const id = useId()
  const [anchor, setAnchor] = useState<TooltipAnchor>()
  const trigger = children.props
  const show = (element: HTMLElement): void => {
    claimTooltip(id)
    setAnchor(tooltipAnchor(element.getBoundingClientRect()))
  }
  useEffect(() => {
    if (anchor === undefined) return
    const closeWhenAnotherTooltipOpens = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail !== id) setAnchor(undefined)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setAnchor(undefined)
    }
    window.addEventListener(tooltipOpenedEvent, closeWhenAnotherTooltipOpens)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener(tooltipOpenedEvent, closeWhenAnotherTooltipOpens)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [anchor, id])

  return (
    <>
      {cloneElement(children, {
        'aria-describedby': id,
        onPointerEnter: (event) => {
          trigger.onPointerEnter?.(event)
          show(event.currentTarget)
        },
        onPointerLeave: (event) => {
          trigger.onPointerLeave?.(event)
          setAnchor(undefined)
        },
        onFocus: (event) => {
          trigger.onFocus?.(event)
          show(event.currentTarget)
        },
        onBlur: (event) => {
          trigger.onBlur?.(event)
          setAnchor(undefined)
        },
        onKeyDown: (event) => {
          trigger.onKeyDown?.(event)
          if (event.key === 'Escape') setAnchor(undefined)
        },
      })}
      <FloatingTooltip id={id} anchor={anchor} content={content} />
    </>
  )
}

export const FloatingTooltip = ({
  anchor,
  content,
  id,
}: {
  readonly anchor?: TooltipAnchor
  readonly content?: TooltipContent
  readonly id?: string
}) => {
  if (anchor === undefined || content === undefined || typeof document === 'undefined') return null
  const horizontalMargin = 16
  const maximumWidth = Math.min(340, window.innerWidth - horizontalMargin * 2)
  const halfWidth = maximumWidth / 2
  const anchorCenter = anchor.left + anchor.width / 2
  const left = Math.min(
    Math.max(anchorCenter, horizontalMargin + halfWidth),
    window.innerWidth - horizontalMargin - halfWidth,
  )

  return createPortal(
    <aside
      id={id}
      role="tooltip"
      className="tooltip"
      style={{ '--tooltip-left': `${left}px`, '--tooltip-top': `${anchor.top - 8}px` } as CSSProperties}
    >
      <header className="tooltip-heading">
        <strong>{content.title}</strong>
        {content.status === undefined ? null : <span>{content.status}</span>}
      </header>
      {content.details === undefined || content.details.length === 0 ? null : (
        <dl className="tooltip-details">
          {content.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>,
    document.body,
  )
}

export const tooltipAnchor = (bounds: Pick<DOMRect, 'left' | 'top' | 'width'>): TooltipAnchor => ({
  left: bounds.left,
  top: bounds.top,
  width: bounds.width,
})

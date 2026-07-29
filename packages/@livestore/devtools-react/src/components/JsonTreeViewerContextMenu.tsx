import React from 'react'
import { Menu, MenuItem, Popover } from 'react-aria-components'

import { cn } from '../utils/cn.ts'

type JsonTreeViewerContextMenuItem = {
  readonly id: string
  readonly label: string
  readonly onAction: () => void
}

/** Context-menu boundary for actions on a rendered JSON tree node. */
export const JsonTreeViewerContextMenu: React.FC<{
  readonly items: ReadonlyArray<JsonTreeViewerContextMenuItem>
  readonly children: React.ReactNode
  readonly isDisabled?: boolean
}> = ({ items, children, isDisabled = false }) => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [position, setPosition] = React.useState<{ x: number; y: number }>()
  const triggerRef = React.useRef<HTMLSpanElement>(null)

  if (isDisabled === true || items.length === 0) {
    return <span className="inline-flex border-0 bg-transparent p-0 text-inherit">{children}</span>
  }

  return (
    <button
      type="button"
      className="inline-flex border-0 bg-transparent p-0 text-inherit"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setPosition({ x: event.clientX, y: event.clientY })
        setIsOpen(true)
      }}
    >
      {children}
      {position === undefined ? null : (
        <>
          <span
            ref={triggerRef}
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: position.x,
              top: position.y,
              width: 1,
              height: 1,
              pointerEvents: 'none',
            }}
          />
          <Popover
            triggerRef={triggerRef}
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            placement="bottom start"
            className="z-50 min-w-[180px] max-w-[280px] rounded-md border border-border bg-surface text-ink shadow-lg outline-none"
          >
            <Menu
              aria-label="JSON value actions"
              items={items}
              onAction={(key) => {
                items.find((item) => item.id === String(key))?.onAction()
                setIsOpen(false)
              }}
              className="p-1 outline-none"
            >
              {(item) => (
                <MenuItem
                  id={item.id}
                  textValue={item.label}
                  className={({ isFocused }) =>
                    cn(
                      'flex items-center rounded px-2 py-1.5 text-sm outline-none',
                      isFocused && 'bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]',
                    )
                  }
                >
                  {item.label}
                </MenuItem>
              )}
            </Menu>
          </Popover>
        </>
      )}
    </button>
  )
}

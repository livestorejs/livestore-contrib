import clsx from 'clsx'
import type React from 'react'
import type { ComponentProps } from 'react'
import * as RAC from 'react-aria-components'

type TableProps = ComponentProps<typeof RAC.Table> & {
  className?: string
}

type ResizableTableContainerProps = ComponentProps<typeof RAC.ResizableTableContainer> & {
  className?: string
}

type ColumnProps = Omit<ComponentProps<typeof RAC.Column>, 'children'> & {
  className?: string
  width?: number | string
  allowsResizing?: boolean
  children?: React.ReactNode
}

type ColumnResizerProps = ComponentProps<typeof RAC.ColumnResizer> & {
  className?: string
}

type RowProps = ComponentProps<typeof RAC.Row> & {
  className?: string
}

type CellProps = ComponentProps<typeof RAC.Cell> & {
  className?: string
}

type TableHeaderProps = ComponentProps<typeof RAC.TableHeader> & {
  className?: string
}

type TableBodyProps = ComponentProps<typeof RAC.TableBody> & {
  className?: string
}

const ResizableTableContainer = ({
  className,
  children,
  ...props
}: ResizableTableContainerProps) => (
  <RAC.ResizableTableContainer className={clsx('w-full overflow-auto', className)} {...props}>
    {children}
  </RAC.ResizableTableContainer>
)

const Table = ({ className, children, ...props }: TableProps) => (
  <RAC.Table
    className={clsx(
      'w-full text-xs',
      'bg-devtools-surface',
      // Add subtle border like GDG tables
      'border border-[#E8EAED] dark:border-[#3C4043]',
      className,
    )}
    {...props}
  >
    {children}
  </RAC.Table>
)

const TableHeader = ({ className, children, ...props }: TableHeaderProps) => (
  <RAC.TableHeader
    className={clsx(
      // Match GDG table header background
      'bg-[#F1F3F4] dark:bg-[#292A2D]',
      'border-b border-[#E8EAED] dark:border-[#3C4043]',
      className,
    )}
    {...props}
  >
    {children}
  </RAC.TableHeader>
)

const ColumnResizer = ({ className, ...props }: ColumnResizerProps) => (
  <RAC.ColumnResizer
    className={clsx(
      'absolute right-0 top-0 h-full w-1',
      'cursor-col-resize',
      'bg-transparent hover:bg-[var(--sys-color-divider)]',
      'touch-none',
      'z-10', // Ensure resizer is above other elements
      'focus:outline-none focus:bg-devtools-focus',
      'resizing:bg-devtools-focus',
      className,
    )}
    {...props}
  />
)

const Column = ({ className, width, allowsResizing, children, style, ...props }: ColumnProps) => {
  return (
    <RAC.Column
      className={clsx(
        'px-2 py-1.5 text-left font-normal',
        // Ensure relative positioning for absolute positioned resizer
        'relative',
        'text-[var(--sys-color-on-surface-secondary)]',
        // Add vertical borders like GDG tables
        'border-r border-[#E8EAED] dark:border-[#3C4043] last:border-r-0',
        // Remove hover for cleaner look like GDG tables
        'focus:outline-none',
        className,
      )}
      // Use defaultWidth for initial size when resizing is enabled
      {...(allowsResizing && width ? { defaultWidth: width } : {})}
      {...(!allowsResizing && width ? { width } : {})}
      {...(style !== undefined ? { style } : {})}
      {...props}
    >
      {typeof children === 'function' ? children : <span>{children}</span>}
      {allowsResizing && <ColumnResizer />}
    </RAC.Column>
  )
}

const TableBody = ({ className, children, ...props }: TableBodyProps) => (
  <RAC.TableBody className={clsx('bg-devtools-surface', className)} {...props}>
    {children}
  </RAC.TableBody>
)

const Row = ({ className, children, ...props }: RowProps) => (
  <RAC.Row
    className={clsx(
      // Minimal row styling - subtle border without hover
      'border-b border-[#E8EAED] dark:border-[#3C4043]',
      'focus:outline-none',
      'data-[selected]:bg-[var(--sys-color-tonal-container)] data-[selected]:text-[var(--sys-color-on-surface)]',
      className,
    )}
    {...props}
  >
    {children}
  </RAC.Row>
)

const Cell = ({ className, children, ...props }: CellProps) => (
  <RAC.Cell
    className={clsx(
      'px-2 py-1.5',
      // Add vertical borders like GDG tables
      'border-r border-[#E8EAED] dark:border-[#3C4043] last:border-r-0',
      'text-[var(--sys-color-on-surface)]',
      'overflow-auto',
      className,
    )}
    {...props}
  >
    {children}
  </RAC.Cell>
)

Table.Container = ResizableTableContainer
Table.Header = TableHeader
Table.Body = TableBody
Table.Column = Column
Table.Row = Row
Table.Cell = Cell
Table.ColumnResizer = ColumnResizer

export { Table }
export type {
  TableProps,
  ResizableTableContainerProps,
  ColumnProps,
  ColumnResizerProps,
  RowProps,
  CellProps,
  TableHeaderProps,
  TableBodyProps,
}

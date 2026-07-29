import clsx from 'clsx'
import type React from 'react'
import type { ComponentProps } from 'react'
import * as RAC from 'react-aria-components'

type TabsProps = ComponentProps<typeof RAC.Tabs> & {
  className?: string
}

type TabListProps = ComponentProps<typeof RAC.TabList> & {
  className?: string
}

type TabProps = Omit<ComponentProps<typeof RAC.Tab>, 'children'> & {
  className?: string
  icon?: React.ReactElement
  children?: React.ReactNode
}

type TabPanelProps = ComponentProps<typeof RAC.TabPanel> & {
  className?: string
}

const Tabs = ({ className, children, ...props }: TabsProps) => (
  <RAC.Tabs className={clsx('flex flex-col h-full', className)} {...props}>
    {children}
  </RAC.Tabs>
)

const TabList = ({ className, children, ...props }: TabListProps) => (
  <RAC.TabList
    className={clsx(
      'flex',
      // Exact DevTools styling from tabbedPane.css
      'h-[27px]', // Exact height from DevTools
      'bg-[var(--sys-color-cdt-base-container)]',
      'border-b border-devtools-divider',
      'relative',
      'overflow-hidden',
      className,
    )}
    {...props}
  >
    {children}
  </RAC.TabList>
)

const Tab = ({ className, icon, children, ...props }: TabProps) => (
  <RAC.Tab
    className={clsx(
      // Base styling matching DevTools .tabbed-pane-header-tab
      'relative flex items-center',
      'px-[10px]', // Exact padding from DevTools
      'h-[27px]', // Match container height
      'whitespace-nowrap',
      'cursor-default',
      // Typography matching DevTools body4-medium
      'text-[12px] font-medium leading-4',
      'text-[var(--sys-color-on-surface-secondary)]', // Default tab color (subtle)
      // Hover state
      'hover:bg-[var(--sys-color-state-hover-on-subtle)]',
      'hover:text-[var(--sys-color-on-surface)]',
      // Selected state - primary color with bottom indicator like Chrome DevTools
      'data-[selected]:text-[var(--sys-color-primary)]',
      'data-[selected]:bg-transparent',
      // Add bottom border indicator for selected tab using ::after pseudo-element
      'data-[selected]:after:content-[""]',
      'data-[selected]:after:absolute',
      'data-[selected]:after:bottom-[-0px]',
      'data-[selected]:after:left-0',
      'data-[selected]:after:right-0',
      'data-[selected]:after:h-[3px]',
      'data-[selected]:after:bg-[var(--sys-color-primary)]',
      'data-[selected]:after:rounded-full',
      // Focus state - remove outline like Chrome DevTools
      'focus:outline-none',
      className,
    )}
    {...props}
  >
    {icon && <span className="w-4 h-4 flex items-center justify-center mr-1.5">{icon}</span>}
    {children}
  </RAC.Tab>
)

const TabPanel = ({ className, children, ...props }: TabPanelProps) => (
  <RAC.TabPanel
    className={clsx(
      'flex-1 overflow-hidden',
      'p-0', // Let child components handle their own padding
      className,
    )}
    {...props}
  >
    {children}
  </RAC.TabPanel>
)

Tabs.List = TabList
Tabs.Tab = Tab
Tabs.Panel = TabPanel

export { Tabs }
export type { TabsProps, TabListProps, TabProps, TabPanelProps }

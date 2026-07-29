import type React from 'react'

import { cn } from '../../../utils/cn.ts'

export type SidebarItem = {
  name: string
  isSelected: boolean
  onClick: () => void
}

type SidebarSectionProps = {
  title: string
  children: React.ReactNode
  collapsible?: boolean
  isExpanded?: boolean
  onToggle?: () => void
}

const SidebarSection: React.FC<SidebarSectionProps> = ({
  title,
  children,
  collapsible = false,
  isExpanded = true,
  onToggle,
}) => {
  return (
    <div className="border-b border-devtools-divider last:border-b-0">
      <button
        type="button"
        className={cn(
          'text-xs font-semibold text-devtools-text px-3 py-3 w-full text-left flex items-center justify-between',
          collapsible ? 'hover:bg-devtools-surface cursor-pointer' : 'cursor-default',
        )}
        onClick={collapsible ? onToggle : undefined}
        disabled={!collapsible}
      >
        <span>{title}</span>
        {collapsible && (
          <span className="text-devtools-text-secondary">{isExpanded ? '−' : '+'}</span>
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3">
          <div className="space-y-px">{children}</div>
        </div>
      )}
    </div>
  )
}

type SidebarProps = {
  tableItems: ReadonlyArray<SidebarItem>
  clientDocumentItems: ReadonlyArray<SidebarItem>
  livestoreItems: ReadonlyArray<SidebarItem>
  sqlitePlaygroundItem: SidebarItem
  livestoreInternalsExpanded: boolean
  onToggleLivestoreInternals: () => void
}

/**
 * Sidebar navigation for the Data Browser sections.
 */
export const DataBrowserSidebar: React.FC<SidebarProps> = ({
  tableItems,
  clientDocumentItems,
  livestoreItems,
  sqlitePlaygroundItem,
  livestoreInternalsExpanded,
  onToggleLivestoreInternals,
}) => {
  return (
    <div className="h-full w-[220px] shrink-0 overflow-auto">
      {tableItems.length > 0 && (
        <SidebarSection title="Tables">
          {tableItems.map((item) => (
            <button
              type="button"
              key={item.name}
              className={cn(
                'text-xs text-nowrap cursor-default py-px px-1 rounded-sm w-full text-left',
                item.isSelected
                  ? 'bg-devtools-bar-selected text-white'
                  : 'text-devtools-text-secondary hover:text-devtools-text',
              )}
              onClick={item.onClick}
            >
              {item.name}
            </button>
          ))}
        </SidebarSection>
      )}

      {clientDocumentItems.length > 0 && (
        <SidebarSection title="Client Documents">
          {clientDocumentItems.map((item) => (
            <button
              type="button"
              key={item.name}
              className={cn(
                'text-xs text-nowrap cursor-default py-px px-1 rounded-sm w-full text-left',
                item.isSelected
                  ? 'bg-devtools-bar-selected text-white'
                  : 'text-devtools-text-secondary hover:text-devtools-text',
              )}
              onClick={item.onClick}
            >
              {item.name}
            </button>
          ))}
        </SidebarSection>
      )}

      <SidebarSection title="SQLite">
        <button
          type="button"
          className={cn(
            'text-xs text-nowrap cursor-default py-px px-1 rounded-sm w-full text-left',
            sqlitePlaygroundItem.isSelected
              ? 'bg-devtools-bar-selected text-white'
              : 'text-devtools-text-secondary hover:text-devtools-text',
          )}
          onClick={sqlitePlaygroundItem.onClick}
        >
          {sqlitePlaygroundItem.name}
        </button>
      </SidebarSection>

      <SidebarSection
        title="LiveStore internals"
        collapsible={true}
        isExpanded={livestoreInternalsExpanded}
        onToggle={onToggleLivestoreInternals}
      >
        {livestoreItems.map((item) => (
          <button
            type="button"
            key={item.name}
            className={cn(
              'text-xs text-nowrap cursor-default py-px px-1 rounded-sm w-full text-left',
              item.isSelected
                ? 'bg-devtools-bar-selected text-white'
                : 'text-devtools-text-secondary hover:text-devtools-text',
            )}
            onClick={item.onClick}
          >
            {item.name}
          </button>
        ))}
      </SidebarSection>
    </div>
  )
}

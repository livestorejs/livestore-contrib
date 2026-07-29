import type React from 'react'
import * as RAC from 'react-aria-components'

import { useTheme } from '../theme/mod.js'
import { cn } from '../utils/cn.ts'

export const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useTheme()

  const options = [
    { value: 'light' as const, label: 'Light' },
    { value: 'dark' as const, label: 'Dark' },
    { value: 'system' as const, label: 'System' },
  ]

  const selectedOption = options.find((option) => option.value === theme) ?? options[0]!

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-devtools-text">Theme</span>
      <RAC.Select
        selectedKey={theme}
        onSelectionChange={(key) => setTheme(key as typeof theme)}
        className="min-w-[80px]"
      >
        <RAC.Button
          className={cn(
            'flex items-center justify-between px-2 py-1 text-xs',
            'bg-devtools-surface text-devtools-text border border-devtools-border rounded-sm',
            'hover:bg-devtools-background-hover focus:outline-none focus:ring-1 focus:ring-devtools-focus',
            'data-[pressed]:bg-devtools-background-hover',
          )}
        >
          <span className="flex items-center">{selectedOption.label}</span>
          <span className="ml-1 text-[10px] text-devtools-text-secondary">▼</span>
        </RAC.Button>
        <RAC.Popover
          className={cn(
            'bg-devtools-surface border border-devtools-border rounded-sm shadow-lg',
            'min-w-[var(--trigger-width)] mt-1 z-50',
          )}
        >
          <RAC.ListBox className="py-1">
            {options.map((option) => (
              <RAC.ListBoxItem
                key={option.value}
                id={option.value}
                className={cn(
                  'flex items-center px-2 py-1 text-xs cursor-pointer',
                  'hover:bg-devtools-background-hover focus:bg-devtools-background-hover',
                  'focus:outline-none data-[selected]:bg-devtools-bar-selected data-[selected]:text-white',
                )}
              >
                {option.label}
                {theme === option.value && <span className="ml-auto text-[10px]">✓</span>}
              </RAC.ListBoxItem>
            ))}
          </RAC.ListBox>
        </RAC.Popover>
      </RAC.Select>
    </div>
  )
}

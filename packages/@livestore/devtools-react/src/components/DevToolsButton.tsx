import type React from 'react'

import { cn } from '../utils/cn.ts'

interface TDevToolsButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger'
  size?: 'sm' | 'xs'
  children: React.ReactNode
}

export const DevToolsButton: React.FC<TDevToolsButtonProps> = ({
  variant = 'default',
  size = 'sm',
  className,
  children,
  ...props
}) => {
  return (
    <button
      className={cn(
        // Base styles
        'inline-flex items-center justify-center border rounded-sm font-medium transition-colors',
        'focus:outline-none focus:ring-1 focus:ring-devtools-focus',
        'disabled:opacity-50 disabled:pointer-events-none',

        // Size variants
        size === 'xs' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-xs',

        // Color variants
        variant === 'default' && [
          'bg-devtools-surface text-devtools-text border-devtools-border',
          'hover:bg-devtools-background-hover',
        ],
        variant === 'primary' && [
          'bg-devtools-bar-selected text-white border-devtools-bar-selected',
          'hover:opacity-90',
        ],
        variant === 'danger' && [
          'bg-red-600 text-white border-red-600',
          'hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800',
        ],

        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

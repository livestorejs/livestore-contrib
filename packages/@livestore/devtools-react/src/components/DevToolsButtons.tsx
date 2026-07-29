import type React from 'react'
import type { PressEvent } from 'react-aria-components'
import { Button } from 'react-aria-components'

import { cn } from '../utils/cn.ts'

export const ButtonSm: React.FC<
  React.PropsWithChildren<{ onClick?: (event: PressEvent) => void; className?: string }>
> = ({ onClick, className, children }) => (
  <Button
    className={cn(
      'rounded border border-neutral-700 bg-neutral-900 text-sm px-2 py-1 hover:bg-neutral-800',
      className,
    )}
    {...(onClick !== undefined ? { onPress: onClick } : {})}
  >
    {children}
  </Button>
)

export const ButtonXs: React.FC<
  React.PropsWithChildren<{ onClick?: (event: PressEvent) => void; className?: string }>
> = ({ onClick, className, children }) => (
  <Button
    className={cn(
      'rounded-sm border border-neutral-700 bg-neutral-900 px-1 text-[10px] py-px hover:bg-neutral-800',
      className,
    )}
    {...(onClick !== undefined ? { onPress: onClick } : {})}
  >
    {children}
  </Button>
)

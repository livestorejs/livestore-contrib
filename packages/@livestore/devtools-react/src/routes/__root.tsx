import { createRootRoute, Outlet } from '@tanstack/react-router'
import type * as React from 'react'

const RootComponent: React.FC = () => {
  return <Outlet />
}

export const Route = createRootRoute({
  component: RootComponent,
})

import { createFileRoute, Link } from '@tanstack/react-router'
import type * as React from 'react'

const RouteComponent: React.FC = () => {
  const modes = ['web', 'node', 'browser-extension']

  return (
    <div className="p-3 text-sm">
      Devtools Modes:
      <ul className="list-disc pl-5">
        {modes.map((mode) => (
          <li key={mode}>
            <Link to={`/${mode}`}>{mode}</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

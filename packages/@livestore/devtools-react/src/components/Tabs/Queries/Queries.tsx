import { SessionIdSymbol } from '@livestore/livestore'
import type React from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { useDevtoolsStore } from '../../../devtools-store-context.js'
import { stateSchemaQueriesTab } from '../../../livestore/tables.js'
import { ErrorFallback } from '../../ErrorFallback.js'
import { Tabs } from '../../Tabs.js'
import { DagNodes } from './DagNodes.js'
import { LiveQueries } from './LiveQueries.js'
import { SlowQueries } from './SlowQueries.js'

type Tab = {
  label: string
  component: React.FC
}

const tabs: Tab[] = [
  { label: 'Live Queries', component: LiveQueries },
  { label: 'Slow Queries', component: SlowQueries },
  { label: 'Reactivity Graph', component: DagNodes },
]

export const Queries: React.FC = () => {
  const store = useDevtoolsStore()
  const [state, setState] = store.useClientDocument(stateSchemaQueriesTab, SessionIdSymbol)

  const selectedKey: string | null =
    tabs.length > 0 ? (tabs[state.tabIndex]?.label ?? tabs[0]!.label) : null

  const handleSelectionChange = (key: React.Key) => {
    const index = tabs.findIndex((tab) => tab.label === key)
    if (index !== -1) {
      setState({ tabIndex: index })
    }
  }

  return (
    <Tabs
      className="h-full"
      {...(selectedKey !== null ? { selectedKey } : {})}
      onSelectionChange={handleSelectionChange}
    >
      <Tabs.List>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.label} id={tab.label}>
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>

      {tabs.map((tab) => (
        <Tabs.Panel key={tab.label} id={tab.label}>
          <ErrorBoundary FallbackComponent={ErrorFallback}>
            <tab.component />
          </ErrorBoundary>
        </Tabs.Panel>
      ))}
    </Tabs>
  )
}

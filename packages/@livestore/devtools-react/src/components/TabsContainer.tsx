import { StoreInternalsSymbol } from '@livestore/livestore'
import { Effect, Stream, SubscriptionRef } from '@livestore/utils/effect'
import React from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { useDevtoolsStore } from '../devtools-store-context.js'
import { stateSchemaTabsContainer } from '../livestore/tables.js'
import { ClientSessionDropdown } from './ClientSessionList.js'
import { ConfirmModalProvider } from './ConfirmModalContext.js'
import { ErrorFallback } from './ErrorFallback.js'
import { Icons } from './Icons/mod.js'
import { Meters } from './Meters.js'
import { Tabs } from './Tabs.js'

export type Tab = {
  label: string
  component: React.FC
  icon?: React.ReactElement
}

export const TabsContainer = ({ tabs }: { tabs: Tab[] }) => {
  const store = useDevtoolsStore()
  const [state, setState] = store.useClientDocument(stateSchemaTabsContainer, store.sessionId)

  const [isDevtoolsLeader, setIsDevtoolsLeader] = React.useState(
    () =>
      SubscriptionRef.get(store[StoreInternalsSymbol].clientSession.lockStatus).pipe(
        Effect.runSync,
      ) === 'has-lock',
  )

  React.useEffect(() => {
    if (import.meta.env.DEV !== true) return
    return SubscriptionRef.changes(store[StoreInternalsSymbol].clientSession.lockStatus).pipe(
      Stream.tapSync((_) => setIsDevtoolsLeader(_ === 'has-lock')),
      Stream.runDrain,
      Effect.runCallback,
    )
  }, [store])

  const selectedKey: string | null =
    tabs.length > 0 ? (tabs[state.tabIndex]?.label ?? tabs[0]!.label) : null

  const handleSelectionChange = (key: React.Key) => {
    const index = tabs.findIndex((tab) => tab.label === key)
    if (index !== -1) {
      setState({ tabIndex: index })
    }
  }

  return (
    <ConfirmModalProvider>
      <div className="h-full flex flex-col relative">
        {/* Meters and leader indicator */}
        <div
          role="application"
          className="absolute top-0 right-0 z-10 hidden md:block"
          onClick={() => setState({ showMeters: !state.showMeters })}
        >
          {state.showMeters ? (
            <Meters />
          ) : (
            <Icons.ChartLine className="w-4 h-4 m-1 text-devtools-text-secondary" />
          )}
        </div>
        {/* TODO use proper env var + make reactive */}
        {import.meta.env.DEV && isDevtoolsLeader && (
          <div className="absolute left-1 bottom-1 w-1 h-1 bg-red-600 rounded-full z-10" />
        )}

        <Tabs
          {...(selectedKey !== null ? { selectedKey } : {})}
          onSelectionChange={handleSelectionChange}
          className="h-full"
        >
          {/* Custom tab list with controls */}
          {/* <div className="px-2">
              <ClientSessionDropdown />
            </div> */}

          <Tabs.List className="">
            {/*
             * NOTE we've temporarily moved the dropdown into the tab list as it seems otherwise RAC is throwing an error
             * `Cannot read properties of null (reading 'selectionManager')`
             * Probably a bug in RAC, but we'll fix it later.
             */}
            <Tabs.Tab isDisabled>
              <ClientSessionDropdown />
            </Tabs.Tab>
            {tabs.map((tab) => (
              <Tabs.Tab
                key={tab.label}
                id={tab.label}
                {...(tab.icon !== undefined ? { icon: tab.icon } : {})}
              >
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {/* Tab panels */}
          {tabs.map((tab) => (
            <Tabs.Panel key={tab.label} id={tab.label}>
              <ErrorBoundary FallbackComponent={ErrorFallback}>
                <tab.component />
              </ErrorBoundary>
            </Tabs.Panel>
          ))}
        </Tabs>
      </div>
    </ConfirmModalProvider>
  )
}

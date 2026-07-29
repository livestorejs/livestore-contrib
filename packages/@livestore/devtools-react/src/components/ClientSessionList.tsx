import type { Devtools } from '@livestore/common'
import { Effect, HashSet, Stream } from '@livestore/utils/effect'
import { Link, useRouter } from '@tanstack/react-router'
import React from 'react'
import * as RAC from 'react-aria-components'

import { useApiContext } from '../api-context.js'
import { useSessionContext } from '../session-context.js'
import { cn } from '../utils/cn.ts'

export const ClientSessionDropdown = () => {
  const clientSessions = useClientSessions()
  const { apiSession } = useSessionContext()
  const { selectedModeTag } = useApiContext()
  const router = useRouter()

  return (
    <RAC.Select
      className="max-w-[180px] relative"
      selectedKey={sessionToKey(apiSession.clientInfo)}
      placeholder="Select a client session"
      aria-label="Client session selector"
      onSelectionChange={(key) => {
        const clientSession = clientSessions.find(
          (clientSession) => sessionToKey(clientSession) === key,
        )
        if (clientSession) {
          router.navigate({
            to: `/${selectedModeTag}/${clientSession.storeId}/${clientSession.clientId}/${clientSession.sessionId}/${clientSession.schemaAlias}`,
          })
        }
      }}
    >
      <div className="flex items-center justify-between">
        <RAC.Button
          className={cn(
            'flex items-center justify-between w-full px-2 py-1 text-xs rounded-sm',
            'text-devtools-text',
            'hover:bg-devtools-background-hover focus:outline-none focus:ring-1 focus:ring-devtools-focus',
            'data-[pressed]:bg-devtools-background-hover',
          )}
        >
          <RAC.SelectValue className="truncate font-mono" />
          <span aria-hidden="true" className="text-devtools-text-secondary ml-1 text-[10px]">
            ▼
          </span>
        </RAC.Button>
      </div>
      <RAC.Popover
        className={cn(
          'bg-devtools-surface border border-devtools-border rounded-sm shadow-lg',
          'min-w-[var(--trigger-width)] mt-1 z-50',
        )}
      >
        <RAC.ListBox className="max-h-[200px] overflow-y-auto py-1" items={clientSessions}>
          {(clientSession) => (
            <RAC.ListBoxItem
              // key={sessionToKey(clientSession)}
              id={sessionToKey(clientSession)}
              className={cn(
                'px-2 py-1 text-xs cursor-default font-mono',
                'hover:bg-devtools-background-hover focus:bg-devtools-background-hover',
                'focus:outline-none data-[selected]:bg-devtools-bar-selected data-[selected]:text-white',
              )}
              aria-label={sessionToLabel(clientSession)}
            >
              {sessionToLabel(clientSession)}
            </RAC.ListBoxItem>
          )}
        </RAC.ListBox>
      </RAC.Popover>
    </RAC.Select>
  )
}

const sessionToKey = (session: Devtools.SessionInfo.SessionInfo) =>
  `${session.storeId}-${session.clientId}-${session.sessionId}-${session.schemaAlias}-${session.isLeader}`

const sessionToLabel = (session: Devtools.SessionInfo.SessionInfo) =>
  `${session.storeId}:${session.clientId}:${session.sessionId}:${session.schemaAlias}`

export const ClientSessionList: React.FC = () => {
  const { selectedModeTag } = useApiContext()
  const clientSessions = useClientSessions()

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="font-semibold">Sessions ({clientSessions.length})</div>
      <div className="flex flex-col gap-1">
        {clientSessions.map((clientSession) => (
          <Link
            key={`${clientSession.storeId}-${clientSession.clientId}-${clientSession.sessionId}-${clientSession.schemaAlias}`}
            to={`/${selectedModeTag}/${clientSession.storeId}/${clientSession.clientId}/${clientSession.sessionId}/${clientSession.schemaAlias}`}
          >
            {clientSession.storeId}: {clientSession.clientId}:{clientSession.sessionId} (
            {clientSession.schemaAlias})
          </Link>
        ))}
      </div>
    </div>
  )
}

export const useClientSessions = () => {
  const { api } = useApiContext()
  const [clientSessions, setClientSessions] = React.useState<
    HashSet.HashSet<Devtools.SessionInfo.SessionInfo>
  >(HashSet.empty())

  React.useEffect(
    () =>
      Effect.gen(function* () {
        const initialSessions = yield* api.clientSessions
        setClientSessions(initialSessions)

        yield* api.clientSessions.changes.pipe(
          Stream.tapSync((sessions) => setClientSessions(sessions)),
          Stream.runDrain,
        )
      }).pipe(Effect.tapCauseLogPretty, Effect.runCallback),
    [api],
  )

  const clientSessionsArray = React.useMemo(() => Array.from(clientSessions), [clientSessions])

  return clientSessionsArray
}

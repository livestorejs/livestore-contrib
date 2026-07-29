import { Schema } from '@livestore/utils/effect'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import * as React from 'react'

import { useApiContext } from '../api-context.js'
import { ClientSessionList, useClientSessions } from '../components/ClientSessionList.js'

const RouteComponent: React.FC = () => {
  const search = Route.useSearch()
  const clientSessions = useClientSessions()
  const { selectedModeTag } = useApiContext()
  const router = useRouter()

  React.useEffect(() => {
    if (search.autoconnect !== undefined && clientSessions.length > 0) {
      const clientSession = clientSessions[0]!
      router.navigate({
        to: `/${selectedModeTag}/${clientSession.storeId}/${clientSession.clientId}/${clientSession.sessionId}/${clientSession.schemaAlias}`,
      })
    }
  }, [search.autoconnect, router, clientSessions, selectedModeTag])

  return (
    <div className="p-3">
      <ClientSessionList />
    </div>
  )
}

export const Route = createFileRoute('/$mode/')({
  component: RouteComponent,
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      autoconnect: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
    }),
  ),
})

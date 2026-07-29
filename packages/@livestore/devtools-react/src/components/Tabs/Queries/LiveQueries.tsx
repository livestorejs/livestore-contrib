import type { Devtools } from '@livestore/common'
// import * as LiveStoreReact from '@livestore/react'
import { Effect, Schema, Stream } from '@livestore/utils/effect'
import React from 'react'

import { useSessionContext } from '../../../session-context.js'
import { JsonTreeViewer } from '../../JsonTreeViewer.js'
import { Table } from '../../Table.js'
// import { stateSchemaLiveQueriesTab } from '../../tables.js'

export const LiveQueries: React.FC = () => {
  // const [queriesChanged, forceQueriesChanged] = React.useState([])

  // const [{ autoRefresh: _autoRefresh }, setState] = LiveStoreReact.useClientDocument(stateSchemaLiveQueriesTab)

  const [allQueries, setAllQueries] = React.useState<
    ReadonlyArray<typeof Devtools.ClientSession.SerializedLiveQuery.Type>
  >([])
  const { apiSession } = useSessionContext()
  React.useEffect(
    () =>
      apiSession.liveQueries().pipe(
        Stream.tapSync((_) => setAllQueries(_)),
        Stream.runDrain,
        Effect.tapCauseLogPretty,
        Effect.runCallback,
      ),
    [apiSession],
  )

  const queries = React.useMemo(
    () =>
      allQueries
        // TODO get rid of this filter once we don't create empty component state JS queries in the first place
        .filter((q) => q.label !== 'empty-component-state')
        .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
    [allQueries],
  )

  return (
    <div className="space-y-1 h-full flex flex-col">
      <div className="flex space-x-2 items-center text-xs p-2">
        <span className="font-semibold text-devtools-text">{queries.length} live queries</span>
        {/* <DevUi.ButtonXs className="bg-white rounded" onClick={() => forceQueriesChanged([])}>
          Force Refresh
        </DevUi.ButtonXs> */}
        {/* <label className="flex items-center space-x-1">
          <input
            type="checkbox"
            className=""
            checked={autoRefresh}
            onChange={(e) => setState.autoRefresh(e.target.checked)}
          />
          <span>Auto refresh</span>
        </label> */}
      </div>
      <div className="flex-grow h-full overflow-y-auto text-xs">
        <Table.Container>
          <Table>
            <Table.Header>
              <Table.Column width={30} allowsResizing>
                #
              </Table.Column>
              <Table.Column width={40} allowsResizing>
                Type
              </Table.Column>
              <Table.Column width={40} allowsResizing>
                Runs
              </Table.Column>
              <Table.Column width={180} allowsResizing>
                Duration (in ms)
              </Table.Column>
              <Table.Column allowsResizing>Subscribers</Table.Column>
              <Table.Column allowsResizing>Result</Table.Column>
              <Table.Column allowsResizing>Label</Table.Column>
              <Table.Column width={100} allowsResizing>
                Hash
              </Table.Column>
            </Table.Header>
            <Table.Body className="bg-devtools-surface">
              {queries.map((query, index) => (
                <Table.Row key={query.id}>
                  <Table.Cell>{index + 1}</Table.Cell>
                  <Table.Cell>{query._tag}</Table.Cell>
                  <Table.Cell>{query.runs}</Table.Cell>
                  <Table.Cell className="overflow-auto">
                    {/* <DocumentTree
                    key={query.runs}
                    schema={Schema.Array(Schema.Number)}
                    document={query.executionTimes}
                    // expandLevel={1}
                    // includePrototypes={false}
                  /> */}
                    {query.executionTimes.slice(-10).join(', ')}
                  </Table.Cell>
                  <Table.Cell>
                    count: {query.activeSubscriptions.length}
                    {import.meta.env.DEV && (
                      <ul>
                        {query.activeSubscriptions.slice(0, 20).map((s, subscriptionIndex) => (
                          <li key={subscriptionIndex} className="space-x-2">
                            {s.frames.map((_, frameIndex) => (
                              <a
                                key={_.filePath + frameIndex}
                                href={_.filePath}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {_.name}
                              </a>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Table.Cell>
                  <Table.Cell className="overflow-auto">
                    <div className="overflow-auto max-w-48">
                      <JsonTreeViewer
                        data={formatForViewer(query.lastestResult) as unknown}
                        schema={Schema.Json}
                        initiallyExpandedDepth={1}
                        hideRoot={true}
                      />
                    </div>
                  </Table.Cell>
                  <Table.Cell>{query.label}</Table.Cell>
                  <Table.Cell>{query.hash}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Table.Container>
      </div>
    </div>
  )
}

const CHUNK_SIZE = 100

const formatForViewer = (value: unknown): unknown => {
  if (Array.isArray(value) && value.length > CHUNK_SIZE) {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, value.length)
      out[`${i}…${end - 1} (${end - i})`] = value.slice(i, end)
    }
    return out
  }
  return value
}

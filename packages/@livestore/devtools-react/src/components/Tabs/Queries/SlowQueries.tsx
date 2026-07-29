import type { Bindable, DebugInfo, PreparedBindValues } from '@livestore/common'
import { PreparedBindValues as PreparedBindValuesSchema } from '@livestore/common'
import { Effect } from '@livestore/utils/effect'
import React from 'react'

import { useFormatSql } from '../../../hooks/useFormatSql.js'
import { useTick } from '../../../hooks/useTick.js'
import { useSessionContext } from '../../../session-context.js'
import { DevToolsButton } from '../../DevToolsButton.js'
import { JsonTreeViewer } from '../../JsonTreeViewer.js'
import { Table } from '../../Table.js'

export const SlowQueries: React.FC = () => {
  const queryInfos = useQueryInfos()

  const { apiSession } = useSessionContext()

  return (
    <div className="space-y-2 h-full flex flex-col">
      <div className="space-x-2 p-2 text-sm flex items-center">
        <div className="text-sm text-devtools-text">Slow Queries ({queryInfos.length})</div>
        <DevToolsButton
          size="xs"
          onClick={() =>
            apiSession.debugInfoReset.pipe(Effect.tapCauseLogPretty, Effect.runPromise)
          }
        >
          Reset Slow Queries
        </DevToolsButton>
      </div>
      <div className="flex-grow h-full overflow-y-auto text-xs">
        <Table.Container>
          <Table>
            <Table.Header>
              <Table.Column width={160} allowsResizing>
                Duration
              </Table.Column>
              <Table.Column width={100} allowsResizing>
                When
              </Table.Column>
              <Table.Column width={240} allowsResizing>
                Bind Values
              </Table.Column>
              <Table.Column width={80} allowsResizing>
                Result count
              </Table.Column>
              <Table.Column width={180} allowsResizing>
                Controls
              </Table.Column>
              <Table.Column allowsResizing>Query</Table.Column>
            </Table.Header>
            <Table.Body className="bg-devtools-surface text-xs">
              {queryInfos.map((queryInfo) =>
                queryInfo.runInfos.map((runInfo, index) => (
                  <Table.Row
                    key={index}
                    className={
                      index === queryInfo.runInfos.length - 1
                        ? 'border-b border-devtools-divider'
                        : ''
                    }
                  >
                    <Table.Cell>{runInfo.durationMs}ms</Table.Cell>
                    <Table.Cell>{runInfo.relativeTimeStr}</Table.Cell>
                    <Table.Cell>
                      {Object.keys(runInfo.bindValues).length === 0 ? (
                        '-'
                      ) : (
                        <div className="overflow-auto max-w-48">
                          <JsonTreeViewer
                            data={runInfo.bindValues as unknown}
                            schema={PreparedBindValuesSchema}
                            initiallyExpandedDepth={1}
                            hideRoot={true}
                          />
                        </div>
                      )}
                    </Table.Cell>
                    <Table.Cell>{runInfo.resultCount}</Table.Cell>
                    <Table.Cell>
                      <div className="flex gap-1">
                        <DevToolsButton
                          size="xs"
                          onClick={() =>
                            copyToClipboard(
                              inlineQueryBindValues(queryInfo.query, runInfo.bindValues),
                            )
                          }
                        >
                          Copy
                        </DevToolsButton>
                        <DevToolsButton
                          size="xs"
                          onClick={() =>
                            apiSession
                              .debugInfoRerunQuery({
                                queryStr: queryInfo.query,
                                bindValues: runInfo.bindValues,
                                queriedTables: queryInfo.queriedTables,
                              })
                              .pipe(Effect.tapCauseLogPretty, Effect.runPromise)
                          }
                        >
                          Re-run
                        </DevToolsButton>
                      </div>
                    </Table.Cell>
                    {index === 0 && (
                      <Table.Cell>
                        <pre className="overflow-auto rounded-md bg-devtools-surface/50 p-1 font-mono text-xs text-devtools-text">
                          {queryInfo.query.trim()}
                        </pre>
                      </Table.Cell>
                    )}
                  </Table.Row>
                )),
              )}
            </Table.Body>
          </Table>
        </Table.Container>
      </div>
      {/* <div className="divide-y divide-neutral-600">
        {queryInfos.map((queryInfo) => (
          <QueryElement key={queryInfo.query} queryInfo={queryInfo} runQuery={runQuery} />
        ))}
      </div> */}
    </div>
  )
}

/** Replaces `?` with the positional `bindValues` */
const inlineQueryBindValues = (query: string, bindValues: Bindable): string => {
  let index = 0
  // eslint-disable-next-line unicorn/prefer-string-replace-all
  return query.replace(/\?/g, () => {
    const value = (bindValues as any[])[index++]
    return typeof value === 'string' ? `'${value}'` : JSON.stringify(value)
  })
}

const copyToClipboard = (text: string) => {
  // NOTE since `window` isn't properly handled with `NewWindowPortal`, we need to use `tmpChildWindow` instead
  const navigator: Navigator = window.tmpChildWindow?.navigator ?? window.navigator
  void navigator.clipboard.writeText(text)
}

type QueryInfo = {
  query: string
  /** Ordered by durationMs (slow first) */
  runInfos: QueryRunInfo[]
  queriedTables: ReadonlySet<string>
  p95: number
}

type QueryRunInfo = {
  bindValues: PreparedBindValues
  durationMs: number
  resultCount?: number
  relativeTimeStr: string
  relativeTimeSec: number
}

// const roundToTwo = (seqNum: number) => Math.round((num + Number.EPSILON) * 100) / 100

const useQueryInfos = () => {
  const formatSql = useFormatSql()
  const [queryInfos, setQueryInfos] = React.useState<QueryInfo[]>([])

  const _tick = useTick(10_000, true)
  const { apiSession } = useSessionContext()

  React.useEffect(() => {
    let lastSlowQueryCount = 0

    apiSession.debugInfo.pipe(Effect.tapCauseLogPretty, Effect.runPromise).then((debugInfo) => {
      setQueryInfos(getQueryInfos(debugInfo, formatSql))
    })

    const interval = setInterval(() => {
      apiSession.debugInfo.pipe(Effect.tapCauseLogPretty, Effect.runPromise).then((debugInfo) => {
        const slowQueryCount = debugInfo.slowQueries.length
        if (slowQueryCount === lastSlowQueryCount) return

        lastSlowQueryCount = slowQueryCount

        setQueryInfos(getQueryInfos(debugInfo, formatSql))
      })
    }, 200)

    return () => clearInterval(interval)
  }, [apiSession, formatSql])

  return queryInfos
}

const getQueryInfos = (debugInfo: DebugInfo, formatSql: (_: string) => string): QueryInfo[] => {
  try {
    const unsortedQueries = debugInfo.slowQueries
    const queries = unsortedQueries.sort((a, b) => b.durationMs - a.durationMs)
    const queryMap = new Map<string, QueryInfo>()
    const performanceNow = performance.now()

    const rtf = new Intl.RelativeTimeFormat('en', { style: 'narrow' })

    for (const {
      queryStr,
      bindValues: bindValues_,
      durationMs,
      rowsCount: resultCount,
      queriedTables,
      startTimePerfNow: startTimePerf,
    } of queries) {
      const formattedQuery = formatSql(queryStr)
      const query =
        queryMap.get(formattedQuery) ??
        ({ query: formattedQuery, runInfos: [], p95: 0, queriedTables } satisfies QueryInfo)

      const timeDifferenceSec = Math.round((startTimePerf - performanceNow) / 1000)

      query.runInfos.push({
        bindValues: bindValues_ ?? ([] as unknown as PreparedBindValues),
        durationMs,
        ...(resultCount !== undefined ? { resultCount } : {}),
        relativeTimeStr: rtf.format(timeDifferenceSec, 'seconds'),
        relativeTimeSec: -timeDifferenceSec,
      })

      queryMap.set(formattedQuery, query)
    }

    return Array.from(queryMap.values()).map((query) => ({
      query: query.query,
      runInfos: query.runInfos
        .slice()
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 20),
      queriedTables: query.queriedTables,
      p95: query.runInfos[Math.floor(query.runInfos.length * 0.95)]!.durationMs,
    }))
  } catch (e) {
    console.warn(`Error in slow queries tab: ${e}`)
    return [] as never
  }
}

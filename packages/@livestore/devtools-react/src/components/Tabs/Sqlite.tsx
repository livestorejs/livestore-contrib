import type { SqliteDb, SqlValue } from '@livestore/common'
import { SqlValueSchema } from '@livestore/common'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect } from '@livestore/utils/effect'
import React from 'react'
import type * as RA from 'react-aria'
import * as RAC from 'react-aria-components'

import { useDevtoolsStore } from '../../devtools-store-context.js'
import { useFormatSql } from '../../hooks/useFormatSql.js'
import { sqlitePlaygroundState } from '../../livestore/tables.js'
import { useSessionContext } from '../../session-context.js'
import { cn } from '../../utils/cn.ts'
import { downloadBlob } from '../../utils/download.ts'
import { DevToolsButton } from '../DevToolsButton.js'
import { JsonTreeViewer } from '../JsonTreeViewer.js'

const sqlite3Promise = loadSqlite3Wasm()

type DbCtx = {
  sqliteDb: SqliteDb
}

type Result = {
  query: string
  timestampMs: number
  result: ReadonlyArray<Record<string, SqlValue>>
}

/**
 * 
CREATE TABLE todo (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	completed BOOLEAN NOT NULL
);

INSERT INTO todo (title, completed) VALUES ('Buy groceries', false);
INSERT INTO todo (title, completed) VALUES ('Do laundry', false);
INSERT INTO todo (title, completed) VALUES ('Finish project', false);

SELECT * FROM todo;

 */

export const Sqlite: React.FC = () => {
  const [dbCtx, setDbCtx] = React.useState<DbCtx | undefined>(undefined)
  const store = useDevtoolsStore()
  const [state, setState] = store.useClientDocument(sqlitePlaygroundState)
  const [results, setResults] = React.useState<Result[]>([])
  const [focussedQueryText, setFocussedQueryText] = React.useState<string | undefined>(undefined)
  const _formatSql = useFormatSql()

  const { apiSession } = useSessionContext()

  React.useEffect(
    () =>
      Effect.gen(function* () {
        const sqlite3 = yield* Effect.promise(() => sqlite3Promise)
        const sqliteDb = sqliteDbFactory({ sqlite3 })({ _tag: 'in-memory' }).pipe(Effect.runSync)
        setDbCtx({ sqliteDb })
      }).pipe(Effect.tapCauseLogPretty, Effect.runCallback),
    [],
  )

  const queryTextToQueries = (queryText: string) => {
    return queryText.split(';').filter((q) => q.trim() !== '')
  }

  const runQueries = React.useCallback(
    (queries: string[]) => {
      if (dbCtx === undefined) {
        return
      }

      for (const query of queries) {
        try {
          const stmt = dbCtx.sqliteDb.prepare(query)
          const result = stmt.select<Record<string, SqlValue>>(undefined)
          setResults((results) => [...results, { query, timestampMs: Date.now(), result }])
          console.log('Query result:', result)
        } catch (error: any) {
          console.error('Error executing query:', error)
          setResults((results) => [
            ...results,
            { query, timestampMs: Date.now(), result: [{ error: error.toString() }] },
          ])
        }
      }
    },
    [dbCtx],
  )

  const handleExportDb = () => {
    if (dbCtx === undefined) {
      return
    }

    const blob = new Blob([dbCtx.sqliteDb.export()], { type: 'application/octet-stream' })
    downloadBlob(blob, `livestore-devtools-${Date.now()}.db`)
  }

  const handleImportDbClick = (files: FileList | null) => {
    if (dbCtx === undefined || files === null) {
      return
    }

    Effect.gen(function* () {
      const fileDataBuffer = yield* Effect.promise(() => files[0]!.arrayBuffer())

      dbCtx.sqliteDb.import(new Uint8Array(fileDataBuffer))
    }).pipe(Effect.tapCauseLogPretty, Effect.runPromise)
  }

  const handleImportDbDrop = (event: RA.DropEvent) => {
    if (dbCtx === undefined) {
      return
    }

    Effect.gen(function* () {
      const fileItems = event.items.filter((_): _ is RA.FileDropItem => _.kind === 'file')

      yield* Effect.forEach(fileItems, (fileItem) =>
        Effect.gen(function* () {
          const file = yield* Effect.promise(() => fileItem.getFile())
          const fileDataBuffer = yield* Effect.promise(() => file.arrayBuffer())
          const fileData = new Uint8Array(fileDataBuffer)

          dbCtx.sqliteDb.import(fileData)
        }).pipe(Effect.withSpan(`import-db-${fileItem.name}`)),
      )
    }).pipe(Effect.tapCauseLogPretty, Effect.runPromise)
  }

  const handleLoadAppDb = React.useCallback(() => {
    if (dbCtx === undefined) {
      return
    }

    Effect.gen(function* () {
      const initialData = yield* apiSession.snapshot
      dbCtx.sqliteDb.import(initialData)
    }).pipe(Effect.tapCauseLogPretty, Effect.runPromise)
  }, [dbCtx, apiSession])

  React.useEffect(() => {
    handleLoadAppDb()
  }, [handleLoadAppDb])

  const [importIsDragging, setImportIsDragging] = React.useState(false)

  if (dbCtx === undefined) {
    return <div>Loading SQLite...</div>
  }

  return (
    <div className="w-full h-full flex">
      <div className="border border-devtools-border rounded w-full h-full relative flex flex-col bg-devtools-surface">
        {/* <div className="absolute top-2 left-2 font-mono">{formatSql(state.query)}</div> */}
        <div className="p-1 flex gap-1">
          <DevToolsButton
            size="xs"
            variant="primary"
            onClick={() => runQueries(queryTextToQueries(state.query))}
          >
            Run all
          </DevToolsButton>
          <DevToolsButton
            size="xs"
            variant="primary"
            disabled={focussedQueryText === undefined}
            onClick={() =>
              focussedQueryText ? runQueries(queryTextToQueries(focussedQueryText)) : null
            }
          >
            Run focused
          </DevToolsButton>
          <DevToolsButton size="xs" onClick={() => handleLoadAppDb()}>
            Load app DB
          </DevToolsButton>
          <DevToolsButton size="xs" onClick={() => handleExportDb()}>
            Export DB
          </DevToolsButton>
          <RAC.DropZone
            onDrop={handleImportDbDrop}
            onDropEnter={() => setImportIsDragging(true)}
            onDropExit={() => setImportIsDragging(false)}
            className={cn('flex', importIsDragging ? 'bg-devtools-bar-selected text-white' : '')}
          >
            <RAC.FileTrigger onSelect={handleImportDbClick}>
              <DevToolsButton size="xs">Import DB</DevToolsButton>
            </RAC.FileTrigger>
          </RAC.DropZone>
        </div>
        <textarea
          value={state.query}
          onChange={(e) => setState({ query: e.target.value })}
          onClick={(e) => setFocussedQueryText(getFocussedQueryText(e))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()

              const queryText = getFocussedQueryText(e)

              if (queryText) {
                runQueries(queryTextToQueries(queryText))
              }
            }
          }}
          className="font-mono w-full h-full p-2 text-sm flex bg-devtools-surface text-devtools-text border border-devtools-border rounded focus:outline-none focus:ring-1 focus:ring-devtools-focus resize-none"
          placeholder="Starting from an empty SQLite database. Enter your SQLite query here..."
        />
      </div>
      <div className="w-full flex flex-col gap-1 p-2 overflow-y-auto">
        {results.map((result, index) => (
          <div
            key={index}
            className="bg-devtools-background-secondary p-2 rounded text-sm border border-devtools-border"
          >
            <div>
              <span className="text-devtools-text-secondary">
                {printRelativeTime(result.timestampMs)}
              </span>{' '}
              <span className="font-mono text-devtools-text">{result.query}</span>
            </div>
            {/* JSON result viewer */}
            {/* <JsonViewer data={result.result} hideRoot={false} initiallyExpandedDepth={1} /> */}
            <ResultTable rows={result.result} />
          </div>
        ))}
      </div>
    </div>
  )
}

const getFocussedQueryText = (
  e: React.MouseEvent<HTMLTextAreaElement> | React.KeyboardEvent<HTMLTextAreaElement>,
) => {
  const query = e.currentTarget.value
  const selectedText = window.getSelection()?.toString()
  const cursorLine =
    e.currentTarget.value.slice(0, e.currentTarget.selectionStart).split('\n').length - 1
  const queryText =
    selectedText === ''
      ? (query.split('\n')[cursorLine] ??
        query.split('\n')[
          e.currentTarget.selectionStart
            ? e.currentTarget.value
                .slice(0, Math.max(0, e.currentTarget.selectionStart))
                .split('\n').length - 1
            : 0
        ])
      : selectedText

  return queryText
}

const formatter = new Intl.RelativeTimeFormat('en', { style: 'short' })

const printRelativeTime = (timestampMs: number) => {
  const now = Date.now()
  const diff = now - timestampMs
  const diffInSeconds = Math.floor(diff / 1000) - 1
  return formatter.format(diffInSeconds, 'seconds')
}

const ResultTable: React.FC<{ rows: ReadonlyArray<Record<string, SqlValue>> }> = ({ rows }) => {
  const columns = React.useMemo(() => {
    return Object.keys(rows[0] ?? {})
  }, [rows])

  if (rows.length === 0) {
    return <div>No results</div>
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} className="border p-1 text-left text-xs">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {columns.map((column) => (
              <td key={`${rowIndex}-${column}`} className="border p-1 text-xs">
                <JsonTreeViewer
                  data={formatForViewer(row[column])}
                  schema={SqlValueSchema}
                  initiallyExpandedDepth={1}
                  hideRoot={true}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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

import type { Devtools } from '@livestore/common'
import { liveStoreVersion } from '@livestore/common'
import { prettyBytes } from '@livestore/utils'
import { Cause, Effect, Result, Schema } from '@livestore/utils/effect'
import React from 'react'
import type * as RA from 'react-aria'
import * as RAC from 'react-aria-components'

import { useRootContext } from '../../root-context.js'
import { useSessionContext } from '../../session-context.js'
import { cn } from '../../utils/cn.ts'
import { downloadBlob } from '../../utils/download.ts'
import { recordToString } from '../../utils/utils.js'
import { useConfirmState } from '../ConfirmModalContext.js'
import { DevToolsButton } from '../DevToolsButton.js'
import { Section } from '../Section.js'
import { ThemeToggle } from '../ThemeToggle.js'

export const General: React.FC = () => {
  const { license } = useRootContext()
  const { apiSession, appSchema } = useSessionContext()

  const { setConfirmState } = useConfirmState()

  const [databaseFileInfo, setDatabaseFileInfo] = React.useState<
    typeof Devtools.Leader.DatabaseFileInfoRes.Type | undefined
  >(undefined)


  React.useEffect(() => {
    const cancel = Effect.runCallback(
      apiSession.databaseFileInfo.pipe(Effect.tapSync(setDatabaseFileInfo)),
    )
    return () => cancel()
  }, [apiSession])

  return (
    <div className="h-full flex flex-col bg-devtools-background">
      <div className="flex flex-col overflow-y-auto py-2">
        <Section title="Reset">
          <div className="flex gap-3">
            <DevToolsButton
              size="xs"
              onClick={async () => {
                setConfirmState({
                  _tag: 'Confirming',
                  onConfirm: () =>
                    apiSession.resetAllData('only-app-db').pipe(
                      Effect.tapSync(() => setTimeout(() => location.reload(), 1000)),
                      Effect.tapCauseLogPretty,
                      Effect.runPromise,
                    ),
                  message: 'Are you sure you want to rematerialize from eventlog?',
                  confirmLabel: 'Rehydrate',
                })
              }}
            >
              Rematerialize from eventlog
            </DevToolsButton>
            <DevToolsButton
              size="xs"
              variant="danger"
              onClick={() => {
                setConfirmState({
                  _tag: 'Confirming',
                  onConfirm: () =>
                    apiSession.resetAllData('all-data').pipe(
                      Effect.tapSync(() => setTimeout(() => location.reload(), 1000)),
                      Effect.tapCauseLogPretty,
                      Effect.runPromise,
                    ),
                  message: 'Are you sure you want to reset all data?',
                  confirmLabel: 'Reset',
                })
              }}
            >
              Reset all data
            </DevToolsButton>
          </div>
        </Section>
        <Section title="Export">
          <div className="flex gap-3">
            {databaseFileInfo && (
              <>
                <DevToolsButton
                  size="xs"
                  onClick={() =>
                    apiSession.snapshot.pipe(
                      Effect.tapSync((data) =>
                        downloadBlob(data, databaseFileInfo.state.persistenceInfo.fileName),
                      ),
                      Effect.tapCauseLogPretty,
                      Effect.runPromise,
                    )
                  }
                >
                  Export DB ({prettyBytes(databaseFileInfo.state.fileSize)},{' '}
                  {recordToString(databaseFileInfo.state.persistenceInfo)})
                </DevToolsButton>

                <DevToolsButton
                  size="xs"
                  onClick={() =>
                    apiSession.eventlog.pipe(
                      Effect.tapSync((data) =>
                        downloadBlob(data, databaseFileInfo.eventlog.persistenceInfo.fileName),
                      ),
                      Effect.tapCauseLogPretty,
                      Effect.runPromise,
                    )
                  }
                >
                  Export Eventlog ({prettyBytes(databaseFileInfo.eventlog.fileSize)},{' '}
                  {recordToString(databaseFileInfo.eventlog.persistenceInfo)})
                </DevToolsButton>
              </>
            )}
          </div>
        </Section>
        <ImportSection />
        <Section title="Info">
          <div className="space-y-1">
            <div className="text-xs text-devtools-text">
              <span className="text-devtools-text-secondary">LiveStore Version:</span>
              <span className="ml-1 font-mono text-devtools-text">{liveStoreVersion}</span>
            </div>
            <div className="text-xs text-devtools-text">
              <span className="text-devtools-text-secondary">Schema hash:</span>
              <span className="ml-1 font-mono text-devtools-text">
                {appSchema.state.sqlite.hash}
              </span>
            </div>
          </div>
        </Section>
        <Section title="Appearance">
          <ThemeToggle />
        </Section>
        {license && <Section title="License Text">{license}</Section>}
      </div>
    </div>
  )
}

class ReadFileError extends Schema.TaggedErrorClass<ReadFileError>()('ReadFileError', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

const readFileAsArrayBuffer = (file: File): Effect.Effect<ArrayBuffer, ReadFileError> =>
  Effect.tryPromise({
    try: () => file.arrayBuffer(),
    catch: (cause) => new ReadFileError({ cause, message: 'Failed to read file' }),
  })

const ImportSection: React.FC = () => {
  const { apiSession } = useSessionContext()
  const [status, setStatus] = React.useState<
    { _tag: 'Success' } | { _tag: 'Error'; error: string } | undefined
  >(undefined)

  const onDropDbFile = React.useCallback(
    (file: File): Effect.Effect<void, ReadFileError, never> =>
      Effect.gen(function* () {
        const data = yield* readFileAsArrayBuffer(file)

        const result = yield* apiSession.loadDatabaseFile(new Uint8Array(data)).pipe(Effect.result)

        if (Result.isFailure(result) === true) {
          console.error('Failed to load database file', result.failure)
          setStatus({
            _tag: 'Error',
            error: Cause.pretty(Cause.fail(result.failure)),
          })
        } else {
          setStatus({ _tag: 'Success' })
        }
      }).pipe(Effect.withSpan('@livestore/devtools-react:import-database-file')),
    [apiSession],
  )

  return (
    <Section title="Import">
      <FileDropZone onDrop={onDropDbFile}>
        {(isDragging) => (
          <div
            className={cn(
              isDragging
                ? 'bg-devtools-background-hover border-devtools-bar-selected'
                : 'bg-devtools-surface/20 border-devtools-divider/40',
              'p-4 text-xs border rounded border-dashed transition-colors',
            )}
          >
            {status && status._tag === 'Success' && (
              <div className="text-green-600 dark:text-green-400 mb-1">
                Successfully loaded database file
              </div>
            )}
            {status && status._tag === 'Error' && (
              <div className="text-red-600 dark:text-red-400 mb-1">
                Failed to load database file: {status.error}
              </div>
            )}
            <div className="text-devtools-text-secondary">Import DB file (app db or eventlog)</div>
          </div>
        )}
      </FileDropZone>
    </Section>
  )
}

class DropFileAccessError extends Schema.TaggedErrorClass<DropFileAccessError>()(
  'DropFileAccessError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

const FileDropZone: React.FC<{
  onDrop: (file: File) => Effect.Effect<void, ReadFileError, never>
  children: (isDragging: boolean) => React.ReactNode
}> = ({ onDrop, children }) => {
  const [isDragging, setIsDragging] = React.useState(false)

  const onDrop_ = React.useCallback(
    (event: RA.DropEvent) => {
      const fileItems = event.items.filter((_): _ is RA.FileDropItem => _.kind === 'file')

      for (const fileItem of fileItems) {
        Effect.gen(function* () {
          const file = yield* Effect.tryPromise({
            try: () => fileItem.getFile(),
            catch: (cause) =>
              new DropFileAccessError({
                cause,
                message: 'Failed to access dropped file',
              }),
          })
          yield* onDrop(file)
        }).pipe(
          Effect.withSpan('@livestore/devtools-react:handle-dropped-file'),
          Effect.tapCauseLogPretty,
          Effect.runPromise,
        )
      }
    },
    [onDrop],
  )

  const onSelect = React.useCallback(
    (files: FileList | null) => {
      if (files !== null) {
        for (const file of files) {
          onDrop(file).pipe(Effect.tapCauseLogPretty, Effect.runPromise)
        }
      }
    },
    [onDrop],
  )

  return (
    <RAC.DropZone
      onDrop={onDrop_}
      onDropEnter={() => setIsDragging(true)}
      onDropExit={() => setIsDragging(false)}
      className="w-full"
    >
      <RAC.FileTrigger onSelect={onSelect}>
        <RAC.Button className="w-full text-left">{children(isDragging)}</RAC.Button>
      </RAC.FileTrigger>
    </RAC.DropZone>
  )
}

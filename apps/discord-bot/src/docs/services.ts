import { Context, type Effect } from 'effect'

import type {
  AnswerEngineFailure,
  AnswerEngineResult,
  CorpusSnapshotResult,
  CorpusUnavailable,
  DocsQueryInput,
  DocsQueryResult,
  DocsTelemetryEvent,
  DocumentationSource,
} from './domain.ts'

export interface DocumentationCorpusService {
  readonly snapshot: (options?: {
    readonly refresh?: boolean
  }) => Effect.Effect<CorpusSnapshotResult, CorpusUnavailable>
}

export class DocumentationCorpus extends Context.Service<DocumentationCorpus, DocumentationCorpusService>()(
  'livestore-discord/DocumentationCorpus',
) {}

export interface AnswerEngineInput {
  readonly query: string
  readonly corpusDigest: string
  readonly sources: ReadonlyArray<DocumentationSource>
}

export interface AnswerEngineService {
  readonly configurationIdentity: string
  readonly answer: (input: AnswerEngineInput) => Effect.Effect<AnswerEngineResult, AnswerEngineFailure>
}

export class AnswerEngine extends Context.Service<AnswerEngine, AnswerEngineService>()(
  'livestore-discord/AnswerEngine',
) {}

export interface DocsTelemetryService {
  readonly emit: (event: DocsTelemetryEvent) => Effect.Effect<void>
}

export class DocsTelemetry extends Context.Service<DocsTelemetry, DocsTelemetryService>()(
  'livestore-discord/DocsTelemetry',
) {}

export interface DocsWorkflowService {
  readonly query: (input: DocsQueryInput) => Effect.Effect<DocsQueryResult>
}

export class DocsWorkflow extends Context.Service<DocsWorkflow, DocsWorkflowService>()(
  'livestore-discord/DocsWorkflow',
) {}

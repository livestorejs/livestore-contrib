import fs from 'node:fs/promises'
import path from 'node:path'

import { OtelLiveDummy } from '@livestore/common'
import { Effect, Schema } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { ScenarioRunArtifact } from './model.ts'
import { runInProcessScenario } from './runner.ts'

const outputPath = path.resolve(process.argv[2] ?? 'artifacts/offline-writer-recovery.json')

const program = Effect.gen(function* () {
  const artifact = yield* runInProcessScenario({
    scenario: offlineWriterRecovery,
    application: todoApplication,
    options: {
      runId: `offline-writer-recovery-${Date.now()}`,
      sourceRevision: 'working-tree',
    },
  })
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ScenarioRunArtifact))(artifact)
  yield* Effect.tryPromise(async () => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${encoded}\n`, 'utf8')
  })
  yield* Effect.sync(() => {
    console.log(`Scenario ${artifact.status}: ${artifact.descriptor.scenarioId}`)
    console.log(`Trace records: ${artifact.trace.length}`)
    console.log(`Artifact: ${outputPath}`)
  })
}).pipe(Effect.withSpan('scenario-cli'), Effect.scoped, Effect.provide(OtelLiveDummy))

PlatformNode.NodeRuntime.runMain(program)

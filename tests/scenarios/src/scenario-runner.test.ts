import { expect } from 'vitest'

import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect, Exit, Schema } from '@livestore/utils/effect'

import { offlineWriterRecovery } from './corpus/offline-writer-recovery.ts'
import { todoApplication } from './fixtures/todo-application.ts'
import { makeInProcessHost } from './host.ts'
import { defineScenario, ScenarioRunArtifact } from './model.ts'
import { runInProcessScenario } from './runner.ts'

/** Verifies: LS.SYS.VER.SCEN-R01, LS.SYS.VER.SCEN-R03, LS.SYS.VER.SCEN-R06 */
Vitest.describe('scenario model', () => {
  Vitest.it('validates and round-trips the versioned serializable AST', () => {
    const encoded = JSON.parse(JSON.stringify(offlineWriterRecovery))
    expect(defineScenario(encoded)).toEqual(offlineWriterRecovery)
  })
})

/** Verifies: LS.SYS.VER.SCEN-R05, LS.SYS.VER.SCEN-R06, LS.SYS.VER.SCEN-R08 */
Vitest.describe('in-process host conformance', () => {
  Vitest.live('rejects topology beyond its advertised session capability', (test) =>
    Effect.gen(function* () {
      const host = yield* makeInProcessHost(todoApplication)
      expect(host.capabilities.maximumSessionsPerClient).toBe(1)

      const exit = yield* host
        .createClient({
          operationId: 'create-client-a',
          storeId: 'host-conformance',
          client: { id: 'client-a', sessions: ['session-a', 'session-b'], initiallyConnected: true },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Vitest.withTestCtx(test)),
  )
})

/**
 * Verifies the first vertical slice of LS.SYS.VER.SCEN-R02, R04, R07, R11 to
 * R16, and R18.
 */
Vitest.describe('offline writer recovery', () => {
  Vitest.live(
    'runs through real Stores and emits passing convergence evidence',
    (test) =>
      Effect.gen(function* () {
        const artifact = yield* runInProcessScenario({
          scenario: offlineWriterRecovery,
          application: todoApplication,
          options: { runId: 'offline-writer-recovery-test', sourceRevision: 'test' },
        })

        expect(artifact.status).toBe('passed')
        expect(artifact.verdicts).toHaveLength(4)
        expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
        expect(artifact.snapshots).toHaveLength(2)
        expect(artifact.trace.map((record) => record.kind)).toEqual(
          expect.arrayContaining([
            'client.created',
            'connectivity.disconnected',
            'connectivity.reconnected',
            'settlement.completed',
            'state.snapshot',
            'oracle.verdict',
          ]),
        )
        expect(() => Schema.decodeUnknownSync(ScenarioRunArtifact)(artifact)).not.toThrow()
      }).pipe(Vitest.withTestCtx(test)),
    15_000,
  )
})

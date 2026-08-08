import {
  Effect,
  Vitest,
  expect,
  lateClientCatchUp,
  projectTraceAt,
  runInProcessScenario,
  todoApplication,
} from './test-support/scenario-test-kit.ts'

Vitest.describe('dynamic participant addition', () => {
  Vitest.live('creates a late Client after confirmed history and converges from empty local state', (test) =>
    Effect.gen(function* () {
      const artifact = yield* runInProcessScenario({
        scenario: lateClientCatchUp,
        application: todoApplication,
        options: { runId: 'late-client-catch-up-test', sourceRevision: 'test' },
      })

      expect(artifact.status).toBe('passed')
      expect(artifact.snapshots).toHaveLength(2)
      const initialSettlementId = lateClientCatchUp.instructions.find(
        (instruction) => instruction._tag === 'settle',
      )?.id
      const lateCreationId = lateClientCatchUp.instructions.find(
        (instruction) => instruction._tag === 'create-client',
      )?.id
      const initialSettlement = artifact.trace.find(
        (record) => record.correlationId === initialSettlementId && record.payload._tag === 'settlement.completed',
      )
      const lateCreation = artifact.trace.find(
        (record) => record.correlationId === lateCreationId && record.payload._tag === 'client.created',
      )
      expect(initialSettlement?.index).toBeLessThan(lateCreation?.index ?? -1)
      expect(
        projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: initialSettlement?.index ?? -1,
        }).clients.find((client) => client.clientId === 'client-b')?.lifecycle,
      ).toBe('declared')
      expect(
        projectTraceAt({
          scenario: artifact.scenario,
          trace: artifact.trace,
          cursorIndex: lateCreation?.index ?? -1,
        }).clients.find((client) => client.clientId === 'client-b')?.lifecycle,
      ).toBe('created')
      expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
    }).pipe(Vitest.withTestCtx(test)),
  )
})

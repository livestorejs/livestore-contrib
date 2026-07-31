import {
  type ParticipantHostFailureCode,
  type ScenarioOperationFailureOutcome,
  Vitest,
  browserHostCapabilities,
  expect,
  inProcessHostCapabilities,
  participantHostFailure,
  processHostCapabilities,
} from '../test-support/scenario-test-kit.ts'

Vitest.describe('participant-host failure conformance', () => {
  Vitest.it('does not advertise exact Event lineage for sampled-correlation hosts', () => {
    for (const capabilities of [inProcessHostCapabilities, processHostCapabilities, browserHostCapabilities]) {
      expect(capabilities.capabilities).not.toContain('event-lineage')
    }
  })

  Vitest.it('keeps portable failure category independent from operation certainty', () => {
    const cases: ReadonlyArray<{
      code: ParticipantHostFailureCode
      operationOutcome: ScenarioOperationFailureOutcome
    }> = [
      { code: 'host-infrastructure-failure', operationOutcome: 'definite-failure' },
      { code: 'host-request-rejected', operationOutcome: 'definite-failure' },
      { code: 'host-response-invalid', operationOutcome: 'definite-failure' },
      { code: 'host-response-timeout', operationOutcome: 'indefinite' },
      { code: 'host-transport-failure', operationOutcome: 'definite-failure' },
      { code: 'host-transport-failure', operationOutcome: 'indefinite' },
    ]

    expect(
      cases.map(({ code, operationOutcome }) => {
        const error = participantHostFailure({ code, message: 'profile-specific detail', operationOutcome })
        return { code: error.code, operationOutcome: error.operationOutcome }
      }),
    ).toEqual(cases)
  })
})

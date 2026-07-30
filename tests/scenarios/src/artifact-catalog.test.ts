import { describe, expect, it } from 'vitest'

import { buildArtifactCatalog } from './artifact-catalog.ts'
import type { ScenarioRunArtifact } from './model.ts'

describe('artifact catalog', () => {
  it.each([
    ['concurrent-hotel-booking', 'SF-01'],
    ['pending-tail-recovery', 'SF-02'],
    ['many-writer-convergence', 'SF-03'],
    ['large-payload-recovery', 'SF-04'],
  ] as const)('labels the reported %s finding as %s', (scenarioId, findingId) => {
    const catalog = buildArtifactCatalog([
      { file: `${scenarioId}.json.gz`, artifact: makeArtifact(scenarioId), reference: false },
    ])

    expect(catalog.entries[0]).toMatchObject({ findingId, scenarioId })
  })

  it('does not assign a finding ID to previous reference artifacts', () => {
    const catalog = buildArtifactCatalog([
      { file: 'reference.json.gz', artifact: makeArtifact('offline-writer-recovery'), reference: true },
    ])

    expect(catalog.entries[0]?.findingId).toBeUndefined()
    expect(catalog.entries[0]?.label).toContain('reference')
  })
})

const makeArtifact = (scenarioId: string) =>
  ({
    descriptor: {
      scenarioId,
      execution: { participantProfile: 'in-process', syncBackend: 'mock' },
    },
    scenario: { topology: { clients: [] }, phases: [] },
    trace: [{ payload: { _tag: 'run.completed', status: 'passed' } }],
    status: 'passed',
  }) as unknown as ScenarioRunArtifact

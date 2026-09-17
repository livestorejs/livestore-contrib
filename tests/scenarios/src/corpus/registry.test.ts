import { describe, expect, it } from 'vitest'

import { getScenarioApplication, scenarioApplications } from './applications/registry.ts'
import { getScenario, retainedScenarioCatalog, scenarioCorpus } from './scenarios/registry.ts'

describe('scenario corpus', () => {
  it('indexes every Application and Scenario by a unique ID', () => {
    expect(new Set(scenarioApplications.map(({ id }) => id)).size).toBe(scenarioApplications.length)
    expect(new Set(scenarioCorpus.map(({ id }) => id)).size).toBe(scenarioCorpus.length)

    for (const application of scenarioApplications) {
      expect(getScenarioApplication(application.id)).toBe(application)
    }
    for (const scenario of scenarioCorpus) {
      expect(getScenario(scenario.id)).toBe(scenario)
    }
  })

  it('resolves the Application referenced by every Scenario', () => {
    for (const scenario of scenarioCorpus) {
      expect(getScenarioApplication(scenario.applicationId).id).toBe(scenario.applicationId)
    }
  })

  it('keeps the retained CLI corpus intentionally limited to promoted findings and representative examples', () => {
    expect(retainedScenarioCatalog.map(({ findingId, kind, scenario }) => [kind, findingId, scenario.id])).toEqual([
      ['example', undefined, 'offline-writer-recovery'],
      ['example', undefined, 'multi-session-recovery'],
      ['finding', 'SF-01', 'concurrent-hotel-booking'],
      ['finding', 'SF-02', 'pending-tail-recovery'],
      ['finding', 'SF-03', 'many-writer-convergence'],
      ['finding', 'SF-04', 'large-payload-recovery'],
    ])
  })
})

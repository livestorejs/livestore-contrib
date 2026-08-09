import { describe, expect, it } from 'vitest'

import { scenarioApplications } from '../corpus/applications/registry.ts'
import { compileScenarioYamlFile } from './file.ts'

describe('YAML Scenario file loading', () => {
  it('discovers an exact same-name helper companion for an explicit file', async () => {
    const scenario = await compileScenarioYamlFile(new URL('./fixtures/sidecar-load.scenario.yaml', import.meta.url), {
      applications: scenarioApplications,
    })

    expect(scenario.instructions[0]).toEqual(
      expect.objectContaining({
        _tag: 'action-sequence',
        actions: [expect.objectContaining({ input: { id: 'sidecar-todo', text: 'Loaded from a same-name helper' } })],
      }),
    )
  })
})

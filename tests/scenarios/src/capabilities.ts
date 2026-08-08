import { deriveScenarioTopology, type HostCapability, type ScenarioAst, type ScenarioStep } from './model.ts'

/**
 * Derives host behavior from the executable Scenario shape so capability
 * validation cannot depend on authors repeating structural facts by hand.
 */
export const deriveScenarioRequirements = (scenario: ScenarioAst): ReadonlyArray<HostCapability> => {
  const declaredTopology = deriveScenarioTopology(scenario)
  const requirements = new Set<HostCapability>([
    ...scenario.requires,
    // The runner records this view before any participant exists.
    'system-observation',
  ])

  // Final snapshot capture records this view for every declared participant.
  if (declaredTopology.length > 0) requirements.add('sync-observation')
  if (declaredTopology.length > 1) requirements.add('multiple-clients')
  if (declaredTopology.some((client) => client.sessions.length > 1) === true) requirements.add('multiple-sessions')

  for (const step of scenario.phases.flatMap((phase) => phase.steps)) {
    if (step._tag === 'parallel') {
      for (const operation of step.operations) addOperationRequirements(requirements, operation)
    } else if (step._tag === 'settle') {
      if (step.healDisconnectedClients.length > 0) requirements.add('disconnect-reconnect')
    } else if (step._tag === 'action-sequence') {
      for (const action of step.actions) addOperationRequirements(requirements, action)
    } else if (step._tag === 'create-client') {
      requirements.add('dynamic-client-creation')
    } else if (step._tag === 'add-session') {
      requirements.add('dynamic-session-addition')
    } else {
      addOperationRequirements(requirements, step)
    }
  }

  if (
    scenario.oracles.some((oracle) => oracle._tag === 'state-convergence' || oracle._tag === 'state-contains-ids') ===
    true
  ) {
    requirements.add('state-inspection')
  }

  return [...requirements]
}

export const sessionsBeyondHostLimit = (args: {
  scenario: ScenarioAst
  maximumSessionsPerClient: number
}): ReadonlyArray<{ readonly clientId: string; readonly requested: number }> =>
  deriveScenarioTopology(args.scenario).flatMap((client) =>
    client.sessions.length > args.maximumSessionsPerClient
      ? [{ clientId: client.id, requested: client.sessions.length }]
      : [],
  )

const addOperationRequirements = (
  requirements: Set<HostCapability>,
  operation: Exclude<
    ScenarioStep,
    { readonly _tag: 'parallel' | 'settle' | 'action-sequence' | 'create-client' | 'add-session' }
  >,
): void => {
  switch (operation._tag) {
    case 'action':
      requirements.add('named-actions')
      return
    case 'disconnect':
    case 'reconnect':
      requirements.add('disconnect-reconnect')
      return
    case 'backend-unavailable':
    case 'backend-available':
      requirements.add('backend-availability')
      return
    case 'stop-session':
    case 'restart-session':
      requirements.add('session-restart')
      return
    case 'restart-client':
      requirements.add('client-restart')
  }
}

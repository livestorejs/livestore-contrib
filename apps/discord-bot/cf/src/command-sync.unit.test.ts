import { expect, it } from '@effect/vitest'
import { Discord } from 'dfx'

import { desiredApplicationCommands } from '../../src/application-commands/desired.ts'
import type { ApplicationCommand } from '../../src/application-commands/model.ts'
import { computeCommandDiff } from './command-sync.ts'

/**
 * Fixtures mirror what Discord returns for the globally-deployed projection of
 * the desired declaration: guild-install integration types and guild-only
 * interaction contexts (see reconcile.ts's global scope projection), plus
 * `null` default member permissions per the q4 decision so server-side denial
 * stays reachable UX.
 */
const asDeployedGlobal = (command: ApplicationCommand): ApplicationCommand => ({
  ...command,
  integrationTypes: [0],
  contexts: [0],
})

const deployedDesired: ReadonlyArray<ApplicationCommand> = desiredApplicationCommands.map(asDeployedGlobal)

const keyOf = (command: Pick<ApplicationCommand, 'type' | 'name'>) => `${command.type}:${command.name}`

it('classifies every desired command as a create when Discord has none', () => {
  const result = computeCommandDiff(deployedDesired, [])
  expect(result.created).toEqual(deployedDesired.map(keyOf))
  expect(result.updated).toEqual([])
  expect(result.deleted).toEqual([])
  expect(result.unchanged).toBe(0)
})

it('reports full convergence when actual equals the deployed desired state', () => {
  const result = computeCommandDiff(deployedDesired, deployedDesired)
  expect(result).toEqual({
    created: [],
    updated: [],
    deleted: [],
    unchanged: deployedDesired.length,
  })
})

it('treats a permission change as an update', () => {
  const drifted: Array<ApplicationCommand> = deployedDesired.map((command) =>
    command.name === 'docs' ? { ...command, defaultMemberPermissions: '8' } : command,
  )
  const result = computeCommandDiff(deployedDesired, drifted)
  expect(result.updated).toEqual([keyOf({ type: Discord.ApplicationCommandType.CHAT, name: 'docs' })])
  expect(result.created).toEqual([])
  expect(result.deleted).toEqual([])
  expect(result.unchanged).toBe(drifted.length - 1)
})

it('treats a metadata drift as an update without touching other commands', () => {
  const drifted: Array<ApplicationCommand> = deployedDesired.map((command) =>
    command.name === 'Create Thread' ? { ...command, nsfw: true } : command,
  )
  const result = computeCommandDiff(deployedDesired, drifted)
  expect(result.updated).toEqual([keyOf({ type: Discord.ApplicationCommandType.MESSAGE, name: 'Create Thread' })])
  expect(result.unchanged).toBe(deployedDesired.length - 1)
})

it('classifies commands absent from desired state as deletions', () => {
  const retired: ApplicationCommand = {
    type: Discord.ApplicationCommandType.CHAT,
    name: 'legacy',
    description: 'Retired command still registered remotely',
    options: [],
    defaultMemberPermissions: null,
    nsfw: false,
    integrationTypes: [0],
    contexts: [0],
  }
  const result = computeCommandDiff(deployedDesired, [...deployedDesired, retired])
  expect(result.deleted).toEqual([keyOf(retired)])
  expect(result.unchanged).toBe(deployedDesired.length)
})

import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { desiredApplicationCommands, diffApplicationCommands, type ApplicationCommand } from './index.ts'

describe('application command desired state', () => {
  it('declares /docs and Create Thread from one source of truth', () => {
    expect(desiredApplicationCommands).toEqual([
      {
        type: 1,
        name: 'docs',
        description:
          'Ask LiveStore docs via OpenAI (store:false); no ambient chat or bot-retained query/answer content.',
        options: [
          {
            type: 3,
            name: 'query',
            description: 'Question to answer from the LiveStore documentation',
            required: true,
          },
        ],
        defaultMemberPermissions: null,
        nsfw: false,
      },
      {
        type: 3,
        name: 'Create Thread',
        description: '',
        options: [],
        defaultMemberPermissions: '34359738368',
        nsfw: false,
      },
    ])
  })
})

describe('diffApplicationCommands', () => {
  it('is deterministic and independent of inventory order', () => {
    const actual = desiredApplicationCommands.toReversed()
    expect(diffApplicationCommands(desiredApplicationCommands, actual)).toEqual({
      changes: [
        expect.objectContaining({ kind: 'unchanged', key: '1:docs' }),
        expect.objectContaining({ kind: 'unchanged', key: '3:Create Thread' }),
      ],
      duplicateActualKeys: [],
      hasChanges: false,
    })
  })

  it('compares semantic fields rather than object property insertion order', () => {
    const docs = desiredApplicationCommands[0]
    const reordered: ApplicationCommand = {
      nsfw: docs.nsfw,
      options: docs.options.map((option) => ({
        required: option.required,
        description: option.description,
        name: option.name,
        type: option.type,
      })),
      description: docs.description,
      name: docs.name,
      type: docs.type,
      defaultMemberPermissions: docs.defaultMemberPermissions,
    }
    expect(diffApplicationCommands([docs], [reordered]).hasChanges).toBe(false)
  })

  it('reports create, update, and delete without hiding bulk-replacement impact', () => {
    const desired: ReadonlyArray<ApplicationCommand> = [command(1, 'alpha', 'new'), command(3, 'Create Thread', '')]
    const actual: ReadonlyArray<ApplicationCommand> = [command(1, 'alpha', 'old'), command(1, 'obsolete', 'remove me')]

    expect(diffApplicationCommands(desired, actual).changes.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: 'update', key: '1:alpha' },
      { kind: 'delete', key: '1:obsolete' },
      { kind: 'create', key: '3:Create Thread' },
    ])
  })

  it('does not conflate user or activity commands with chat commands of the same name', () => {
    const docs = desiredApplicationCommands[0]
    const userCommand: ApplicationCommand = { ...docs, type: 2, description: '' }
    const result = diffApplicationCommands([docs], [userCommand])
    expect(result.changes.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: 'create', key: '1:docs' },
      { kind: 'delete', key: '2:docs' },
    ])
  })

  it('surfaces duplicate remote identities for fail-closed reconciliation', () => {
    const duplicate = command(1, 'docs', 'duplicate')
    const result = diffApplicationCommands(desiredApplicationCommands, [duplicate, duplicate])
    expect(result.duplicateActualKeys).toEqual(['1:docs'])
    expect(result.hasChanges).toBe(true)
  })

  it('detects global installation and interaction-context drift as unordered sets', () => {
    const docs = desiredApplicationCommands[0]
    const desired: ApplicationCommand = { ...docs, integrationTypes: [0, 1], contexts: [0, 1] }
    expect(
      diffApplicationCommands([desired], [{ ...desired, integrationTypes: [1, 0], contexts: [1, 0] }]).hasChanges,
    ).toBe(false)
    expect(diffApplicationCommands([desired], [{ ...desired, integrationTypes: [0], contexts: [0] }]).hasChanges).toBe(
      true,
    )
  })

  it('detects every supported string-option constraint', () => {
    const docs = desiredApplicationCommands[0]
    const constrained: ApplicationCommand = {
      ...docs,
      options: [
        {
          ...docs.options[0],
          autocomplete: false,
          choices: [{ name: 'LiveStore', value: 'livestore' }],
          minLength: 2,
          maxLength: 80,
        },
      ],
    }
    const actualOptions: ReadonlyArray<ApplicationCommand['options'][number]> = [
      { ...constrained.options[0]!, required: false },
      { ...constrained.options[0]!, autocomplete: true },
      { ...constrained.options[0]!, choices: [{ name: 'Other', value: 'other' }] },
      { ...constrained.options[0]!, minLength: 3 },
      { ...constrained.options[0]!, maxLength: 81 },
    ]
    for (const actualOption of actualOptions) {
      expect(
        diffApplicationCommands(
          [constrained],
          [
            {
              ...constrained,
              options: [actualOption],
            },
          ],
        ).hasChanges,
      ).toBe(true)
    }
  })
})

const command = (type: ApplicationCommand['type'], name: string, description: string): ApplicationCommand => ({
  type,
  name,
  description,
  options: [],
  defaultMemberPermissions: null,
  nsfw: false,
})

import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, defineScenarioHelpers, helperActions } from '../../yaml/helpers.ts'

const DistributeActionsInput = Schema.Struct({
  action: Schema.String,
  participants: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  inputs: Schema.Array(Schema.Json),
  strategy: Schema.Literals(['round-robin', 'random']),
})

/** Distributes already-authored action inputs without knowing their Application schema. */
export const distributeActions = defineScenarioHelper({
  input: DistributeActionsInput,
  generate: ({ input, context }) => {
    const participants = context.participants(input.participants)
    return helperActions(
      input.inputs.map((actionInput, offset) => ({
        target:
          input.strategy === 'round-robin'
            ? participants[offset % participants.length]!
            : context.random.iteration(offset + 1).pick('target', participants),
        action: input.action,
        input: actionInput,
      })),
      { description: `Distribute ${input.inputs.length} ${input.action} actions` },
    )
  },
})

const LargeStringActionInput = Schema.Struct({
  target: Schema.String,
  action: Schema.String,
  input: Schema.Record(Schema.String, Schema.Json),
  field: Schema.String,
  bytes: Schema.Int,
  fill: Schema.optional(Schema.String),
})

/** Builds one large string field without knowing the selected Application's input schema. */
export const largeStringAction = defineScenarioHelper({
  input: LargeStringActionInput,
  generate: ({ input, context }) => {
    const fill = input.fill ?? 'x'
    if (fill.length !== 1) throw new Error(`largeStringAction fill must be exactly one character`)
    if (input.bytes <= 0) throw new Error(`largeStringAction bytes must be positive`)
    return helperActions([
      {
        target: context.participant(input.target),
        action: input.action,
        input: { ...input.input, [input.field]: fill.repeat(input.bytes) },
      },
    ])
  },
})

export const sharedScenarioHelpers = defineScenarioHelpers({ distributeActions, largeStringAction })

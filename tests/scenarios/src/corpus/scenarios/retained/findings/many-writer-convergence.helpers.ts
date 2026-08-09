import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, defineScenarioHelpers, helperActions } from '../../../../yaml/helpers.ts'

const distributedTodos = defineScenarioHelper({
  input: Schema.Struct({
    participants: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    count: Schema.Int,
    idPrefix: Schema.String,
  }),
  generate: ({ input, context }) => {
    const participants = context.participants(input.participants)
    return helperActions(
      Array.from({ length: input.count }, (_, offset) => {
        const event = offset + 1
        const random = context.random.iteration(event)
        return {
          target: random.pick('target', participants),
          action: 'createTodo',
          input: {
            id: `${input.idPrefix}-${String(event).padStart(3, '0')}`,
            text: `Distributed write ${event} · variant ${random.integer('text-variant', 1_000)}`,
          },
        }
      }),
    )
  },
})

export default defineScenarioHelpers({ distributedTodos })

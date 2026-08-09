import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, helperActions } from '../../yaml/helpers.ts'

const TodoSeriesInput = Schema.Struct({
  target: Schema.String,
  count: Schema.Int,
  idPrefix: Schema.String,
  textPrefix: Schema.String,
})

export const todoSeries = defineScenarioHelper({
  input: TodoSeriesInput,
  generate: ({ input, context }) => {
    const target = context.participant(input.target)
    return helperActions(
      Array.from({ length: input.count }, (_, offset) => {
        const item = offset + 1
        const variant = context.random.iteration(item).integer('text-variant', 1_000)
        return {
          target,
          action: 'createTodo',
          input: {
            id: `${input.idPrefix}-${String(item).padStart(3, '0')}`,
            text: `${input.textPrefix} ${item} · variant ${variant}`,
          },
        }
      }),
    )
  },
})

const DistributedTodosInput = Schema.Struct({
  participants: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  count: Schema.Int,
  idPrefix: Schema.String,
})

export const distributedTodos = defineScenarioHelper({
  input: DistributedTodosInput,
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

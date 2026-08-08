import { Schema } from '@livestore/utils/effect'

import { defineScenarioGenerator } from '../../application/definition.ts'

const TodoSeriesInput = Schema.Struct({
  target: Schema.String,
  count: Schema.Int,
  idPrefix: Schema.String,
  textPrefix: Schema.String,
})

export const todoSeries = defineScenarioGenerator({
  input: TodoSeriesInput,
  generate: ({ input, context }) => {
    const target = context.participant(input.target)
    return Array.from({ length: input.count }, (_, offset) => {
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
    })
  },
})

const DistributedTodosInput = Schema.Struct({
  participants: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  count: Schema.Int,
  idPrefix: Schema.String,
})

export const distributedTodos = defineScenarioGenerator({
  input: DistributedTodosInput,
  generate: ({ input, context }) => {
    const participants = context.participants(input.participants)
    return Array.from({ length: input.count }, (_, offset) => {
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
    })
  },
})

const LargePayloadTodoInput = Schema.Struct({
  target: Schema.String,
  id: Schema.String,
  payloadBytes: Schema.Int,
})

export const largePayloadTodo = defineScenarioGenerator({
  input: LargePayloadTodoInput,
  generate: ({ input, context }) => [
    {
      target: context.participant(input.target),
      action: 'createTodo',
      input: { id: input.id, text: 'x'.repeat(input.payloadBytes) },
    },
  ],
})

export const todoScenarioGenerators = {
  distributedTodos,
  largePayloadTodo,
  todoSeries,
} as const

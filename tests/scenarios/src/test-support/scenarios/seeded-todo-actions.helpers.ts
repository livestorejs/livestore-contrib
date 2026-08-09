import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, defineScenarioHelpers, helperActions } from '../../yaml/helpers.ts'

const seededTodoActions = defineScenarioHelper({
  input: Schema.Struct({ target: Schema.String, count: Schema.Int }),
  generate: ({ input, context }) =>
    helperActions(
      Array.from({ length: input.count }, (_, offset) => {
        const item = offset + 1
        return {
          target: context.participant(input.target),
          action: 'createTodo',
          input: {
            id: `seeded-todo-${String(item).padStart(3, '0')}`,
            text: `Seeded task ${item} · variant ${context.random.iteration(item).integer('text-variant', 1_000)}`,
          },
        }
      }),
    ),
})

export default defineScenarioHelpers({ seededTodoActions })

import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, defineScenarioHelpers, helperActions } from '../helpers.ts'

const sidecarEcho = defineScenarioHelper({
  input: Schema.Struct({
    target: Schema.String,
    id: Schema.String,
    text: Schema.String,
  }),
  generate: ({ input, context }) =>
    helperActions([
      {
        target: context.participant(input.target),
        action: 'createTodo',
        input: { id: input.id, text: input.text },
      },
    ]),
})

export default defineScenarioHelpers({ sidecarEcho })

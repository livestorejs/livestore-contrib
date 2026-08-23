import { Tool } from 'effect/unstable/ai'

import { Vitest } from '@livestore/utils-dev/node-vitest'

import { livestoreToolkit } from './mcp-tools-defs.ts'

Vitest.describe('livestoreToolkit', () => {
  Vitest.it('exposes MCP-compatible object parameter schemas', () => {
    for (const tool of Object.values(livestoreToolkit.tools)) {
      Vitest.expect(Tool.getJsonSchema(tool), tool.name).toMatchObject({ type: 'object' })
    }
  })
})

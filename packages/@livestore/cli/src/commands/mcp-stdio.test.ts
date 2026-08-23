import { spawn } from 'node:child_process'

import { Vitest } from '@livestore/utils-dev/node-vitest'

Vitest.describe('mcp server stdio', () => {
  Vitest.it('reserves stdout for JSON-RPC messages', async () => {
    const response = await initialize()

    Vitest.expect(response.result?.protocolVersion).toBe('2025-06-18')
  })
})

/** Exercises the real CLI entrypoint so root-level warnings and logs cannot corrupt MCP framing. */
const initialize = () =>
  new Promise<InitializeResponse>((resolve, reject) => {
    const child = spawn('bun', [new URL('../bin.ts', import.meta.url).pathname, 'mcp', 'server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdoutBuffer = ''
    let stderr = ''
    let settled = false

    const finish = (result: { readonly response: InitializeResponse } | { readonly error: unknown }) => {
      if (settled === true) return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGTERM')
      if ('error' in result) reject(result.error)
      else resolve(result.response)
    }

    const timeout = setTimeout(() => {
      finish({ error: new Error(`MCP initialize timed out. stdout=${stdoutBuffer} stderr=${stderr}`) })
    }, 5_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.length === 0) continue

        try {
          const message = JSON.parse(line) as InitializeResponse
          if (message.jsonrpc !== '2.0') {
            finish({ error: new Error(`MCP stdout contained a non-JSON-RPC message: ${line}`) })
            return
          }
          if (message.id === 1) {
            finish({ response: message })
            return
          }
        } catch (error) {
          finish({ error: new Error(`MCP stdout contained invalid JSON: ${line}`, { cause: error }) })
          return
        }
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ error })
    })
    child.on('exit', (code) => {
      if (settled === false) {
        finish({ error: new Error(`MCP server exited before initialize completed (code ${code}). stderr=${stderr}`) })
      }
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'livestore-mcp-stdio-test', version: '0.0.0' },
        },
      })}\n`,
    )
  })

interface InitializeResponse {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly result?: {
    readonly protocolVersion?: string
  }
}

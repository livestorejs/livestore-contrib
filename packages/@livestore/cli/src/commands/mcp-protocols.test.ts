import { spawn } from 'node:child_process'

import { Vitest } from '@livestore/utils-dev/node-vitest'

import { supportedMcpProtocols } from './mcp-protocols.ts'

const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

Vitest.describe('supportedMcpProtocols', () => {
  Vitest.it('keeps the fallback protocol newest-first', () => {
    Vitest.expect(supportedMcpProtocols.map((protocol) => protocol.protocolVersion)).toEqual(protocolVersions)
  })

  Vitest.it.each(protocolVersions)('negotiates an exact %s stdio initialize offer', async (protocolVersion) => {
    const response = await initialize(protocolVersion)

    Vitest.expect(response.result?.protocolVersion).toBe(protocolVersion)
  })
})

const initialize = (protocolVersion: (typeof protocolVersions)[number]) =>
  new Promise<InitializeResponse>((resolve, reject) => {
    const child = spawn('bun', [new URL('./__fixtures__/mcp-protocol-server.ts', import.meta.url).pathname], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`MCP initialize timed out. stdout=${stdout} stderr=${stderr}`))
    }, 5_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.endsWith('\n') === false) return

      try {
        const response = JSON.parse(stdout.trim()) as InitializeResponse
        clearTimeout(timeout)
        child.kill('SIGTERM')
        resolve(response)
      } catch (error) {
        clearTimeout(timeout)
        child.kill('SIGTERM')
        reject(error)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'livestore-mcp-protocol-test', version: '0.0.0' },
        },
      })}\n`,
    )
  })

interface InitializeResponse {
  readonly result?: {
    readonly protocolVersion?: string
  }
}

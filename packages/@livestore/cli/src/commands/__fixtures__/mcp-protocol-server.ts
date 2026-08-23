import { McpServer } from 'effect/unstable/ai'

import { Effect, Layer } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { supportedMcpProtocols } from '../mcp-protocols.ts'

McpServer.layerStdio({
  name: 'livestore-mcp-protocol-test',
  version: '0.0.0',
  protocols: supportedMcpProtocols,
}).pipe(Layer.provide(PlatformNode.NodeStdio.layer), Layer.launch, Effect.scoped, PlatformNode.NodeRuntime.runMain)

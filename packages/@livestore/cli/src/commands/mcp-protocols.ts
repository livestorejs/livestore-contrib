import { McpProtocol } from 'effect/unstable/ai'

/**
 * MCP stdio selects an exact offered version when available and otherwise
 * falls back to the first adapter, so keep every supported adapter newest-first.
 */
export const supportedMcpProtocols = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const

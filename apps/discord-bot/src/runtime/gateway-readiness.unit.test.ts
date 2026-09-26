import { describe, expect, it } from 'vitest'

import { applyGatewayLifecycle, initialGatewayReadiness, isGatewayReady } from './gateway-readiness.ts'

describe('gateway readiness reducer', () => {
  it('requires every configured shard and withdraws on reconnect', () => {
    let state = initialGatewayReadiness([0, 1])
    state = applyGatewayLifecycle(state, { _tag: 'Connecting', shardId: 0 })
    expect(isGatewayReady(state)).toBe(false)
    state = applyGatewayLifecycle(state, { _tag: 'Ready', shardId: 0 })
    expect(isGatewayReady(state)).toBe(false)
    state = applyGatewayLifecycle(state, { _tag: 'Ready', shardId: 1 })
    expect(isGatewayReady(state)).toBe(true)
    state = applyGatewayLifecycle(state, { _tag: 'Disconnected', shardId: 0, retryable: true })
    expect(isGatewayReady(state)).toBe(false)
    state = applyGatewayLifecycle(state, { _tag: 'Resumed', shardId: 0 })
    expect(isGatewayReady(state)).toBe(true)
  })

  it('treats duplicate and out-of-order lifecycle events idempotently', () => {
    let state = initialGatewayReadiness([3])
    state = applyGatewayLifecycle(state, { _tag: 'Resumed', shardId: 3 })
    state = applyGatewayLifecycle(state, { _tag: 'Resumed', shardId: 3 })
    state = applyGatewayLifecycle(state, { _tag: 'Ready', shardId: 3 })
    expect(isGatewayReady(state)).toBe(true)
  })
})

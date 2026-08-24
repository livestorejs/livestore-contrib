import type { GatewayLifecycleEvent } from "dfx/DiscordGateway"

export interface GatewayReadinessState {
  readonly expectedShardIds: ReadonlySet<number>
  readonly readyShardIds: ReadonlySet<number>
}

export const initialGatewayReadiness = (
  expectedShardIds: Iterable<number> = [],
): GatewayReadinessState => ({
  expectedShardIds: new Set(expectedShardIds),
  readyShardIds: new Set(),
})

/** Applies DFX lifecycle events without relying on dispatch replay or allocation. */
export const applyGatewayLifecycle = (
  state: GatewayReadinessState,
  event: GatewayLifecycleEvent,
): GatewayReadinessState => {
  const expectedShardIds = new Set(state.expectedShardIds).add(event.shardId)
  const readyShardIds = new Set(state.readyShardIds)
  if (event._tag === "Ready" || event._tag === "Resumed") {
    readyShardIds.add(event.shardId)
  } else {
    readyShardIds.delete(event.shardId)
  }
  return { expectedShardIds, readyShardIds }
}

export const isGatewayReady = (state: GatewayReadinessState): boolean =>
  state.expectedShardIds.size > 0 &&
  [...state.expectedShardIds].every(id => state.readyShardIds.has(id))

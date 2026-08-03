import type { LeaderStateSource, ReconstructedLeaderState } from './leader-state.ts'
import { leaderStateCacheKey } from './leader-state.ts'
import type { MaterializeResponse } from './leader-state.worker.ts'

interface PendingRequest {
  readonly resolve: (state: ReconstructedLeaderState) => void
  readonly reject: (cause: Error) => void
}

let worker: Worker | undefined
let requestSequence = 0
const pending = new Map<number, PendingRequest>()
const cache = new Map<string, Promise<ReconstructedLeaderState>>()

export const requestLeaderStateMaterialization = (source: LeaderStateSource): Promise<ReconstructedLeaderState> => {
  const key = leaderStateCacheKey(source)
  const existing = cache.get(key)
  if (existing !== undefined) return existing
  const materializing = requestFromWorker(source).catch((cause: unknown) => {
    cache.delete(key)
    throw cause
  })
  cache.set(key, materializing)
  return materializing
}

const requestFromWorker = (source: LeaderStateSource): Promise<ReconstructedLeaderState> => {
  worker ??= makeWorker()
  requestSequence += 1
  const id = requestSequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, source })
  })
}

const makeWorker = (): Worker => {
  const nextWorker = new Worker(new URL('./leader-state.worker.ts', import.meta.url), { type: 'module' })
  nextWorker.addEventListener('message', (event: MessageEvent<MaterializeResponse>) => {
    const request = pending.get(event.data.id)
    if (request === undefined) return
    pending.delete(event.data.id)
    if (event.data.status === 'success') request.resolve(event.data.state)
    else request.reject(new Error(event.data.message))
  })
  nextWorker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Leader State reconstruction worker failed')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    worker = undefined
  })
  return nextWorker
}

export const clearLeaderStateMaterializationCache = (): void => {
  cache.clear()
}

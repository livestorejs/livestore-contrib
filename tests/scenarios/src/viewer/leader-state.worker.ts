/// <reference lib="webworker" />

import { materializeLeaderState } from './leader-state-materialization.ts'
import type { LeaderStateSource, ReconstructedLeaderState } from './leader-state.ts'

interface MaterializeRequest {
  readonly id: number
  readonly source: LeaderStateSource
}

export type MaterializeResponse =
  | { readonly id: number; readonly status: 'success'; readonly state: ReconstructedLeaderState }
  | { readonly id: number; readonly status: 'error'; readonly message: string }

self.addEventListener('message', (event: MessageEvent<MaterializeRequest>) => {
  const { id, source } = event.data
  void materializeLeaderState(source)
    .then((state) => self.postMessage({ id, status: 'success', state } satisfies MaterializeResponse))
    .catch((cause: unknown) =>
      self.postMessage({
        id,
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      } satisfies MaterializeResponse),
    )
})

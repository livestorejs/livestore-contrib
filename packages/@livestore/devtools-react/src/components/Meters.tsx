import type { Devtools } from '@livestore/common'
import * as LiveStore from '@livestore/livestore'
import type { ReactiveGraph } from '@livestore/livestore/internal'
import { ref } from '@livestore/utils'
import { Effect, Stream } from '@livestore/utils/effect'
import React from 'react'

import { withParallelFinalizers } from '../effect/with-parallel-finalizers.js'
import { useSessionContext } from '../session-context.js'
import { cn } from '../utils/utils.js'
import {
  FRAME_MISS,
  makeFpsMeterBlock,
  makePolyValueMeterBlock,
  makeValueMeterBlock,
  MeterGrid,
  sumOfRec,
} from './meters/mod.ts'

const BLOCK_HEIGHT = 26
const BLOCK_WIDTH = 120

const emptyDebugInfo = LiveStore.emptyDebugInfo()
const latestDebugInfoHistoryQueueRef = ref<LiveStore.MutableDebugInfo[]>([])
const latestDebugInfoRef = ref<LiveStore.MutableDebugInfo>(emptyDebugInfo)

const latestGraphsnapshotRef = ref<ReactiveGraph.ReactiveGraphSnapshot | undefined>(undefined)
const liveQueriesRef = ref<ReadonlyArray<typeof Devtools.ClientSession.SerializedLiveQuery.Type>>(
  [],
)

export const Meters: React.FC<{
  className?: string
  onClick?: (e: React.MouseEvent) => void
}> = ({ className, onClick }) => {
  const pauseRenderingRef = React.useRef(false)

  React.useEffect(() => {
    let hasStopped = false
    let rafHandle: number | undefined

    const tick = () => {
      latestDebugInfoRef.current = latestDebugInfoHistoryQueueRef.current.shift() ?? emptyDebugInfo
      if (!hasStopped) {
        rafHandle = requestAnimationFrame(tick)
      }
    }

    rafHandle = requestAnimationFrame(tick)

    return () => {
      hasStopped = true
      if (rafHandle !== undefined) {
        cancelAnimationFrame(rafHandle)
      }
    }
  }, [])

  const { apiSession } = useSessionContext()

  React.useEffect(
    () =>
      Effect.gen(function* () {
        yield* apiSession.signalSnapshots().pipe(
          Stream.tapSync((snapshot) => {
            latestGraphsnapshotRef.current = snapshot
          }),
          Stream.runDrain,
          Effect.tapCauseLogPretty,
          Effect.forkScoped,
        )

        yield* apiSession.liveQueries().pipe(
          Stream.tapSync((queries) => {
            liveQueriesRef.current = queries
          }),
          Stream.runDrain,
          Effect.tapCauseLogPretty,
          Effect.forkScoped,
        )

        yield* apiSession.debugInfoHistory.pipe(
          Stream.tapSync((debugInfo) => {
            latestDebugInfoHistoryQueueRef.current.push({ ...debugInfo })
          }),
          Stream.runDrain,
          Effect.tapCauseLogPretty,
          Effect.forkScoped,
        )

        return yield* Effect.never
      }).pipe(withParallelFinalizers, Effect.tapCauseLogPretty, Effect.runCallback),
    [apiSession],
  )

  const blocks3 = React.useMemo(
    () => [makeLiveStoreMutationsMeter(), makeLiveStoreAtomsMeter()],
    [],
  )
  const blocks2 = React.useMemo(() => [makeLiveStoreLiveQueriesMeter(), makeQueryCountMeter()], [])

  const blocks1 = React.useMemo(
    () => [
      makeFpsMeterBlock({ height: BLOCK_HEIGHT, width: BLOCK_WIDTH }),
      makeQueryDurationMeter(),
    ],
    [],
  )

  // TODO add a meter for in-flight background work such as sync pulls and image decoding.

  return (
    <div
      role="application"
      className={cn('flex space-x-0.5 h-[126px] overflow-auto', className)}
      onMouseEnter={() => {
        pauseRenderingRef.current = true
      }}
      onMouseLeave={() => {
        pauseRenderingRef.current = false
      }}
    >
      <MeterGrid
        blocks={blocks3}
        {...(onClick !== undefined ? { onClick } : {})}
        gap={2}
        pauseRenderingRef={pauseRenderingRef}
      />
      <MeterGrid
        blocks={blocks2}
        {...(onClick !== undefined ? { onClick } : {})}
        gap={2}
        pauseRenderingRef={pauseRenderingRef}
      />
      <MeterGrid
        blocks={blocks1}
        {...(onClick !== undefined ? { onClick } : {})}
        gap={2}
        pauseRenderingRef={pauseRenderingRef}
      />
    </div>
  )
}

const makeQueryCountMeter = () =>
  makeValueMeterBlock({
    height: BLOCK_HEIGHT,
    width: BLOCK_WIDTH,
    getFrameValue: () => {
      const debugInfo = latestDebugInfoRef.current
      const value = debugInfo.queryFrameCount
      debugInfo.queryFrameCount = 0
      return value
    },
    textMode: 'sum-last-sec',
    getText: (value) => `${value} queries / sec`,
    getFrameColor: (value) => (value > 20 ? RED : value > 10 ? YELLOW : GREEN),
  })

const makeQueryDurationMeter = () =>
  makeValueMeterBlock({
    height: BLOCK_HEIGHT,
    width: BLOCK_WIDTH,
    getFrameValue: () => {
      const debugInfo = latestDebugInfoRef.current
      const value = debugInfo.queryFrameDuration
      debugInfo.queryFrameDuration = 0
      return value
    },
    textMode: 'max',
    getText: (value) => `max ${value.toFixed(2)} ms / frame`,
    getFrameColor: (value) => (value > 10 ? RED : value > 5 ? YELLOW : GREEN),
  })

const makeLiveStoreMutationsMeter = () =>
  makeValueMeterBlock({
    height: BLOCK_HEIGHT,
    width: BLOCK_WIDTH,
    getFrameValue: () => {
      const value = window.tmpLiveStoreMutationCount
      window.tmpLiveStoreMutationCount = 0
      return value
    },
    textMode: 'sum-last-sec',
    getText: (value) => `${value} events / sec`,
    getFrameColor: (value) => (value > 10 ? RED : value > 5 ? YELLOW : GREEN),
  })

const makeLiveStoreAtomsMeter = () => {
  const uninitializedValue = {
    refs: 0,
    thunks: 0,
    effects: 0,
  }

  const colorMap = {
    refs: `hsla(220, 100%, 50%, 0.5)`,
    thunks: `hsla(180, 100%, 50%, 0.5)`,
    effects: `hsla(60, 100%, 50%, 0.5)`,
  }

  return makePolyValueMeterBlock({
    height: BLOCK_HEIGHT,
    width: BLOCK_WIDTH,
    getFrameValue: () => {
      let refs = 0
      let thunks = 0
      const effects = latestGraphsnapshotRef.current?.effects.length ?? 0

      if (latestGraphsnapshotRef.current !== undefined) {
        for (const atom of latestGraphsnapshotRef.current.atoms) {
          if (atom._tag === 'ref') {
            refs++
          } else if (atom._tag === 'thunk') {
            thunks++
          }
        }
      }

      return { refs, thunks, effects }
    },
    getTextLines: (values) => {
      const lastVal = values.at(-1)!
      if (lastVal === FRAME_MISS) return []
      const total = sumOfRec(lastVal)
      return [`${total} nodes`]
    },
    uninitializedValue,
    getValColor: (_value, key) => colorMap[key]!,
  })
}

const makeLiveStoreLiveQueriesMeter = () => {
  const uninitializedValue = {
    computed: 0,
    sql: 0,
    graphql: 0,
  }

  const greenColorMap = {
    computed: `hsla(195, 100%, 50%, 0.5)`,
    sql: `hsla(185, 100%, 50%, 0.5)`,
    graphql: `hsla(95, 100%, 50%, 0.5)`,
  }

  const yellowColorMap = {
    computed: `hsla(35, 100%, 50%, 1)`,
    sql: `hsla(55, 100%, 50%, 1)`,
    graphql: `hsla(75, 100%, 50%, 1)`,
  }

  const redColorMap = {
    computed: `hsla(340, 100%, 50%, 1)`,
    sql: `hsla(360, 100%, 50%, 1)`,
    graphql: `hsla(20, 100%, 50%, 1)`,
  }

  return makePolyValueMeterBlock({
    height: BLOCK_HEIGHT,
    width: BLOCK_WIDTH,
    getFrameValue: () => {
      let db = 0
      let computed = 0
      let graphql = 0
      let signal = 0
      const incrementByTag = (tag: 'db' | 'computed' | 'graphql' | 'signal') =>
        ({
          db: () => db++,
          computed: () => computed++,
          graphql: () => graphql++,
          signal: () => signal++,
        })[tag]()

      for (const query of liveQueriesRef.current) {
        incrementByTag(query._tag)
      }

      return { computed, sql: db, graphql }
    },
    getTextLines: (values) => {
      const lastVal = values.at(-1)!
      if (lastVal === FRAME_MISS) return []
      const total = sumOfRec(lastVal)
      return [`${total} live queries`]
    },
    uninitializedValue,
    getValColor: (value, key) =>
      value > 50 ? redColorMap[key]! : value > 40 ? yellowColorMap[key]! : greenColorMap[key]!,
  })
}

const RED = 'rgba(255, 0, 0, 0.9)'
const YELLOW = 'rgba(255, 255, 0, 0.5)'
const GREEN = 'rgba(0, 255, 0, 0.3)'

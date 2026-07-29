import type { EventDef } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import type { HistoryDag, HistoryDagNode, RebaseFn } from '@livestore/common/sync/next'
import {
  compareEventSequenceNumbers,
  defaultRebaseFn,
  factsIntersect,
  factsSnapshotForDag,
  getFactsGroupForEventArgs,
  historyDagFromNodes,
  rebaseEvents,
} from '@livestore/common/sync/next'
import React from 'react'

import { DagGraph } from './CompactionDebugger.js'

export const RebaseDebugger: React.FC<{
  syncedDag: HistoryDag
  previousSyncHead: EventSequenceNumber.Client.Composite
  pendingDag: HistoryDag
  rebaseFn?: RebaseFn
  eventDefs: Record<string, EventDef.Any>
}> = ({ syncedDag, previousSyncHead, pendingDag, rebaseFn = defaultRebaseFn, eventDefs }) => {
  const conflicts = React.useMemo(
    () => getConflicts(syncedDag, pendingDag, previousSyncHead),
    [syncedDag, pendingDag, previousSyncHead],
  )

  React.useEffect(() => {
    for (const conflict of conflicts) {
      const event = pendingDag.getNodeAttributes(
        EventSequenceNumber.Client.toString(conflict.pending[0]!.seqNum),
      )
      event.meta = { ...event.meta, className: 'border-2 border-red-500 bg-red-200' }
    }
  }, [conflicts, pendingDag])

  const rebasedDag = React.useMemo<
    { _tag: 'dag'; dag: HistoryDag } | { _tag: 'error'; error: any }
  >(() => {
    try {
      const dag = getRebasedDag({ syncedDag, pendingDag, previousSyncHead, eventDefs, rebaseFn })
      return { _tag: 'dag', dag }
    } catch (error: any) {
      console.error('Error in getRebasedDag:', error)
      return { _tag: 'error', error: error.toString() }
    }
  }, [syncedDag, pendingDag, previousSyncHead, eventDefs, rebaseFn])

  return (
    <div className="flex gap-2 w-full h-full">
      <WithHeader label="Synced">
        <DagGraph dag={syncedDag} />
      </WithHeader>
      <WithHeader
        label={`Pending (head: ${EventSequenceNumber.Client.toString(previousSyncHead)})`}
      >
        <div className="text-white">
          {conflicts.map(({ remote, pending }) => (
            <div key={EventSequenceNumber.Client.toString(remote.seqNum)}>
              <h3>Conflicts</h3>
              Remote: {remote.name}({EventSequenceNumber.Client.toString(remote.seqNum)}) Pending:{' '}
              {pending
                .map(
                  (pending) =>
                    `${pending.name}(${EventSequenceNumber.Client.toString(pending.seqNum)})`,
                )
                .join(', ')}
            </div>
          ))}
        </div>
        <DagGraph dag={pendingDag} />
      </WithHeader>
      <WithHeader label="Rebased">
        {rebasedDag._tag === 'error' ? (
          <pre className="flex justify-center items-center bg-red-500 text-white p-2">
            {rebasedDag.error}
          </pre>
        ) : (
          <DagGraph dag={rebasedDag.dag} />
        )}
      </WithHeader>
    </div>
  )
}

const WithHeader = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <div className="flex flex-col gap-2 w-full">
    <h3 className="text-white text-xl font-bold">{label}</h3>
    {children}
  </div>
)

const getConflicts = (
  syncedDag: HistoryDag,
  pendingDag: HistoryDag,
  previousSyncHead: EventSequenceNumber.Client.Composite,
): ReadonlyArray<{ remote: HistoryDagNode; pending: HistoryDagNode[] }> => {
  // TODO use dag instead
  const remoteEvents = Array.from(syncedDag.nodeEntries())
    .map((_) => _.attributes)
    .filter((_) => compareEventSequenceNumbers(_.seqNum, previousSyncHead) > 0)
  const pendingNodes = Array.from(pendingDag.nodeEntries())
    .map((_) => _.attributes)
    .filter((_) => compareEventSequenceNumbers(_.seqNum, previousSyncHead) > 0)

  return remoteEvents
    .map((remote) => ({
      remote,
      pending: pendingNodes.filter((pending) =>
        factsIntersect(pending.factsGroup.modifySet, remote.factsGroup.modifySet),
      ),
    }))
    .filter((_) => _.pending.length > 0)
}

// TODO support clientOnly mutations
const getRebasedDag = ({
  syncedDag,
  pendingDag,
  previousSyncHead,
  eventDefs,
  rebaseFn,
}: {
  syncedDag: HistoryDag
  pendingDag: HistoryDag
  previousSyncHead: EventSequenceNumber.Client.Composite
  eventDefs: Record<string, EventDef.Any>
  rebaseFn: RebaseFn
}): HistoryDag => {
  const currentFactsSnapshot = factsSnapshotForDag(syncedDag, previousSyncHead)

  const syncedNodes = Array.from(syncedDag.nodeEntries())
    .map((_) => ({ ..._.attributes, meta: { style: { opacity: 0.5 } } }))
    .sort((a, b) => compareEventSequenceNumbers(a.seqNum, b.seqNum))
  const pendingNodes = Array.from(pendingDag.nodeEntries())
    .map((_) => ({ ..._.attributes }))
    .sort((a, b) => compareEventSequenceNumbers(a.seqNum, b.seqNum))
    .filter((_) => compareEventSequenceNumbers(_.seqNum, previousSyncHead) > 0)

  const clientId = 'client-id'
  const sessionId = 'session-id'

  const rebasedEvents = rebaseEvents({
    rebaseFn,
    pendingLocalEvents: pendingNodes,
    newRemoteEvents: syncedNodes,
    currentFactsSnapshot,
    clientId,
    sessionId,
  }).map(
    (_) =>
      ({
        seqNum: _.seqNum,
        parentSeqNum: _.parentSeqNum,
        name: _.name,
        args: _.args,
        factsGroup: getFactsGroupForEventArgs({
          factsCallback: eventDefs[_.name]!.options.facts,
          args: _.args,
          currentFacts: new Map(),
        }),
        clientId,
        sessionId,
      }) satisfies HistoryDagNode,
  )

  return historyDagFromNodes([...syncedNodes, ...rebasedEvents])
}

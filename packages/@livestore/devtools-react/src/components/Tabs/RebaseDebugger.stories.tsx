import type { LiveStoreEvent } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import {
  type HistoryDagNode,
  historyDagFromNodes,
  type RebaseFn,
} from '@livestore/common/sync/next'
import type { PartialEvent } from '@livestore/common/sync/next/test'
import { events, facts, toEventNodes } from '@livestore/common/sync/next/test'
import type { Meta, StoryObj } from '@storybook/react'
import type React from 'react'

import { RebaseDebugger } from './RebaseDebugger.js'

const fadeOldEvents = (
  events: HistoryDagNode[],
  previousSyncHead: EventSequenceNumber.Client.Composite,
) => {
  return events.map((event, index) => {
    if (index <= previousSyncHead.global + 1) {
      event.meta = { ...event.meta, style: { opacity: 0.5 } }
    }
    return event
  })
}

const TestComponent: React.FC<{
  synced: PartialEvent[]
  pending: PartialEvent[]
  previousSyncHead: EventSequenceNumber.Client.Composite
  rebaseFn?: RebaseFn
}> = ({ synced, pending, previousSyncHead, rebaseFn }) => {
  const syncedEventNodes = fadeOldEvents(
    toEventNodes(synced, events, 'client-id', 'session-id'),
    previousSyncHead,
  )
  const pendingEventNodes = fadeOldEvents(
    toEventNodes(
      [...synced.slice(0, previousSyncHead.global + 1), ...pending],
      events,
      'client-id',
      'session-id',
    ),
    previousSyncHead,
  )

  console.log('syncedEventNodes', syncedEventNodes)
  console.log('pendingEventNodes', pendingEventNodes)

  return (
    <RebaseDebugger
      syncedDag={historyDagFromNodes(syncedEventNodes)}
      pendingDag={historyDagFromNodes(pendingEventNodes)}
      previousSyncHead={previousSyncHead}
      eventDefs={events}
      {...(rebaseFn !== undefined ? { rebaseFn } : {})}
    />
  )
}

const meta: Meta<typeof TestComponent> = {
  title: 'DevTools Tabs/Sync/RebaseDebugger',
  component: TestComponent,
  parameters: {
    backgrounds: { default: 'dark' },
  },
}

export default meta

const defineStory = (story: StoryObj<Meta<typeof TestComponent>>) => story

const ignoreConflictingToggleEvents: RebaseFn = ({ pendingLocalEvents }) => ({
  rebasedLocalEvents: pendingLocalEvents.filter((event) =>
    event.name === 'toggleTodo'
      ? event.conflictingEvents.some(
          (conflictingEvent) =>
            conflictingEvent.name === 'todoCompleted' ||
            conflictingEvent.name === 'todoUncompleted',
        ) === false
      : true,
  ),
})

const ensureTodosBecomeWriteableBeforeRebasing: RebaseFn = ({ pendingLocalEvents, validate }) => {
  const rebasedLocalEvents: LiveStoreEvent.Input.Decoded[] = []

  for (const event of pendingLocalEvents) {
    const validationResult = validate({
      rebasedLocalEvents: [...rebasedLocalEvents, event],
      eventDefs: events,
    })

    if (validationResult.success === true) {
      rebasedLocalEvents.push(event)
      continue
    }

    if (event.name === 'todoCompleted' || event.name === 'todoUncompleted') {
      const id = event.args.id

      if (validationResult.mismatch.required.get(facts.todoIsWriteable(id, true)[0]) === false) {
        rebasedLocalEvents.push(events.setReadonlyTodo({ id, readonly: false }))
      }

      rebasedLocalEvents.push(event)
    }
  }

  return { rebasedLocalEvents }
}

export const Basic: StoryObj<typeof meta> = defineStory({
  args: {
    synced: [
      events.createTodo({ id: 'A', text: 'buy milk' }), // 0
      // client goes offline here
      events.createTodo({ id: 'B', text: 'buy bread' }), // 1
      events.todoCompleted({ id: 'A' }), // 2
    ],
    pending: [events.toggleTodo({ id: 'A' })], // 3 after rebase
    previousSyncHead: EventSequenceNumber.Client.Composite.make({ global: 0, client: 0 }),
    rebaseFn: ignoreConflictingToggleEvents,
  },
})

export const Basic2: StoryObj<typeof meta> = defineStory({
  args: {
    synced: [
      events.createTodo({ id: 'A', text: 'buy milk' }), // 0
      events.createTodo({ id: 'B', text: 'buy bread' }), // 1
      events.todoCompleted({ id: 'A' }), // 2
    ],
    pending: [events.todoUncompleted({ id: 'A' })], // 3 after rebase
    previousSyncHead: EventSequenceNumber.Client.Composite.make({ global: 0, client: 0 }),
  },
})

export const CustomRebaseFn: StoryObj<typeof meta> = defineStory({
  args: {
    synced: [
      events.createTodo({ id: 'A', text: 'buy milk' }), // 0
      events.createTodo({ id: 'B', text: 'buy bread' }), // 1
      events.todoCompleted({ id: 'A' }), // 2
      events.setReadonlyTodo({ id: 'A', readonly: true }), // 3
    ],
    pending: [events.todoUncompleted({ id: 'A' })], // 4 after rebase
    previousSyncHead: EventSequenceNumber.Client.Composite.make({ global: 0, client: 0 }),
    // TODO provide an easy way to check for required facts during rebasing
    rebaseFn: ensureTodosBecomeWriteableBeforeRebasing,
  },
})

import {
  Scenario,
  alias,
  client,
  disconnect,
  eventlogsConverge,
  note,
  pad,
  parameter,
  pendingResolved,
  reconnect,
  repeat,
  settle,
  stateContainsIds,
  stateConverges,
  wait,
} from '../../../../scenario.ts'
import { todo } from '../../../applications/todo.ts'

/**
 * Builds a UI responsiveness stress Scenario. Client `ui` renders a React view of every todo. It goes offline, may
 * commit a pending tail, and reconnects after `writer` confirmed a large history. The Scenario then waits without
 * driving any page, so frame measurements during the wait show what applying the pull costs the UI's main thread:
 * a large catch-up when nothing is pending, a large rebase of the pending tail otherwise.
 */
export const uiSyncLoadScenario = (defaults: {
  readonly remoteCount: number
  readonly pendingCount: number
  readonly seed: number
  readonly about: string
}) =>
  Scenario.parameterized(
    {
      remote_count: parameter.integer(defaults.remoteCount),
      pending_count: parameter.integer(defaults.pendingCount),
      batch_size: parameter.integer(100),
      text_bytes: parameter.integer(64),
      quiet_ms: parameter.integer(45_000),
    },
    ({ remote_count, pending_count, batch_size, text_bytes, quiet_ms }) => {
      const uiClient = client('ui').withSessions('ui-session')
      const writerClient = client('writer').withSessions('writer-session')
      const ui = uiClient.session('ui-session')
      const writer = writerClient.session('writer-session')
      const both = alias([ui, writer])
      const batches = (count: number) =>
        Array.from({ length: Math.ceil(count / batch_size) }, (_, index) => ({
          start: index * batch_size + 1,
          count: Math.min(batch_size, count - index * batch_size),
        }))
      const createBatches = (idPrefix: string, count: number, target: typeof ui) =>
        batches(count).map(({ start, count: batchCount }) =>
          todo.createTodos({ idPrefix, start, count: batchCount, textBytes: text_bytes }).as(target),
        )
      const expectedIds = [
        `remote-${pad(1, 6)}`,
        `remote-${pad(remote_count, 6)}`,
        ...(pending_count > 0 ? [`pending-${pad(1, 6)}`, `pending-${pad(pending_count, 6)}`] : []),
      ]

      return Scenario.start({
        application: todo,
        seed: defaults.seed,
        about: defaults.about,
        clients: [uiClient, writerClient],
      })
        .steps(
          note('The UI Client goes offline; anything it commits now stays pending.'),
          disconnect(uiClient),
          ...(pending_count > 0 ? [repeat(createBatches('pending', pending_count, ui))] : []),
          repeat(createBatches('remote', remote_count, writer)),
          settle(writer),
          note('The UI Client reconnects. The harness stays idle while it applies the pull and re-renders.'),
          reconnect(uiClient),
          wait(quiet_ms),
        )
        .expect(
          pendingResolved(both),
          eventlogsConverge(both),
          stateConverges('todos', both),
          stateContainsIds('todos', expectedIds, both),
        )
    },
  )

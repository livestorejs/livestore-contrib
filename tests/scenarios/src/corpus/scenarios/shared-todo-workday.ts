import { defineScenario, type ParticipantRef, type ScenarioStep } from '../../model.ts'
/* eslint-disable func-style -- hoisted builders keep the exported scenario at the top of the module. */
import { todoApplication } from '../applications/todo.ts'

const aliceLaptop = { clientId: 'alice-laptop', sessionId: 'alice-laptop-session' } as const
const alicePhone = { clientId: 'alice-phone', sessionId: 'alice-phone-session' } as const
const bobLaptop = { clientId: 'bob-laptop', sessionId: 'bob-laptop-session' } as const
const allParticipants = [aliceLaptop, alicePhone, bobLaptop] as const
const onlineDuringCommute = [aliceLaptop, bobLaptop] as const
const settlementTimeoutMs = 15_000
let nextTodoNumber = 1

const morning = makePhaseActions({
  phase: 'morning',
  targets: [aliceLaptop],
  counts: { create: 18, edit: 2, complete: 2, reopen: 0, delete: 0 },
})

const triage = makePhaseActions({
  phase: 'triage',
  targets: [aliceLaptop, bobLaptop],
  counts: { create: 8, edit: 8, complete: 7, reopen: 2, delete: 0 },
})

const phoneCommute = makePhaseActions({
  phase: 'commute-phone',
  targets: [alicePhone],
  counts: { create: 2, edit: 4, complete: 3, reopen: 2, delete: 1 },
  hotspotIds: ['todo-04', 'todo-08', 'todo-12', 'todo-16'],
})
const offlinePhoneActions = phoneCommute.filter((_, index) => index < 5 || index === 6)
const recoveredPhoneActions = phoneCommute.filter((_, index) => index === 5 || index > 6)

const officeDuringCommute = makePhaseActions({
  phase: 'commute-office',
  targets: [aliceLaptop, bobLaptop],
  counts: { create: 2, edit: 6, complete: 5, reopen: 2, delete: 3 },
  hotspotIds: ['todo-04', 'todo-08', 'todo-12', 'todo-16'],
})

const cleanup = makePhaseActions({
  phase: 'cleanup',
  targets: allParticipants,
  counts: { create: 0, edit: 8, complete: 7, reopen: 2, delete: 6 },
})

/** A deterministic, representative workload: 100 application events across a collaborative day. */
export const sharedTodoWorkday = defineScenario({
  version: 1,
  id: 'shared-todo-workday',
  description:
    'Alice uses a laptop and a phone that stays offline through the middle of a collaborative 100-event workday with Bob.',
  tags: ['sync', 'workload', 'offline', 'collaboration', 'rebase', '100-events'],
  seed: 1442,
  applicationId: todoApplication.id,
  requires: ['multiple-clients', 'named-actions', 'disconnect-reconnect', 'sync-observation', 'state-inspection'],
  topology: {
    storeId: 'scenario-shared-todo-workday',
    clients: [
      { id: aliceLaptop.clientId, sessions: [aliceLaptop.sessionId], initiallyConnected: true },
      { id: alicePhone.clientId, sessions: [alicePhone.sessionId], initiallyConnected: true },
      { id: bobLaptop.clientId, sessions: [bobLaptop.sessionId], initiallyConnected: true },
    ],
  },
  phases: [
    {
      id: 'morning-planning',
      description: '09:00 — Alice plans the day on her laptop and refines the first tasks.',
      steps: [...morning, settle('settle-morning', allParticipants, [], settlementTimeoutMs)],
    },
    {
      id: 'team-triage',
      description: '10:30 — Alice and Bob begin triaging shared work while every Client remains online.',
      steps: withSettlementCheckpoints({
        actions: triage.slice(0, 11),
        every: 1,
        idPrefix: 'triage',
        participants: allParticipants,
        timeoutMs: settlementTimeoutMs,
      }),
    },
    {
      id: 'offline-commute',
      description:
        '12:00 — Alice keeps working on her offline phone while both online laptops change several of the same hotspot todos.',
      steps: makeOfflineCommuteSteps(),
    },
    {
      id: 'phone-recovery',
      description: '14:00 — Alice reconnects her phone and rebases the work accumulated through the middle of the day.',
      steps: [
        { _tag: 'reconnect', id: 'reconnect-alice-phone', clientId: alicePhone.clientId },
        settle('settle-after-phone-reconnect', allParticipants, [], settlementTimeoutMs),
      ],
    },
    {
      id: 'afternoon-cleanup',
      description: '15:30 — All three participants finish, reopen, edit, and remove work before the day ends.',
      steps: withSettlementCheckpoints({
        actions: interleaveMany([recoveredPhoneActions, officeDuringCommute.slice(14), cleanup]),
        every: 1,
        idPrefix: 'cleanup',
        participants: allParticipants,
        timeoutMs: settlementTimeoutMs,
      }),
    },
  ],
  oracles: [
    { _tag: 'pending-resolution', id: 'pending-resolved', participants: allParticipants },
    { _tag: 'eventlog-convergence', id: 'eventlogs-converged', participants: allParticipants },
    {
      _tag: 'state-convergence',
      id: 'todo-state-converged',
      participants: allParticipants,
      inspector: 'todos',
    },
  ],
})

interface PhaseActionCounts {
  readonly create: number
  readonly edit: number
  readonly complete: number
  readonly reopen: number
  readonly delete: number
}

interface MakePhaseActionsArgs {
  readonly phase: string
  readonly targets: ReadonlyArray<ParticipantRef>
  readonly counts: PhaseActionCounts
  readonly hotspotIds?: ReadonlyArray<string>
}

/** Expands a workload pattern into ordinary serializable action steps before execution. */
function makePhaseActions({ phase, targets, counts, hotspotIds = [] }: MakePhaseActionsArgs): ScenarioStep[] {
  const baselineIds = Array.from({ length: Math.max(0, nextTodoNumber - 1) }, (_, index) => todoId(index + 1))
  const createdIds = Array.from({ length: counts.create }, () => todoId(nextTodoNumber++))
  const otherKinds = [
    ...Array.from({ length: counts.edit }, () => 'edit' as const),
    ...Array.from({ length: counts.complete }, () => 'complete' as const),
    ...Array.from({ length: counts.reopen }, () => 'reopen' as const),
    ...Array.from({ length: counts.delete }, () => 'delete' as const),
  ]
  const shuffledKinds = seededShuffle(
    [...Array.from({ length: counts.create }, () => 'create' as const), ...otherKinds],
    hashString(`${phase}:1442`),
  )
  // The first phase must establish rows before it can edit them. Later phases
  // may interleave creates freely because their mutations target baseline rows.
  const kinds =
    baselineIds.length === 0
      ? [...createdIds.map(() => 'create' as const), ...seededShuffle(otherKinds, 1442)]
      : shuffledKinds
  const availableIds = baselineIds.length === 0 ? createdIds : baselineIds
  const deletableIds = seededShuffle(
    availableIds.filter((id) => hotspotIds.includes(id) === false),
    hashString(`${phase}:delete`),
  )
  let deleteIndex = 0
  let existingIndex = 0
  let createIndex = 0

  return kinds.map((kind, index) => {
    const target = targets[index % targets.length]!
    const id =
      kind === 'create'
        ? createdIds[createIndex++]!
        : kind === 'delete'
          ? deletableIds[deleteIndex++ % Math.max(1, deletableIds.length)]!
          : pickExistingId({ availableIds, hotspotIds, index: existingIndex++ })
    const stepId = `${phase}-${String(index + 1).padStart(2, '0')}-${kind}`

    switch (kind) {
      case 'create':
        return action(stepId, target, 'createTodo', { id, text: `Task ${id.slice(5)} created during ${phase}` })
      case 'edit':
        return action(stepId, target, 'editTodo', { id, text: `${id} revised during ${phase} #${index + 1}` })
      case 'complete':
        return action(stepId, target, 'setTodoCompleted', { id, completed: true })
      case 'reopen':
        return action(stepId, target, 'setTodoCompleted', { id, completed: false })
      case 'delete':
        return action(stepId, target, 'deleteTodo', { id })
    }
  })
}

function pickExistingId(args: {
  readonly availableIds: ReadonlyArray<string>
  readonly hotspotIds: ReadonlyArray<string>
  readonly index: number
}): string {
  const preferred = args.hotspotIds.length > 0 && args.index % 2 === 0 ? args.hotspotIds : args.availableIds
  return preferred[args.index % preferred.length]!
}

function action(
  id: string,
  target: ParticipantRef,
  actionName: string,
  input: Record<string, string | boolean>,
): ScenarioStep {
  return { _tag: 'action', id, target, action: actionName, input }
}

function settle(
  id: string,
  participants: ReadonlyArray<ParticipantRef>,
  healDisconnectedClients: ReadonlyArray<string>,
  timeoutMs: number,
): ScenarioStep {
  return { _tag: 'settle', id, participants, healDisconnectedClients, timeoutMs }
}

function withSettlementCheckpoints(args: {
  readonly actions: ReadonlyArray<ScenarioStep>
  readonly every: number
  readonly idPrefix: string
  readonly participants: ReadonlyArray<ParticipantRef>
  readonly timeoutMs: number
}): ScenarioStep[] {
  const output: ScenarioStep[] = []
  for (let index = 0; index < args.actions.length; index += args.every) {
    output.push(...args.actions.slice(index, index + args.every))
    output.push(
      settle(
        `settle-${args.idPrefix}-${String(index / args.every + 1).padStart(2, '0')}`,
        args.participants,
        [],
        args.timeoutMs,
      ),
    )
  }
  return output
}

function makeOfflineCommuteSteps(): ScenarioStep[] {
  return [
    { _tag: 'disconnect', id: 'disconnect-alice-phone', clientId: alicePhone.clientId },
    ...withSettlementCheckpoints({
      actions: interleaveMany([triage.slice(11), offlinePhoneActions, officeDuringCommute.slice(0, 14)]),
      every: 1,
      idPrefix: 'commute-offline',
      participants: onlineDuringCommute,
      timeoutMs: settlementTimeoutMs,
    }),
  ]
}

/** Round-robins independent activity streams without changing any stream's internal order. */
function interleaveMany(groups: ReadonlyArray<ReadonlyArray<ScenarioStep>>): ScenarioStep[] {
  const output: ScenarioStep[] = []
  const maximumLength = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < maximumLength; index += 1) {
    for (const group of groups) {
      const step = group[index]
      if (step !== undefined) output.push(step)
    }
  }
  return output
}

function todoId(index: number): string {
  return `todo-${String(index).padStart(2, '0')}`
}

function hashString(input: string): number {
  let hash = 2166136261
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return hash >>> 0
}

function seededShuffle<T>(input: ReadonlyArray<T>, seed: number): T[] {
  const output = [...input]
  let state = seed
  const next = (): number => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
  for (let index = output.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(next() * (index + 1))
    ;[output[index], output[swapIndex]] = [output[swapIndex]!, output[index]!]
  }
  return output
}

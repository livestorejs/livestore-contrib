# TypeScript Scenario authoring

Scenario sources are trusted `.scenario.ts` modules. They use an immutable
TypeScript builder, receive normal editor completion and type checking, and
default-export either `Scenario.start(...)` or `Scenario.parameterized(...)`.
The runner does not execute this authoring API. Source is evaluated first and
normalized into the same serializable `ScenarioAst` used by artifacts and every
execution profile.

```text
.scenario.ts module -> immutable ScenarioPlan -> validation and normalization -> ScenarioAst -> runner
```

The filename supplies Scenario identity. `offline-recovery.scenario.ts` becomes
`offline-recovery`; identity, Store ID, capabilities, format versions, and
instruction/oracle IDs are not authored.

## Basic shape

```ts
import { todo } from '../../../applications/todo.ts'
import {
  alias,
  client,
  disconnect,
  eventlogsConverge,
  pendingResolved,
  reconnect,
  Scenario,
} from '../../../../scenario.ts'

const clientA = client('client-a').withSessions('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionA = clientA.session('session-a')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.start({
  application: todo,
  about: 'Client A writes offline, reconnects, and converges with Client B.',
  clients: [clientA, clientB],
})
  .steps(
    disconnect(clientA),
    todo.createTodo({ id: 'offline', text: 'Written offline' }).as(sessionA),
    reconnect(clientA),
  )
  .expect(pendingResolved(both), eventlogsConverge(both))
```

Application methods are inferred from the registered Application definition,
including their input types. A configured Client goes directly into the
initial topology, exposes its initially declared `.sessions`, and resolves a
specific handle with `.session(name)`. Append `.disconnected()` after
`.withSessions(...)` when it should start offline. `alias(...)` is only a
lexical name for a session selection; it does not add source declarations or
runtime instructions.

## Ordered steps and final expectations

`.steps(...)` accepts these ordered operations:

- application actions such as `todo.createTodo(input).as(sessionA)`;
- `note(text)` and `wait(duration)`;
- `disconnect(client)`, `reconnect(client)`, `backendUnavailable()`, and
  `backendAvailable()`;
- `stopSession(session)`, `restartSession(session)`, and `restartClient(client)`;
- `createClient(configuredClient)` and `addSession(client.session(name))`;
- `settle(selection, { reconnect: [...] })` as an intermediate barrier;
- `parallel([...], { require: 'overlap' })` for concurrent operations;
- `repeat(actions, { between: '250ms', require: 'all-finish' })`; and
- `generate(actionsOrFunction, options)` for seed-aware construction.

An optional terminal `.expect(...)` follows `.steps(...)`; its finalized
`ScenarioPlan` cannot accept more steps. Without `.expect(...)`, pending
resolution and ordered Eventlog convergence are checked for every session still
running at the end. An explicit expectation list replaces both defaults.
Available final expectations are
`pendingResolved`, `eventlogsConverge`, `stateConverges`, and
`stateContainsIds`.

`wait('2s')` requests a positive minimum controller delay. `between: '250ms'`
adds that delay after each completed sequence action except the last. Neither is
a Settlement or performance assertion.

## Parameters and ordinary TypeScript

Use `Scenario.parameterized` for CLI-overridable values:

```ts
export default Scenario.parameterized({ event_count: parameter.integer(100) }, ({ event_count: eventCount }) =>
  Scenario.start({ application: todo, clients: [clientA] }).steps(
    repeat(
      Array.from({ length: eventCount }, (_, offset) =>
        todo.createTodo({ id: `todo-${offset + 1}`, text: `Todo ${offset + 1}` }).as(main),
      ),
    ),
  ),
)
```

Run it with `--set event_count=250`. Undeclared overrides and values that do not
match the parameter kind are rejected before execution.

Loops, branches, structured inputs, and helper functions are normal TypeScript.
A one-off helper belongs directly in its Scenario module. A helper reused by
several sources belongs in an ordinary TypeScript module and is imported
directly; there is no helper registry, companion naming convention, or runner
change.

```ts
const createTodos = (count: number, target: ScenarioSession) =>
  repeat(
    Array.from({ length: count }, (_, offset) =>
      todo.createTodo({ id: `todo-${offset}`, text: `Todo ${offset}` }).as(target),
    ),
  )
```

## Seeded generation

`generate(({ random }) => ...)` receives deterministic keyed randomness. Set a
Scenario seed in `Scenario.start`, or override it when the source is normalized.
Use `random.iteration(n).integer(key, bound)` and `.pick(key, values)`. The same
source, parameters, and effective seed produce the same concrete action list;
the seed does not promise identical internal sync delivery order.

Generated and repeated actions are normalized immediately into a serializable
`action-sequence` with stable child operation IDs. No callback or TypeScript
module crosses into the runner or artifact.

## Validation and trust boundary

Normalization checks topology references at the point of use, lifecycle state,
Application ownership, action input schemas, inspector names, sequence bounds,
durations, parameters, generated JSON, and final oracle selections before a
participant starts.

Unlike the previous data-only format, a `.scenario.ts` module is executable,
trusted code. `--scenario-file` should only be used with repository source or a
local file the operator trusts. The authoring module may technically access
ambient Node capabilities; code review and explicit file selection form that
boundary. The resulting runner input remains closed, validated data.

## Local and retained sources

Start with `local/scenarios/scenario-template.scenario.ts` and run:

```sh
pnpm scenario:run --scenario-file local/scenarios/my-scenario.scenario.ts
```

Promote a reduced case only when it has a durable finding or representative
purpose. Move it into `src/corpus/scenarios/retained/findings/` or
`retained/examples/`, add focused evidence, and register its static import in
`src/corpus/scenarios/registry.ts`.

# YAML Scenario authoring

Status: accepted intent for replacing the experimental custom Scenario DSL.

## Purpose

Scenario source should remain declarative and readable without maintaining a
custom grammar. YAML supplies the document syntax, comments, and editor support.
The Scenario package owns the schema and semantic validation that turn the
document into the normalized `ScenarioAst` consumed by the runner.

Some Scenario data is most clearly produced with ordinary TypeScript. YAML may
therefore invoke named helpers resolved by Scenario source loading. A helper
expands one YAML instruction into finite declarative Scenario instructions
before the Scenario is validated and run. Helpers do not belong to the selected
Application and never cross into the runner.

The authoring path is:

```text
.scenario.yaml -> YAML parser -> parameter and helper expansion -> ScenarioAst validation -> runner
```

No compiled file needs to be persisted. Run artifacts retain the fully expanded
`ScenarioAst`, so a generated run remains inspectable and reproducible.

## Boundaries

The format keeps:

- one flat, ordered `do` list with no phases;
- YAML comments for source-only explanation;
- optional `note` instructions when narrative text must appear in the trace;
- Scenario identity inferred from the `.scenario.yaml` filename;
- execution profiles supplied independently of Scenario source;
- application-specific action and inspector names;
- compiler-owned instruction, operation, and oracle identities;
- default pending-resolution and eventlog-convergence oracles when `expect` is
  absent;
- complete replacement of those defaults when `expect` is present;
- explicit concurrency, lifecycle operations, faults, Settlement, waits, and
  fixed-delay repetition;
- deterministic expansion and application-input validation before execution.

Free-text AI interpretation is outside this format.

## Overall shape

```yaml
application: todo
about: An offline Client writes, reconnects, and converges.

clients:
  client-a:
    sessions: [main]
  client-b:
    sessions: [main]

do:
  - disconnect: client-a

  - run: createTodo
    as: client-a/main
    with:
      id: offline-todo
      text: Written while disconnected

  - reconnect: client-a

expect:
  pending: resolved
  eventlogs: converge
```

Only `application`, `clients`, and `do` are required. `do` may be empty when a
Scenario exists solely to check initial behavior. `about`, `seed`, `parameters`,
`aliases`, and `expect` are optional.

`example-name.scenario.yaml` has Scenario ID `example-name`. Source does not
declare an ID, tags, format version, or execution profile.

## YAML value rules

YAML is decoded with the YAML 1.2 core schema. Scalars therefore follow YAML
1.2 rather than YAML 1.1's surprising boolean vocabulary. Application inputs
must ultimately be JSON values.

Parameter interpolation uses one explicit form:

```yaml
parameters:
  count:
    type: integer
    default: 20

do:
  - wait: 250ms
  - repeat:
      times: ${count}
      as: item
      action:
        run: createTodo
        as: client-a/main
        with:
          id: todo-${pad(item, 3)}
          text: Item ${item}
```

When an entire scalar is one interpolation, the resolved value keeps its type:
`${count}` becomes a number. Interpolation embedded in a larger scalar produces
a string. The initial expression surface contains parameter and repeat-variable
lookups plus `pad(value, width)`; it is not general JavaScript.

## Clients and aliases

```yaml
clients:
  client-a:
    sessions: [main, secondary]
  client-b:
    sessions: [main]
    connected: false

aliases:
  writers:
    - client-a/main
    - client-b/main
```

A participant is always a fully qualified `client/session`. An alias is a
top-level name for one participant or a list. Aliases are authoring shorthand
and never become instructions. They may name dynamically created Clients or
sessions, but using an alias before all of its participants exist is a compile
error:

```yaml
aliases:
  both: [client-a/main, client-b/main]

do:
  - createClient:
      id: client-b
      sessions: [main]

  - settle: both
```

## Ordered instructions

### Application action

```yaml
- run: createTodo
  as: client-a/main
  with:
    id: todo-1
    text: Readable input
```

The selected Application must register `createTodo`, and its input schema must
accept `with` after interpolation.

### Trace annotation

YAML comments do not affect execution and are not retained:

```yaml
# This explanation exists only in source.
```

Use `note` only when the text is meaningful trace evidence:

```yaml
- note: The backend outage begins after both local writes.
```

### Connectivity and lifecycle

```yaml
- disconnect: client-a
- reconnect: client-a
- stopSession: client-a/secondary
- restartSession: client-a/secondary
- restartClient: client-a
- backend: unavailable
- backend: available
```

### Dynamic topology

```yaml
- createClient:
    id: client-b
    sessions: [main]
    connected: false

- addSession: client-b/secondary
```

### Settlement

```yaml
- settle: writers
```

Disconnected Clients that should be healed at this boundary are explicit:

```yaml
- settle:
    participants: writers
    reconnect: [client-a]
```

Settlement has no authored timeout. Execution configuration supplies the
profile-specific safety bound.

### Concurrency

```yaml
- concurrently:
    - run: createTodo
      as: client-a/main
      with:
        id: todo-a
        text: Written by A

    - run: createTodo
      as: client-b/main
      with:
        id: todo-b
        text: Written by B
  expect: overlap
```

The optional local expectation can be `overlap` or `all-finish`. An object form
adds `allowIndefinite: true` when the Scenario intentionally permits loss of an
operation response boundary.

## Time and repetition

An elapsed wait is an ordered instruction:

```yaml
- wait: 2s
```

It is a minimum controller delay, not Settlement or a performance assertion.

A simple declarative repeat expands one action:

```yaml
- repeat:
    times: 20
    as: item
    between: 250ms
    action:
      run: createTodo
      as: client-a/main
      with:
        id: todo-${pad(item, 3)}
        text: Seeded item ${item}
```

`between` is optional. The first action has no initial delay and the final
action has no trailing delay. It describes a fixed delay after one acknowledged
action and before the next invocation, not a fixed cadence.

Use a TypeScript helper when iteration needs branching, computed structured
values, seeded choice, or other logic that would expand the YAML expression
language.

## TypeScript helpers

A helper is registered under a stable name. Application-neutral operations
belong in the shared catalogue and are available without a companion file. Use
an optional same-directory companion only for actual one-off implementation.
For example, `many-writer-convergence.scenario.yaml` and
`many-writer-convergence.helpers.ts` form one self-contained pair. The YAML
instruction contains only the helper name and JSON-compatible input:

```yaml
- generate: distributedTodos
  with:
    participants: writers
    count: ${eventCount}
    idPrefix: many-writer
  between: 250ms
```

The companion contains the ordinary TypeScript implementation and its export;
it never re-exports an implementation from another catalogue:

```ts
import { Schema } from '@livestore/utils/effect'

import { defineScenarioHelper, defineScenarioHelpers, helperActions } from '../../../../yaml/helpers.ts'

const distributedTodos = defineScenarioHelper({
  input: Schema.Struct({
    participants: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    count: Schema.Int,
    idPrefix: Schema.String,
  }),
  generate: ({ input, context }) => {
    const participants = context.participants(input.participants)
    return helperActions(
      Array.from({ length: input.count }, (_, offset) => {
        const event = offset + 1
        const target = context.random.iteration(event).pick('target', participants)

        return {
          target,
          action: 'createTodo',
          input: {
            id: `${input.idPrefix}-${String(event).padStart(3, '0')}`,
            text: `Distributed write ${event}`,
          },
        }
      }),
    )
  },
})

export default defineScenarioHelpers({ distributedTodos })
```

Helper rules:

- helpers return finite declarative fragments from the existing Scenario
  instruction vocabulary, never runner callbacks or oracles;
- helper input is schema-validated before invocation;
- output is bounded, assigned compiler-owned IDs, checked against the selected
  Application's action schemas, and embedded in the normalized Scenario;
- `between` and local `expect` apply when the helper returns `helperActions`;
  `helperInstructions` instead expands ordinary `do` entries in place;
- deterministic randomness is derived from the Scenario seed, helper
  instruction identity, iteration, and caller-supplied key;
- helpers receive no clock, filesystem, network, environment, runner, or
  participant-host capability through their context;
- the framework guarantees deterministic inputs but cannot prove that arbitrary
  module code avoids ambient APIs; registered helpers are trusted repository
  code and must be covered by determinism tests.

The shared catalogue and a real companion helper set compose without
precedence; a duplicate name fails loading. Retained and committed test sources
attach only companions that contain one-off implementations. Explicit local
`--scenario-file` loading may discover the exact adjacent companion
asynchronously. Inline TypeScript blocks, registration-only companions, and
arbitrary module paths in YAML remain unsupported.

## Expectations and defaults

When `expect` is omitted, the compiler adds `pending: resolved` and
`eventlogs: converge` for every running participant in the final declared
topology.

Any explicit `expect` replaces the defaults completely. Without `for`, it also
applies to every participant still running after `do`:

```yaml
expect:
  pending: resolved
  eventlogs: converge
  state:
    todos:
      converge: true
      containsIds:
        - todo-001
        - todo-020
```

Use optional `for` only when an expectation intentionally targets a subset. It
accepts one fully qualified participant, an explicit list, or a top-level
alias. An array expresses different scopes:

```yaml
expect:
  - for: client-a/main
    pending: resolved
  - for: both
    eventlogs: converge
```

Expectation properties correspond to normalized oracles. Unknown aliases,
participants, inspectors, and malformed expectation values fail before
execution.

## Validation and determinism

Loading a Scenario performs all of the following before the runner starts:

1. parse YAML and reject YAML anchors/alias nodes, duplicate keys, multiple
   documents, and unsupported tags;
2. validate the authoring document shape and parameter overrides;
3. resolve topology, top-level aliases, parameters, and interpolation; an alias
   may only be used after all of its participants exist;
4. expand repeats and registered helpers with stable identities;
5. validate application action inputs and inspector names;
6. validate the normalized `ScenarioAst` and all cross-references.

Compiling the same source, parameter overrides, seed, Application registry, and
helper implementations must produce the same normalized Scenario. Tests run
helpers more than once and compare their complete expanded output.

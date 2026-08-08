# Scenario DSL syntax and semantics

Status: deterministic language implemented. Elapsed waits and repeat pacing are
the next contract slice described below.

## Purpose

The DSL should let a reader understand a Scenario as a set of instructions
without reading a serialized object model. It should remain deterministic,
statically checkable, and precise enough to compile into the normalized
Scenario plan consumed by the runner.

The proposal deliberately keeps:

- one flat, ordered instruction stream with no phases;
- annotations as traceable, zero-effect instructions;
- compiler-owned instruction and operation identities rather than authored IDs;
- Application-specific action names and typed inputs;
- explicit concurrency, lifecycle operations, faults, Settlement, and
  expectations;
- a deterministic compiler boundary before execution.

AI-interpreted free text is outside this proposal.

## Design principles

### Read as instructions

Behavioral lines use verbs: `disconnect`, `runs`, `settle`, `restart`, and
`expect`. Structural punctuation is limited to indentation, commas, quoted
strings, and a colon when a line opens a block.

### Prefer precise words over natural-language guessing

Every executable form has one meaning. The compiler never infers that
"temporarily take A offline" means `disconnect client-a`, for example. Narrative
text is introduced explicitly with `note` and has no behavioral effect.

### Keep Application language visible

An action uses the exact name registered by the selected Application:

```scenario
client-a/session-a runs createTodo with
  id: "todo-1"
  text: "Read the proposal"
```

The compiler checks `createTodo` and its input against the `todo` Application.
The generic Scenario language does not add aliases such as `creates todo`.

### Compile before running

The command-line experience may run a `.scenario` file directly, but the
internal path remains:

```text
DSL source -> parser and semantic checks -> normalized Scenario plan -> runner
```

The normalized Scenario plan remains the `ScenarioAst` contract; no additional
persisted intermediate file is required. Accepted language features that the
current contract cannot represent, such as elapsed waits, version that contract
rather than bypassing it. A future `scenario check` command can stop after
validation, while an optional `scenario compile` command can print the
normalized plan for debugging.

## Overall file shape

The proposed extension is `.scenario`. A file has four ordered regions:

1. Application selection and optional Scenario metadata;
2. initial Client topology;
3. an ordered body of instructions and optional participant-alias declarations;
4. an optional final `expect` block.

`example-name.scenario`:

```scenario
application todo

client client-a with session-a

note "The ordered instruction stream begins here."

client-a/session-a runs createTodo with
  id: "todo-1"
  text: "Example"
```

Blank lines are insignificant. `#` starts a line comment outside a string.
Indentation is significant only inside a block and uses spaces, not tabs.

## Lexical conventions

### Identifiers

Scenario, Client, session, instruction, participant-alias, and expectation IDs
use ASCII letters, digits, `_`, and `-`. They must begin with a letter. Action
and inspector names retain the exact case-sensitive name exposed by the
Application, such as `createTodo` or `todos`.

A participant is always written as `client-id/session-id`. A bare Client ID
never silently means its first session, and a bare session ID never resolves by
searching the topology. Session IDs are unique within their Client rather than
globally, so different Clients may each have a session named `main`.

### Values

Action inputs use a small, strict data-literal language rather than YAML
coercion:

- quoted strings: `"hello"`;
- numbers: `42`, `3.5`;
- booleans and null: `true`, `false`, `null`;
- arrays: `["a", "b"]`;
- objects: `{ source: "test", attempt: 2 }`;
- indented field blocks after `with`.

Field names may be unquoted identifiers or quoted strings. Strings never turn
implicitly into dates, numbers, or booleans.

```scenario
client-a/session-a runs someApplicationAction with
  title: "A string"
  enabled: true
  labels: ["sync", "recovery"]
  metadata: { source: "scenario", attempt: 2 }
```

The indented `with` block is the canonical action-input form. A braced object
remains available as a nested value, but not as an alternative top-level
action-input spelling.

### Durations

Durations are positive integers followed by `ms`, `s`, or `m`: `250ms`, `8s`,
or `2m`. The compiler normalizes them to milliseconds.

## Time and pacing

Timed behavior needs separate words for separate guarantees:

| Form                 | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `wait 2s`            | Do not begin the next instruction until the controller has waited for at least two seconds. |
| `with 250ms between` | Leave at least 250 milliseconds between completed repeated actions.                         |
| `every 250ms`        | Start work on a fixed cadence; not proposed for the initial language.                       |
| `at 5s`              | Target an absolute offset from Scenario start; not proposed for the initial language.       |

### Delay between instructions

An explicit `wait` instruction keeps elapsed time visible in the ordered
instruction stream:

```scenario
client-a/session-a runs createTodo with
  id: "todo-1"
  text: "First action"

wait 2s

client-a/session-a runs editTodo with
  id: "todo-1"
  text: "Changed after the delay"
```

The delay begins when the runner reaches `wait`. It is a minimum controller
delay, not an exact schedule: operating-system load may make the actual delay
longer. The trace retains both the requested duration and controller-monotonic
start and completion evidence.

`wait` occupies one logical instruction position; it does not advance logical
time by a number of milliseconds. It does not establish Quiescence,
Settlement, synchronization, or State equality. The ordinary post-instruction
system observation occurs after the wait, making system progress during the
delay visible without claiming that the transition happened at an exact time.

### Delay between repeated actions

The repeat form expresses a fixed delay after one action is acknowledged and
before the next action is invoked:

```scenario
repeat 20 times as item with 250ms between:
  client-a/session-a runs createTodo with
    id: "todo-${pad(item, 3)}"
    text: "Seeded item ${item}"
```

The first action starts without an initial delay, and there is no delay after
the final action. Action execution time is not counted toward the requested
gap. This is fixed-delay pacing, so slow actions extend the total sequence
duration rather than compressing later gaps.

The superficially similar form `every 250ms` would mean fixed-cadence pacing
anchored to scheduled start times. It requires an explicit overrun policy when
an action takes longer than the cadence: queue it, skip it, or fail. That
additional behavior is intentionally not implied by `with ... between`.

Fixed-delay pacing is the accepted initial behavior. Fixed cadence remains
outside the initial language.

### Absolute schedules and timing expectations

An absolute form such as `at 5s` introduces missed-deadline and catch-up
semantics when startup or a previous instruction runs long. It is omitted from
the initial proposal until a concrete Scenario needs it. Relative `wait`
instructions compose directly with the existing ordered model.

Likewise, pacing is not a performance assertion. A future expectation such as
`expect completed within 2s` would be an elapsed-time oracle evaluated from
trace evidence; it would not be another spelling of `wait` or the runner's
execution timeout.

Settlement and terminal stabilization have no authored timeout in Scenario
source. The run configuration supplies the bounded execution policy so the same
Scenario can run across profiles with different operational costs. A Scenario
that intends to assert an elapsed-time guarantee must say so through a timing
oracle rather than by repurposing the runner's safety timeout.

### Normalized model impact

The normalized Scenario and trace protocols model delay rather than treating it
as parser-only behavior:

- a `wait` instruction carrying the requested minimum duration;
- requested/completed wait trace evidence with actual controller elapsed time;
- fixed-delay pacing metadata on compiled action sequences;
- viewer treatment for intentional gaps versus unexplained operational delay.

The runner uses its monotonic controller clock for elapsed delays. Wall time
remains recorded for external comparison, while logical time continues to
represent only plan order. Neither requested nor observed elapsed time becomes
a LiveStore ordering or causality rule.

## Metadata and topology

### Identity and Application

The Scenario ID is the source filename without its `.scenario` extension.
Renaming the file therefore changes its identity; the source contains no
duplicated or hidden ID.

`offline-writer-recovery.scenario`:

```scenario
application todo
```

An optional description may follow the Application declaration:

```scenario
about "An offline Client and an online Client both write, recover, and converge."
```

The `.scenario` extension selects the current grammar; source files do not
carry a language-version declaration. If a genuinely breaking grammar is ever
needed, it receives an explicit migration mechanism then rather than adding
compiler metadata to every initial Scenario. The required `application`
declaration selects the Application whose registered actions and inspectors are
available. It does not select or constrain an execution profile. `about` is
optional. If present, it becomes the Scenario description; if omitted, the
compiler supplies an empty description. It never derives description text from
the Scenario ID, filename, notes, or instructions.

The initial language has no tags. The compiler supplies an empty tag list to
the current normalized contract. Search or catalog metadata can be designed
separately if a concrete discovery need appears.

`seed` is omitted unless the source uses `choose` or `randomInt`. A random
Scenario declares a non-negative integer explicitly:

```scenario
seed 3004
```

The compiler rejects random expressions without a seed. A non-random Scenario
normalizes to the runner contract's canonical seed value without exposing that
bookkeeping in DSL source.

The language has no Store-ID declaration. The compiler derives the normalized
logical Store ID from the Scenario ID, while execution profiles remain
responsible for physical run isolation.

### Execution profiles

The DSL has no profile, backend, State substrate, or `requires` declaration.
The run invocation selects `in-process`, `process`, or `browser` independently
from the Scenario, and the same compiled Scenario may run against every profile
that supports its inferred operations.

The compiler derives structural needs such as multiple Clients or sessions,
named actions, connectivity and backend faults, lifecycle operations, dynamic
topology, observations, and State inspection directly from the source. The
runner validates those needs against the selected profile before execution.

Storage and placement guarantees such as SQLite, OPFS, process isolation,
SharedWorker, Web Locks, and Event lineage describe an execution realization,
not Scenario behavior. A test matrix may choose particular Scenario/profile
combinations, but that choice does not alter or constrain the Scenario source
or compiled plan.

### Initial Clients

One initial session has a compact form:

```scenario
client client-a with session-a
client client-b with session-b
```

Several initial sessions use a block:

```scenario
client client-a:
  session session-a1
  session session-a2
```

Every initial or dynamically created Client declares at least one explicitly
named session. The compiler never creates or names a default session.

Initial and dynamically created Clients begin connected unless marked
otherwise:

```scenario
client client-a with session-a disconnected
```

`client-a/session-a` is the participant reference used by actions, Settlement,
and expectations.

### Participant aliases

Aliases remove repeated participant lists without changing execution:

```scenario
participants both = client-a/session-a, client-b/session-b
```

An alias can then appear anywhere a participant list is expected:

```scenario
settle both

expect both:
  eventlogs converge
```

Aliases are compile-time names, not runtime groups or instructions. An alias
may appear after the initial topology or between instructions, but every named
participant must exist at that source position and the alias must be declared
before its first use. An alias cannot refer forward to a later `create client`
or `add session` instruction.

```scenario
create client client-b with main
participants both = client-a/main, client-b/main
settle both
```

Language version 1 uses only explicit participant aliases. It has no `all`,
`everyone`, or other context-sensitive participant selector whose membership
could change as dynamic Clients or sessions are added.

## Compiler-owned identities

Language version 1 has no authored instruction, operation, or expectation IDs.
The compiler assigns every normalized identity required for trace correlation,
failure reporting, host requests, and oracle evaluation.

Generated identities are deterministic for the same resolved source, but they
are not a user-facing reference mechanism. Diagnostics identify source spans
and quote the relevant instruction instead of asking an author to interpret a
generated ID.

Operation-history expectations remain next to the operations they select. A
concurrent block can check all of its child operations:

```scenario
concurrently:
  client-a/session-a runs createTodo with
    id: "todo-a"
    text: "Written by A"

  client-b/session-b runs createTodo with
    id: "todo-b"
    text: "Written by B"

  expect overlap
```

A repeated action block can check `all`, `first`, `last`, or `first and last`
child actions. The compiler resolves that structural selection to normalized
operation IDs; those IDs never enter DSL source.

## Instruction reference

Instructions execute from top to bottom. An annotation advances the stream and
emits a trace marker, but it performs no operation. A `concurrently` block is
the only construct that changes sequential scheduling.

### Annotation

```scenario
note "Client A now writes while isolated from the backend."
```

Long annotations use triple-quoted strings:

```scenario
note """
The next operations reproduce the smallest known rebase failure.
They are still narrative only.
"""
```

### Wait

```scenario
wait 2s
```

A wait introduces a minimum elapsed controller delay before execution
continues. See [Time and pacing](#time-and-pacing) for its evidence and logical
time semantics.

### Application action

```scenario
client-a/session-a runs createTodo with
  id: "todo-1"
  text: "First item"
```

The participant must exist at this point in the instruction stream. The action
must belong to the selected Application, and the `with` block must decode
against its input schema. An action with no input fields omits `with`.

### Client connectivity

```scenario
disconnect client-a
reconnect client-a
```

Connectivity applies to the whole Client, not one session.

### Backend availability

```scenario
backend unavailable
backend available
```

This addresses the Scenario host's participant-facing backend-availability
fault boundary. A profile may realize that boundary as a network route rather
than by stopping the backend service itself.

### Session and Client lifecycle

```scenario
stop session client-a/session-a1
restart session client-a/session-a1
restart client client-a
```

Stopping and restarting one session is distinct from restarting the whole
Client and all of its sessions.

### Dynamic topology

```scenario
create client client-b with session-b
create client client-c with session-c disconnected
add session session-a2 to client-a
```

The new Client or session becomes available only to later instructions.
Participant removal is not currently supported.

### Concurrent operations

```scenario
concurrently:
  client-a/session-a runs createTodo with
    id: "todo-a"
    text: "Written by A"

  client-b/session-b runs createTodo with
    id: "todo-b"
    text: "Written by B"

  expect overlap
```

The block must contain at least two operations. It may contain Application
actions, connectivity changes, backend availability changes, session stops or
restarts, and Client restarts. It may not contain annotations, Settlement,
dynamic topology, repetition, or another concurrent block.

The runner records every child invocation before releasing the host requests,
then waits for every child outcome before continuing. Source order does not
claim host completion order.

`expect all finish` checks only terminal, non-indefinite outcomes without
requiring overlapping intervals. Either local expectation may end with
`allowing indefinite` when an indefinite host outcome is acceptable.

### Settlement

```scenario
settle client-a/session-a, client-b/session-b
```

Settlement is an explicit intermediate convergence barrier over the named
participants. It is used only when later instructions depend on synchronization
having completed at that point. The run configuration bounds how long the
runner waits; Scenario source does not contain that safety timeout.

The end of the instruction stream does not need a Settlement. Final
snapshot-based expectations imply terminal stabilization over their selected
participants before oracle evaluation. When the final `expect` block is
omitted, the default expectation set likewise implies terminal stabilization
over its deterministically selected participants.

Settlement does not imply State or Eventlog equality; those remain oracle
claims. It establishes a stable observation point for subsequent instructions.

A Settlement can reconnect disconnected Clients as part of establishing the
barrier:

```scenario
settle client-a/session-a, client-b/session-b
  reconnect client-a
```

This nested line is Settlement configuration, not another top-level
instruction. A separate earlier `reconnect client-a` remains available when
reconnecting should be an independently visible instruction.

## Deterministic repetition

Repetition expands during compilation into one `action-sequence` and its
concrete, ordered child actions. No loop or expression reaches the runner.

```scenario
repeat 20 times as item:
  client-a/session-a runs createTodo with
    id: "todo-${pad(item, 3)}"
    text: "Seeded item ${item}"

  expect first and last finish
```

The iteration variable is one-based. The compiler creates stable child IDs
and embeds every resolved input in the normalized plan. The repeat's internal
identity is derived from its normalized source structure and occurrence among
otherwise identical repeat blocks.

Parameters can make a source reusable without executing code:

```scenario
parameter event_count: integer = 426

repeat event_count times as event:
  # ...
```

A CLI override supplies a typed value explicitly, for example
`--set event_count=100`. The resolved value is reflected in the normalized
plan and artifact. The DSL does not read environment variables implicitly.

Declared typed parameters with defaults and explicit CLI overrides are part of
the initial language. A parameter declaration without a default is invalid, so
a Scenario source always compiles without requiring ambient configuration.

Language version 1 parameter types are `integer`, `number`, `string`,
`boolean`, and `duration`. List and object parameters are not supported;
structured values remain Application action inputs. CLI overrides use the
declared type, and a `duration` override uses the ordinary `ms`, `s`, or `m`
literal syntax.

The proposed expression surface is deliberately small:

- the iteration variable and declared parameters;
- string interpolation with `${...}`;
- `pad(value, width)`;
- `repeat(text, count)` for payload construction;
- `randomInt(maximum, key: "stable-key")`;
- `choose(values, key: "stable-key")`.

Random functions are keyed by Scenario seed, the repeat's compiler-owned
identity, iteration, and the explicit key. Adding an unrelated random
expression therefore does not shift other choices.

```scenario
participants writers = client-a/session-a, client-b/session-b, client-c/session-c
parameter event_count: integer = 100

repeat event_count times as event:
  let writer = choose(writers, key: "target")
  let variant = randomInt(1000, key: "text-variant")

  writer runs createTodo with
    id: "distributed-${pad(event, 3)}"
    text: "Write ${event} · variant ${variant}"

  expect first and last finish
```

`let` is proposed only inside a repeat block and only binds a deterministic
expression. General functions, mutation, imports, clocks, filesystem access,
and network access are not part of the language.

## Expectation reference

An `expect` block is declarative and appears after the instruction stream. Its
header selects the participants once, and each body line compiles to one
current oracle for that selection.

| DSL form                            | Meaning                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pending resolved`                  | Every selected participant is synced with zero pending Events.         |
| `eventlogs converge`                | Selected confirmed Eventlogs match the authoritative backend Eventlog. |
| `<inspector> converges`             | The selected Application inspector returns equal State.                |
| `<inspector> contains ids <values>` | Every selected inspector result contains the expected IDs.             |

Examples:

```scenario
expect both:
  pending resolved
  eventlogs converge
  todos converges
  todos contains ids "todo-a", "todo-b"
```

Several consecutive final `expect` blocks may select different participant
sets. The presence of any explicit final block replaces the defaults for the
whole Scenario.

### Default expectations

When the final `expect` block is omitted, the compiler supplies exactly two
oracles for every session still running after the final authored instruction.
For `client-a/main` and `client-b/main`, the result is equivalent to:

```scenario
expect client-a/main, client-b/main:
  pending resolved
  eventlogs converge
```

The first produces a focused verdict about pending work. The second compares
the exact ordered confirmed Event sequence with the authoritative backend
Eventlog. Although convergence also requires zero pending Events, retaining the
separate pending verdict makes a failure's cause immediately visible.

The derived participant set is deterministic from the ordered lifecycle
instructions. A disconnected session is still running, and terminal
stabilization never reconnects it implicitly. The source must reconnect its
Client or provide an explicit expectation contract appropriate to an
intentionally disconnected ending.

An explicit final `expect` block replaces both defaults completely; it does not
extend them. An empty explicit block is invalid. Application-specific State
expectations are never defaults.

Operation-history expectations are local to `concurrently` and `repeat`
blocks:

```scenario
concurrently:
  # two or more operations
  expect overlap

repeat 100 times as item:
  # one Application action
  expect first and last finish allowing indefinite
```

Snapshot-based expectations (`pending`, Eventlog convergence, inspector
convergence, and inspector contents) imply terminal stabilization for their
participants. The runner establishes that stable observation point under its
execution timeout policy before evaluating the oracles. Local operation-history
expectations consume retained evidence and do not themselves require
stabilization.

## Construct-to-plan mapping

| Source construct                            | Normalized Scenario construct                    |
| ------------------------------------------- | ------------------------------------------------ |
| `note`                                      | `annotation` instruction                         |
| `wait`                                      | elapsed-delay instruction                        |
| `<participant> runs <action>`               | `action` instruction                             |
| `disconnect` / `reconnect`                  | Client connectivity instruction                  |
| `backend unavailable` / `backend available` | backend-availability instruction                 |
| `stop session` / `restart session`          | session lifecycle instruction                    |
| `restart client`                            | Client lifecycle instruction                     |
| `create client`                             | dynamic Client creation instruction              |
| `add session`                               | dynamic session addition instruction             |
| `concurrently`                              | `parallel` instruction with child operations     |
| `repeat`                                    | compiled `action-sequence` with concrete actions |
| `settle`                                    | Settlement instruction                           |
| `expect` line                               | one Scenario oracle                              |

The compiler derives capability requirements from the normalized shape.

## Example 1: minimal deterministic Scenario

`create-one-todo.scenario`:

```scenario
application todo

client client-a with session-a

client-a/session-a runs createTodo with
  id: "todo-1"
  text: "Created by the Scenario"

expect client-a/session-a:
  pending resolved
  eventlogs converge
  todos contains ids "todo-1"
```

## Example 2: offline concurrent writers

This is the proposed DSL equivalent of the retained
`offline-writer-recovery` example.

`offline-writer-recovery.scenario`:

```scenario
application todo
about "An offline Client and an online Client both write before reconnecting and converging."

client client-a with session-a
client client-b with session-b
participants both = client-a/session-a, client-b/session-b

note "Client A writes offline while Client B writes against the shared backend."

disconnect client-a

concurrently:
  client-a/session-a runs createTodo with
    id: "todo-offline-a"
    text: "Written while Client A is offline"

  client-b/session-b runs createTodo with
    id: "todo-online-b"
    text: "Written while Client B is online"

  expect overlap

settle client-b/session-b

note "Client A reconnects before the final expectations establish a stable shared head."

reconnect client-a

expect both:
  pending resolved
  eventlogs converge
  todos converges
  todos contains ids "todo-offline-a", "todo-online-b"
```

## Example 3: dynamic multi-session lifecycle

This example exercises a later session, Leader turnover, and a whole-Client
restart without introducing a grouping phase.

`multi-session-recovery.scenario`:

```scenario
application todo
about "A later session joins one Client and both recover through session and Client restarts."

client client-a with session-a1

note "Both sessions write through the same Client leader."

client-a/session-a1 runs createTodo with
  id: "todo-session-a1"
  text: "Written by the first session"

add session session-a2 to client-a

client-a/session-a2 runs createTodo with
  id: "todo-session-a2"
  text: "Written by the second session"

settle client-a/session-a1, client-a/session-a2

note "The first session stops, its sibling continues through Leader turnover, then it returns."

stop session client-a/session-a1

client-a/session-a2 runs createTodo with
  id: "todo-after-leader-turnover"
  text: "Written after the initial Leader session closes"

restart session client-a/session-a1
settle client-a/session-a1, client-a/session-a2

note "The entire Client restarts and restores both sessions before converging."

restart client client-a

expect client-a/session-a1, client-a/session-a2:
  pending resolved
  eventlogs converge
  todos converges
  todos contains ids "todo-session-a1", "todo-session-a2", "todo-after-leader-turnover"
```

## Example 4: parameterized, seeded activity

This example shows the proposed upper boundary of the deterministic DSL. The
compiler resolves the parameter, choices, interpolation, and all child actions
before the runner starts.

`distributed-todo-actions.scenario`:

```scenario
application todo
seed 3004
about "Three Clients distribute a configurable number of uniquely identified writes."

parameter event_count: integer = 100

client client-a with session-a
client client-b with session-b
client client-c with session-c
participants writers = client-a/session-a, client-b/session-b, client-c/session-c

note "Distribute deterministic createTodo actions across all writers."

repeat event_count times as event:
  let writer = choose(writers, key: "target")
  let variant = randomInt(1000, key: "text-variant")

  writer runs createTodo with
    id: "distributed-${pad(event, 3)}"
    text: "Distributed write ${event} · variant ${variant}"

  expect first and last finish

expect writers:
  pending resolved
  eventlogs converge
  todos converges
  todos contains ids "distributed-001", "distributed-${pad(event_count, 3)}"
```

## Static diagnostics

The compiler should reject a source before any participant starts when it
finds:

- an unknown Application, action, inspector, Client, session, or alias;
- a derived Scenario ID that duplicates another file in the loaded catalog;
- a Client declaration without at least one explicitly named session;
- an action input that does not match the Application schema;
- use of a participant before its dynamic creation instruction;
- an alias declared before one of its participants exists or used before its
  declaration;
- fewer than two operations in `concurrently`;
- a construct inside `concurrently` that the runner cannot execute there;
- a non-positive duration or an out-of-range repetition count;
- a random expression without an explicit Scenario seed;
- an unkeyed random choice;
- an unresolved parameter or an invalid override;
- an explicit `expect` block with no expectations;
- indentation, string, or data-literal syntax errors.

Every diagnostic should include file, line, column, the invalid construct, and
when useful the registered alternatives. For example:

```text
offline.scenario:18:27: unknown action `createTood` for application `todo`
  did you mean `createTodo`?
```

## Deliberate omissions

The first deterministic language does not include:

- phases or implicit instruction grouping;
- arbitrary TypeScript or JavaScript;
- imports, filesystem reads, clocks, or network access;
- implicit environment-variable reads;
- AI-interpreted instructions;
- profile selection or backend selection, which remain execution concerns;
- absolute `at <offset>` schedules or fixed-cadence `every <duration>` loops;
- nested concurrency;
- concurrent Settlement, dynamic topology, annotations, or action sequences;
- participant removal;
- Event/materializer definitions, which remain Application-owned.

## Implementation status

### Task 1: deterministic DSL and stabilization semantics

Implemented in the deterministic language and stabilization slice:

- move Settlement and terminal-stabilization timeout bounds into run
  configuration;
- make snapshot-based final expectations establish their own terminal stable
  observation point;
- retain explicit `settle` only as an intermediate convergence barrier;
- source parser with spans and deterministic diagnostics;
- Application/action/inspector and topology name resolution;
- strict action-input decoding;
- compiler-owned identities and local operation-history expectations;
- concurrency, lifecycle, faults, Settlement, and current oracle forms;
- fixed-count deterministic repetition without elapsed pacing;
- direct retained-source and `--scenario-file` run entrypoints;
- compiler, model, runner, and profile-focused tests;
- migration of representative simple and complex examples.

This slice changed runner stabilization control and the normalized Settlement
contract without adding timing oracles.

### Task 2: elapsed waits and repeat pacing

Implemented after the compiler boundary stabilized:

1. add `wait` and fixed-delay action-sequence pacing to the normalized Scenario
   model;
2. validate durations and version the Scenario, trace, and artifact contracts;
3. execute delays against the controller monotonic clock;
4. retain requested and actual elapsed evidence;
5. test timing semantics first through normalized TypeScript fixtures;
6. teach the DSL compiler to emit `wait` and `with <duration> between`;
7. distinguish intentional waits from unexplained delay in viewer projections.

Both accepted slices are implemented. Static editor integration, a dedicated
`scenario check` command, normalized-plan printing, fixed cadence, absolute
schedules, and timing oracles remain possible follow-ups rather than hidden
parts of the language.

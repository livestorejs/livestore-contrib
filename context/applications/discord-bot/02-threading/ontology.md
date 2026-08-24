# Discord Bot Threading — Ontology

This vocabulary separates Discord transport facts from decisions made by the
threading subsystem.

## Terms

| Term | Meaning |
| --- | --- |
| **Source message** | The Discord message to which a public thread is, or would be, anchored. |
| **Parent channel** | The non-thread Discord channel containing the source message. |
| **Automatic trigger** | A validated ambient message event offered to threading policy without an explicit user command. |
| **Manual trigger** | An invocation of the **Create Thread** message action for a source message. |
| **Operator trigger** | An authenticated Bot control request to create a thread for a source message, commonly an older message. It is not a policy bypass. |
| **Thread candidate** | A source message together with its Discord context, trigger, and requesting actor (when any), before policy has accepted it. |
| **Eligibility decision** | The automatic-trigger policy result saying whether a candidate may proceed and why. |
| **Authorization decision** | The manual-trigger policy result saying whether the invoking actor may proceed and why. |
| **Thread proposal** | An accepted candidate plus a valid proposed thread name, ready for duplicate reconciliation and mutation. |
| **Creation intent** | A decision that a proposal should be realized in Discord. It is persisted through the per-source ledger selected by decision 0003. |
| **Thread mutation** | The Discord REST operation that creates a public thread from the source message. |
| **Thread outcome** | The structured resolution of a trigger: created, already satisfied, rejected, transiently failed, or terminally failed. |
| **Title generator** | A policy component that proposes a thread name from permitted input; it may be local or externally backed. |
| **Degradation** | The deliberate behavior used when the preferred title generator or mutation dependency is unavailable. |
| **Replay** | Redelivery of a logically identical Discord dispatch or interaction. |
| **Race** | Two accepted triggers for the same source message whose effects overlap in time. |
| **Action journal** | The environment-local SQLite authority that serializes per-source claims and records mutation outcomes. It is application state, not telemetry. |
| **Unknown external** | A journal state meaning Discord may have applied a submitted mutation but the runtime lacks a definitive response. It cannot be retried blindly. |
| **Manual review** | A terminal operational state reached when bounded Discord reconciliation cannot safely distinguish created from not created. |

## Relationships

```text
Source message --contained by--> Parent channel
      |
      +--observed as--> Automatic trigger --eligibility decision--+
      |                                                        |
      `--selected by--> Manual trigger --authorization decision--+
                                                               |
                                                               v
                                                      Thread candidate
                                                               |
                                                        title generator
                                                               |
                                                               v
                                                      Thread proposal
                                                               |
                                                     duplicate/replay check
                                                               |
                                                        thread mutation
                                                               |
                                                               v
                                                        Thread outcome
```

## Naming Rules

- Use **source message**, not “original message,” because Discord interactions
  and replies can each have several plausible originals.
- Use **trigger** for the fact that caused evaluation; use **intent** only after
  policy has accepted creation.
- Use **rejected** for policy or authorization decisions and **failed** for an
  attempted dependency or mutation. Rejection is not an operational error.
- Use **already satisfied** when an existing thread fulfills the request;
  decision 0004 defines the no-duplicate mutation semantics.
- Use **effective thread permission** for Discord's resolved
  `CREATE_PUBLIC_THREADS` authority in the target channel; do not call a
  configured identity list “Discord authorization.”
- DFX names transport events and REST operations. Domain records must not use a
  DFX class or handler name as their product identity.

# 0013 — Model elapsed waits as explicit controller delays

Status: accepted (design interview, 2026-08-08); implementation pending

## Context

Some Scenarios need elapsed time between two instructions or between repeated
application actions. Settlement is the wrong mechanism: it waits for a product
condition, and its safety bound belongs to execution policy. Absolute schedules
and fixed cadences also require missed-deadline and overrun policy that these
Scenarios do not yet need.

## Decision

Add `wait <duration>` as one ordered Scenario instruction. It requests a
positive minimum delay on the runner's monotonic controller clock before the
next instruction begins. The normalized instruction carries milliseconds; the
trace records requested and completed evidence including actual elapsed
controller time. The ordinary post-instruction system observation occurs after
completion.

Add `with <duration> between` to repeated action blocks. It means fixed-delay
pacing: the first child action begins immediately, then each acknowledged child
except the last is followed by the requested minimum delay before the next
child is invoked. Action execution time is excluded from the gap and slow
actions extend total sequence duration. Each gap has its own trace evidence.

Durations are positive integers with `ms`, `s`, or `m` units and compile to
integer milliseconds. Waits and pacing do not imply exact scheduling,
Quiescence, Settlement, synchronization, State equality, or a performance
assertion. Logical time remains plan order. Absolute `at` schedules,
fixed-cadence `every` loops, overrun policy, and elapsed-time oracles remain
outside this decision.

## Consequences

The Scenario, trace, and artifact contracts advance together without a
compatibility bridge. The runner and viewer can distinguish intentional elapsed
gaps from operation latency while preserving the existing evidence boundary.
Cancellation or another run failure retains the completed trace prefix and
never fabricates wait completion.

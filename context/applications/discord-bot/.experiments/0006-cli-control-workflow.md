# Experiment 0006 - CLI and Bot control workflow

Date: 2026-08-23

## Question

Can a CLI plan and retroactively create a thread through a typed control
boundary while sharing the runtime workflow and remaining unable to bypass its
authorization and idempotency rules?

## Setup and oracle

`tmp/discord-bot/cli-control-prototype` contains strict Discord message URL
decoding, command parsing, JSON control client/server round trips, one shared
ThreadWorkflow, a fake journal/Discord port, and separated machine/audit output.
Plan must not mutate; create requires apply and reason; raw RPC must enforce the
same guards; repeats and concurrent automatic/Discord/CLI calls must create at
most once.

## Results

`bun test tmp/discord-bot/cli-control-prototype/src/prototype.test.ts` passed
10/10 tests with 30 assertions. Three concurrent trigger kinds produced one
Discord create, one `Created`, and two `AlreadySatisfied` outcomes. Malformed or
unguarded direct RPC requests could not bypass the workflow.

The first implementation exposed a concurrency race; adding one per-source
journal claim made the oracle green.

## Conclusion

The thin CLI/RPC/shared-workflow shape is viable. Its in-memory claim is not a
production journal; experiment 0007 supplies the required SQLite/crash proof.

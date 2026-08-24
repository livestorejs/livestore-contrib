# DELTA-001 - Runtime requirements predate the local implementation

## Status

Open.

## Confirmed divergence

The context paragraph in [`requirements.md`](../requirements.md) says that no
product implementation exists in this repository. That sentence is stale: the
private `apps/discord-bot` workspace now implements the DFX runtime, feature
handlers, durable journal, control RPC and CLI, health projection, and
credential-free E2E seams. The exact local and immutable-artifact evidence is
recorded in [experiment 0010](../../.experiments/0010-implemented-tracer-bullet.md).

The requirements file is protected, so this delta records the drift without
silently changing the accepted contract. No live Discord deployment is claimed.

## Closure

A maintainer may replace the stale context sentence with the narrower truthful
statement that no live staging or production realization exists. Closing this
documentation delta does not close the application's live-deployment delta.

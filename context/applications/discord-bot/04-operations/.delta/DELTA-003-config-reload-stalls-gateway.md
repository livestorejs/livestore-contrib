# DELTA-003 - Runtime Config Reload Stalls the Gateway Supervisor

Status: open

## Divergence

A runtime config reload (`PUT /admin/config` with `reload: true`) persists and
activates the new revision, but the Gateway supervisor it starts never reaches
READY or RESUMED. Staging stays not-ready until the next deploy restarts the
Durable Object. A deploy always boots the supervisor to ready.

## VRS

The operations requirements expect config changes to converge without a
deploy: revisioned compare-and-swap config with reload, and gateway-aware
readiness (see [decision 0008](../.decisions/0008-separate-rollout-evidence.md)
for the evidence split). Reload convergence is part of the operational
admission evidence.

## Implementation

Observed on staging, 2026-09-26, releases `15642b3` through `2d383bb`:

- After a reload, `/readyz` returns 503 with `supervisorReady=false` and
  `gatewayHealthy=false`; journal, session and error checks stay true.
- Runtime status stays frozen: supervisor `resuming`, current attempt
  `connecting`, attempt 1, no `lastError`. Even a 30 s establishment deadline
  never fires.
- Every 5 s alarm tick logs `gateClaimed=false supervisor=resuming`: the gate
  is held by a supervisor fiber that exists but does not progress.

The old fiber was explicitly interrupted and awaited, and the gate released;
the alarm did start a new supervisor. The remaining lifetime bug was at the
Alchemy invocation boundary: `DurableObjectBridge` executes each admin/alarm
call with its own scope and closes it after the response. `BotState` previously
forked the gateway from inside the alarm with `Effect.forkDetach`, which
inherited that call's context (including scoped services) even though the fiber
was detached from the parent. On the reload path, the replacement was therefore
not owned by the Durable Object instance; its connection and establishment
deadline could remain stalled after the alarm returned. The instance now
captures its Effect context during construction and starts every gateway fiber
from that context instead. The old fiber is still interrupted and awaited
before the next one starts. A regression closes the triggering call scope on
each of two consecutive live-session reloads and requires RESUMED both times;
the former alarm-context fork hangs on the first reload.

The alarm handoff and bounded establishment remain. This delta stays open
until same-config reload twice on staging returns `/readyz` to 200 within the
30 s establishment deadline, with `[bot-state] gateway established
READY/RESUMED` after each restart.

## Direction

update implementation

## Resolution Signal

A same-config reload on staging returns `/readyz` to 200 with all checks true
within the establishment deadline, twice in a row, with the `[bot-state]` tail
showing the post-reload supervisor reaching READY or RESUMED.

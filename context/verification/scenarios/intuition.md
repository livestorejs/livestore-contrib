# Scenario Verification Realization — Intuition

_For: contributors reproducing or diagnosing sync behavior · Assumes:
[core verification intuition](https://github.com/livestorejs/livestore/blob/main/context/02-system/09-verification/intuition.md)
and [requirements.md](./requirements.md) · Covers: what a Scenario makes
observable and why the artifact and viewer are useful_

## Turn a sync story into evidence

A `.scenario.yaml` file reads as a distributed sync story—Clients write,
disconnect, reconnect, join late, or lose access to a backend—and a
deterministic compiler turns those instructions into the exact portable plan
run through real LiveStore participants. The runner records one semantic trace
instead of leaving the result spread across process logs, browser consoles, and
database snapshots.

That trace makes several questions answerable from one place:

- Which Clients and sessions existed, and when were they connected?
- Which instructions were issued, and did they succeed, fail, or remain
  uncertain?
- What did each participant and the backend observe about pending Events,
  Eventlogs, and materialized State?
- Did recovery complete, did the system reach Settlement, and which evidence
  supports each oracle verdict?

Acknowledgement, observation, recovery, Settlement, correlation, and explicit
causation remain separate facts. The visualization must not turn temporal
proximity or sampled state into stronger evidence than the runner recorded.

Most stories do not end with authored synchronization machinery. Final
expectations establish the stable observation point they need, while a Scenario
without explicit expectations defaults to pending resolution and exact ordered
Eventlog convergence for every session still running. An explicit `settle`
appears only when a later instruction depends on an intermediate stable point.
How long the runner waits is selected with the execution configuration, not
embedded in the portable story.

Elapsed time is explicit when it is part of the story. `wait 2s` means that the
controller intentionally leaves at least that gap before continuing; a repeat
can likewise request a fixed gap between acknowledged actions. Those delays do
not claim that the system settled or met a deadline. The trace records what was
requested and how much controller-monotonic time actually elapsed, so the
viewer can separate intentional idle time from slow work.

YAML stays declarative even when a workload needs computation. Application-neutral
trusted TypeScript helpers expand to ordinary Scenario instructions before
execution. A one-off helper may sit beside its Scenario as `name.helpers.ts`,
but that companion contains the implementation itself rather than forwarding
to another catalogue. The runner never loads those modules. It receives the
same complete serializable plan whether its instructions were written directly
or expanded by a helper.

## One Scenario, different execution boundaries

The portable model is shared across in-process, isolated Node process, and
persistent-browser profiles. Changing profile moves the participant boundary
without rewriting the Scenario: a fast controlled run can use the mock backend,
while every compatible profile can exercise the real `sync-cf` Worker and
Durable Object either under local workerd or, when selected explicitly, on
Cloudflare. Browser runs additionally cross OPFS, SharedWorkers, Web Locks, and
multi-session leadership.

Both `sync-cf` realizations place participant traffic behind the same
Scenario-owned availability boundary while the authoritative observer remains
direct. The cloud realization is opt-in: it attaches to a compatible endpoint
or uses maintainer-supplied Wrangler credentials to deploy and reuse a dedicated
Worker. Ordinary local and CI execution never provisions external resources.

Each profile advertises its capabilities before execution. Unsupported
controls or observations are rejected rather than silently simulated, so a
passing artifact says which concrete system was actually exercised.

## Evidence first, replay second

Headless execution is authoritative. A completed artifact preserves the
normalized input, execution identity, seed, trace, observations, outcomes,
snapshots, and verdicts—including partial evidence from failed runs. The React
viewer projects that immutable artifact into topology, timelines, operation
history, playback, and inspection views; it does not inspect participants or
change the verdict.

This separation lets a failure be saved, shared, and examined after its
processes and browser contexts are gone. It also lets Storybook and Playwright
exercise the same diagnostic states contributors see during investigation.

For a graphical walkthrough, see the
[Scenario runner visual explainer](./scenario-runner-explainer.html). It is
supporting, non-normative material; [requirements.md](./requirements.md) and
[spec.md](./spec.md) define the realization contract.

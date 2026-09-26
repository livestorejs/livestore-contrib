# DELTA-004 - E2E Actor Lacks Message Content and Manage Messages

Status: open

## Divergence

The live E2E matrix assumes the E2E Actor bot can read human-authored fixture
content and delete fixtures during ledger recovery. On staging it can do
neither, so operator and human-assisted lanes cannot correlate or recover.

## VRS

Operations requirements keep the E2E Actor as the cleanup and observation
identity for the live matrix, with exact, ledger-recoverable cleanup (see
[decision 0008](../.decisions/0008-separate-rollout-evidence.md)).

## Implementation

Tracer run on staging, 2026-09-26 (`319605a`):

- `automated-author-rejected` PASS.
- `operator-retroactive` FAIL: actor REST reads of the human fixture return
  empty content. The actor application has no Message Content intent, so marker
  correlation fails.
- Ledger recovery failed: the actor's REST delete returned 403 because it has
  no Manage Messages permission in the test channels. The fixture was deleted
  by its author through the official client instead.
- A Discord REST error from the harness printed the actor's Authorization
  header to the terminal. The token is being rotated, and the harness is being
  changed so credentials cannot be rendered.

## Direction

update implementation

## Resolution Signal

The E2E Actor has a rotated token, the Message Content intent enabled, and
Manage Messages on both test channels. A tracer run on staging PASSes both
scenarios, with every ledger entry resolved by the actor.

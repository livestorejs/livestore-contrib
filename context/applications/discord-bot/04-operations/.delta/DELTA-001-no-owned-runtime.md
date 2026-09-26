# DELTA-001 - Cloudflare Production Admission Is Incomplete

Status: open

## Divergence

Cloudflare staging now supplies the canonical Worker and singleton Durable
Object realization, but exact-release functional and production-operational
admission evidence is incomplete.

## VRS

[Decision 0007](../.decisions/0007-use-cloudflare-canonical-host.md) selects the
canonical host. Requirements R07-R09, R12-R14, and R18-R19 define functional
proof, operational proof, deployment receipts, rollback, and production gates.

## Implementation

Source, an Alchemy stack, and a reachable staging runtime exist. The historical
Discord application remains reserved and cannot satisfy the fresh
environment-identity contract.

The functional gate has `0/11` canonical live-matrix lanes at PASS. This is a
functional verdict only; local or credential-free receipts do not change it.

The operational gate is separately BLOCKED by CI runner admission: the runner
fails during startup, while the deployment workflow remains queued with zero
jobs admitted. The required 24-hour and 72-hour reconnect soaks are UNRUN.
Neither operational status changes the functional lane count.

## Direction

update implementation

## Resolution Signal

Provision and inventory fresh disjoint staging and production applications,
retain the runtime, historical bot, and E2E Actor memberships through the full
matrix, capture both verdicts from
[decision 0008](../.decisions/0008-separate-rollout-evidence.md), then uninstall
only the historical staging-guild membership and retain the E2E Actor. Enable
production only after both verdicts pass, and capture passive production
identity, readiness, deployment, rollback, diagnostic-policy, and sanitized
receipt evidence satisfying the operations requirements.

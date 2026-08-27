# DELTA-002 - Historical Content-Bearing Telemetry

Status: open

## Divergence

The historical implementation emitted message and prompt previews without an
accepted access or retention contract.

## VRS

Requirements R10-R11 prohibit raw message, prompt, generated-answer, docs, and
secret content in provider diagnostics and durable operational records.

## Implementation

This record covers the legacy implementation and any replacement that reuses
its telemetry shape. It does not assert that the Cloudflare realization is
currently leaking content. See
[the investigation reference](../.reference/0001-current-state-investigation.md).

## Direction

update implementation

## Resolution Signal

The sentinel leak test passes through success, typed failure, defect,
reconnect, provider-diagnostic, and durable-record paths with no content or
secret sentinel present.

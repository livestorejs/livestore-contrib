# DELTA-002 - Historical Content-Bearing Telemetry

Status: open

The privacy contract prohibits raw message, prompt, generated-answer, and docs
  content in local logs, exported spans, and receipts
(LSC.APP.DISCORD.OPS-R10 through R11). The historical implementation emitted
message and prompt previews without an accepted access or retention contract.
See [the investigation reference](../.reference/0001-current-state-investigation.md).

This delta describes the legacy implementation and any replacement that reuses
its telemetry shape. It does not assert that an undeployed contrib
implementation is currently leaking content.

Close condition: remove content-bearing fields, implement explicit trace and log
allowlists, declare the best-effort Tempo sink and local-journal boundary, and
pass the sentinel leak test through success, typed failure, defect, reconnect,
local-log, exported-span, and receipt paths.

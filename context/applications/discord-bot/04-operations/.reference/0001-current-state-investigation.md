# Current-State Investigation Reference

Captured: 2026-08-23

This is non-normative evidence for the operations VRS. The historical source is
the private [`livestorejs/discord-bot`](https://github.com/livestorejs/discord-bot)
repository at main commit `861ece21`; the target contract lives in the sibling
requirements and spec, not here.

## Runtime ownership evidence

- The historical repository has no GitHub Actions deployment workflow,
  deployment environment, release, declarative service, or current host record.
- Its only documented observability endpoint names `dev2`; that host no longer
  resolves and is absent from the current machine roster.
- Current host `dev3` had no matching bot process or listener on the historically
  documented ports at inspection time.
- The Discord application and guild/invite still exist. Those control-plane
  objects do not prove that a Gateway consumer is connected.
- A current authenticated Discord API inventory found that historical
  application `1310646763505582171` owns Molty/Clawdbot global commands. It is
  therefore not an available LiveStore production identity and must remain
  untouched; both redesigned environments require fresh applications.
- The last positive deployment claim found was in an unmerged, conflicting pull
  request updated in October 2025. It did not identify a host or durable receipt.

Conclusion: the operational outage is strongly supported, while the final
process-level trigger cannot be distinguished. No current owned runtime or
external readiness proof was found. The historical application is live control
plane state owned by a different command surface, not a recovery target.

## Historical telemetry evidence

The old implementation included message and prompt previews in telemetry. No
accepted privacy, access, or retention contract accompanied those fields. This
is evidence of a boundary to remove, not a contract to preserve.

## Source replay evidence

An isolated install and TypeScript build succeeded. The committed suite failed
with 7 message-handler failures (21 passing, 11 transport tests skipped). A
temporary counter-experiment enabling 10 skipped WebSocket/Gateway tests failed
10 of 10, and lint reported 13 diagnostics. The source checkout was restored
after the experiment.

# DELTA-002 — Typed failure taxonomy collapses to UnknownError

Status: open

The core contract requires a typed failure taxonomy: push rejection and backend
failures are tagged error families with a uniform recovery rule (rebase and
retry), and defects stay distinguishable from expected conditions like being
offline (core LS.SYS.SYNC-R03). This provider realizes only the offline half.

- **Offline is distinguished:** ping/connect timeouts flip `isConnected` to
  `false` (`src/sync-provider.ts:112-119`, `:126-128`); this is the one expected
  condition modeled as itself.
- **Everything else is a defect:** non-2xx pulls and pushes, SSE `error` frames,
  and `S2LimitExceededError` are all mapped to `UnknownError`
  (`src/sync-provider.ts:159-161`, `:264-288`). The core `IsOfflineError`,
  `ServerAheadError`, and the `RejectedPushError` family are never produced.

Where DELTA-001 concerns the *mechanism* (no fast-forward arbitration), this
delta concerns the *shape of what surfaces*: even a backend that did reject or
signal "you're behind" would reach the engine as an opaque `UnknownError` — a
defect the recovery loop is told not to retry — rather than an expected sync
condition. The two deltas overlap on the missing `ServerAheadError` path but are
otherwise independent: limit and transient backend failures collapse the same
way regardless of arbitration.

Note the recovery posture is not absent, only coarse: pull and push retry on a
default schedule (`recurs(2) ∘ spaced(100ms)`, `src/sync-provider.ts:81`,
`:193`, `:300`), and `S2LimitExceededError` is carried as a structured `note` +
payload inside the `UnknownError` (`src/sync-provider.ts:269-285`) — so the
information exists, it is just not lifted into the typed families the core
recovery rules key on.

Close condition: the provider maps proxy responses to the core taxonomy —
offline → `IsOfflineError`, non-fast-forward → `ServerAheadError` (jointly with
[DELTA-001](./DELTA-001-no-fast-forward.md)), oversize/limit → the transport
family — reserving `UnknownError` for genuine defects; or the core contract is
refined to accept a provider that distinguishes only offline, and
LSC.SYNC.S2-R07 is restated against it.

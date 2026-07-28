# DELTA-001 — Leadership handover not realized on Node

Status: open

The core runtime contract requires leadership handover: when a leader context
goes away another eligible context takes over without data loss, and sessions
observe leadership via a lock-status signal (core LS.SYS.RT-R04). The Node
adapter does not realize this. The session is unconditionally the leader
(`isLeader: true`, `src/client-session/adapter.ts:313`) and lock status is a
constant `has-lock` `SubscriptionRef` carrying a `// TODO actually implement
this multi-session support` (`src/client-session/adapter.ts:246`).

This is a **current limitation, not a settled design**: the TODO signals intent
to support multiple sessions eventually. Today, concurrent sessions on one
`storeId+clientId` are unsupported and warned against
(`src/client-session/adapter.ts:53`); the only cross-instance coordination is a
shutdown `BroadcastChannel` (`src/shutdown-channel.ts:9`).

Single-leader (core LS.SYS.RT-R01) _is_ satisfied — by construction, since there
is only ever one session.

Close condition: either multi-session leadership is implemented on Node (handover

- real lock status), or the core contract is refined to make handover
  optional for single-context adapters and LSC.ADAPT.NODE-R03 is restated as a
  conformant realization of that optional contract.

# DELTA-001 — Leadership handover not realized on Expo

Status: open

The core runtime contract requires leadership handover: when a leader context
goes away another eligible context takes over without data loss, and sessions
observe leadership via a lock-status signal (core LS.SYS.RT-R04). The Expo
adapter does not realize this. The session is unconditionally the leader
(`isLeader: true`, `src/index.ts:189`) and lock status is a constant `has-lock`
`SubscriptionRef` (`src/index.ts:143`).

This is a **current limitation, not a settled design**: the shutdown channel is a
same-thread channel (`WebChannel.sameThreadChannel`, `src/shutdown-channel.ts:6`)
carrying a comment that a multi-threaded version is needed "once we'll implement
multi-threading for the Expo adapter" (`src/shutdown-channel.ts:4`). Today there
is one JS thread and one session, so there is no second context to hand over to.

Single-leader (core LS.SYS.RT-R01) *is* satisfied — by construction, since there
is only ever one session.

Close condition: either multi-session leadership is implemented on Expo (handover
+ real lock status), or the core contract is refined to make handover optional
for single-context adapters and LSC.ADAPT.EXPO-R03 is restated as a conformant
realization of that optional contract. Mirrors the Node adapter's
[DELTA-001](../../node/.delta/DELTA-001-no-handover.md).

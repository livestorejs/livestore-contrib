# Rust Client Leader — Requirements

Role: the leader sync processor and the provider-facing backend contract.

## Context

Realizes core [`03-sync/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync) (`LS.SYS.SYNC-*`, its syncstate and
processor children) and the leader half of [`04-runtime/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/04-runtime) in
`rust/crates/livestore-sync`. Parent: [../requirements.md](../requirements.md).
Porting reference: [`contributor-docs/rust/leader-port.md`](../../../../contributor-docs/rust/leader-port.md).

## Requirements

- **LSC.CLIENT.RUST.LEAD-R01 Same processor behavior:** The leader follows
  `LeaderSyncProcessor`: one mailbox actor, the push plan replaced after every
  upstream batch, rebase instead of reject, pull before push.
  `refines: LS.SYS.SYNC.SS-R02, LS.SYS.SYNC.SS-R03, LS.SYS.SYNC.PROC-R02, LS.SYS.SYNC.PROC-R04`
- **LSC.CLIENT.RUST.LEAD-R02 Same provider contract:** `trait SyncBackend`
  (`connect`, `pull`, `push`, `ping`, `is_connected`, `metadata`,
  `supports`) carries the TS failure taxonomy as per-method error enums.
  `refines: LS.SYS.SYNC-R02, LS.SYS.SYNC-R03`
- **LSC.CLIENT.RUST.LEAD-R03 Same retry and shutdown:** Transient failures retry
  with bounded backoff; a backend-id mismatch with `onBackendIdMismatch: reset`
  wipes local data and shuts down with a cause sessions can observe.
  `refines: LS.SYS.SYNC.PROC-R01, LS.SYS.RT-R06, LS.SYS.RT-R10`

# Rust Client SQLite — Requirements

Role: the SQLite library the Rust client links, and the leader's persistence on
top of it.

## Context

Realizes the portable SQLite substrate (core LS.SYS.RT-R09) and the SQLite state
contract ([`02-state/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/02-state), `LS.SYS.STATE-*`) in
`rust/crates/livestore-sqlite-sys` and `rust/crates/livestore-sqlite`. Parent:
[../requirements.md](../requirements.md).

## Requirements

- **LSC.CLIENT.RUST.SQLITE-R01 Same SQLite as wa-sqlite:** The native build uses
  the same SQLite version, source id, compile options, extension functions, and
  behavior as the wa-sqlite build core adapters load, except the deviations listed
  in the spec. `rust/scripts/check-sqlite-build.sh` checks it.
  `refines: LS.SYS.RT-R09`
- **LSC.CLIENT.RUST.SQLITE-R02 Same persistence:** Eventlog and state databases,
  materialization with session changesets, the journal, rollback, and rebuild
  produce the same rows as `LeaderPersistence`, checked against fixtures from
  `rust/scripts/gen-leader-fixtures.ts`.
  `refines: LS.SYS.STATE-R01, LS.SYS.STATE-R03, LS.SYS.STATE.SQLITE-R06`

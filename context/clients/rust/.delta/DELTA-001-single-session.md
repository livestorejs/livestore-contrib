# DELTA-001 — Leadership handover not realized in the Rust client

Status: open

The core runtime contract requires leadership handover between client contexts
(core LS.SYS.RT-R04). The Rust client runs one session per store with its leader
in the same process (`rust/crates/livestore/src/adapter.rs`), so leadership is
constant and there is nothing to hand over. Two processes on one store directory
are not coordinated.

Single leader (core LS.SYS.RT-R01) holds by construction.

Close condition: a multi-session Rust topology with handover is built, or the
core contract makes handover optional for single-context adapters (the same
condition as the Node adapter's DELTA-001).

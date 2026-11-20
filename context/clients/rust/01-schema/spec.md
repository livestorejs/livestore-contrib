# Rust Client Schema — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Surface

`Schema::builder().table(..).client_document(..).event(&EventDef::<Args>::synced(name), |args, ctx| Ok(stmt))`.
Event args are serde types. Column kinds: `text`, `integer`, `real`, `blob`,
`boolean`, `datetime`, `datetime_millis`, `json`, with primary keys,
autoincrement, nullability, defaults, composite keys, and indexes. Unknown events
follow `UnknownEventHandling::{Warn, Ignore, Fail, Callback}`. The query builder
(`query_builder.rs`) ports `api.ts`/`impl.ts`/`astToSql.ts`; migrations by
per-table schema hash live in `migration.rs`.

## Hashes

Hashes never leave the device: table hashes decide when a table is rebuilt, and
event hashes only produce a warning on rematerialization. So the Rust client
hashes its own description of a `ValueSchema` (`fingerprint::describe`) instead of
Effect's internal JSON. Its hashes stay the same from run to run but differ from
TypeScript's. Table fingerprints keep core's descriptor, so tables without JSON
columns hash exactly like core. Recursive schemas (`suspend`) are described once
and then referenced.

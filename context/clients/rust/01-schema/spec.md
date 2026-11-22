# Rust Client Schema — Spec

Builds on [requirements.md](./requirements.md).

## Status

Draft.

## Surface

An event is a serde struct with `#[derive(Event)]` (`livestore-macros`):
`#[event(name = "v1.TodoCreated")]`, plus `client_only` and `deprecated = "..."`.
The derive builds the `EventDef` once, with the args schema taken from the field
types (`SchemaType`) and their serde names, so the name, the args type and the
schema cannot drift apart. The schema registers it with
`Schema::builder().table(..).client_document(..).materialize::<E, _>(|args, ctx| Ok(stmt))`.
The `EventDef` builder (`EventDef::synced(..)`, `.event(&def, ..)`) exists only
with the `testing` feature, for the ported core tests, whose events have dynamic
names; apps have exactly one way to define an event. `DateFromString` always
holds a date in JavaScript's `Date` range (`from_millis`, `now`), so encoding
event args cannot fail. Column kinds: `text`, `integer`, `real`, `blob`,
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

## Syncstate

`livestore-core` ports `sync/syncstate.ts` (`merge`) and is checked against
fixtures from `rust/scripts/gen-syncstate-fixtures.ts`; the leader in
[03-leader](../03-leader/spec.md) uses it.

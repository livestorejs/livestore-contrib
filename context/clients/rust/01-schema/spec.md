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

Table fingerprints hash the Effect `SchemaRepresentation` of JSON columns; event
`schemaHash` is Effect `Hash.string` of the schema AST JSON. Both derive from
`ValueSchema` (`representation.rs`). Gaps: recursive (`suspend`) and opaque
declaration schemas need a TS-dumped `Column::schema_repr`; events without
`EventDef::schema` hash as `Schema.Any`.

## Syncstate

`livestore-core` ports `sync/syncstate.ts` (`merge`) and is checked against
fixtures from `rust/scripts/gen-syncstate-fixtures.ts`; the leader in
[03-leader](../03-leader/spec.md) uses it.

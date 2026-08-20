# 0001 — Adopt core's state-db base name

Status: accepted

## Context

The Expo adapter named its persisted state database
`livestore-{schemaHashSuffix}@{formatVersion}.db`, where the suffix was the
literal `fixed` under manual migration and the schema hash otherwise.

Core removed `strategy` from `MigrationOptions`, so the `manual` branch no longer
compiles, and it introduced `getStateDbBaseName(schema)` in
`@livestore/common/schema` — documented as "the schema-keyed base name shared by
persisted state databases", with adapters appending their own storage-format
namespace and extension.

## Evidence

`@livestore/adapter-cloudflare` already consumes the helper exactly this way:
`` `${getStateDbBaseName(schema)}@${liveStoreStorageFormatVersion}.db` ``. The
Node adapter's own local helper independently produced `state{hash}@{version}.db`
— byte-identical to the shared helper's output — so on Node the change emits the
same filename it always did.

Expo was the outlier: its `livestore-` prefix matched no other adapter.

## Options

| Option | Consequence |
| --- | --- |
| Keep the `livestore-` prefix, inline the hash | No rename for non-manual users; keeps naming hand-rolled and Expo divergent |
| Adopt `getStateDbBaseName` | One shared definition across contrib and core; renames the state db for every Expo user |
| Rename the eventlog to match too | Rejected outright — the eventlog is the durable source of truth |

## Decision

Adopt `getStateDbBaseName`.

The rename costs one rematerialization, not data loss: the state database is
derived data, rebuilt from the eventlog, and the eventlog filename is
deliberately left untouched. Expo therefore pairs `state{hash}@{version}.db`
with `livestore-eventlog@{version}.db`. That pair is inconsistent, and
knowingly so: aligning the state name with core is worth more than internal
symmetry, and renaming the eventlog to restore symmetry would orphan real user
data.

Users who relied on `strategy: 'manual'` pinning the state db to a stable
`fixed` name lose that; the capability no longer exists upstream.

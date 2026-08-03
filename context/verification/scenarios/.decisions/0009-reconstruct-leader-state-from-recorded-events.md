# 0009 — Reconstruct sampled Client Leader State from recorded Event facts

Status: accepted (first replay-viewer increment, 2026-08-03)

## Context

Trace v3 Leader observations retain Event name, arguments, recorded origin,
position, parent position, and disposition. That is enough to replay one
observation's Event facts through a registered Scenario Application's actual
schema and materializers, but it is not a captured SQLite database. Leader and
session observations can differ, captures are not atomic distributed
snapshots, and `eventRef` is only a navigation correlation. Replaying on every
timeline animation frame would also waste Store boot and materialization work.

## Decision

At a viewer cursor, make only Client Leader roles eligible for State
inspection. Select the latest `leader.sync.observed` record for that Client at
or before the cursor and label every result with its source capture and record.
Lazily create an isolated in-memory LiveStore with the artifact's registered
Scenario Application schema, convert that observation's recorded Event facts
without using `eventRef` as lineage, and replay them through LiveStore's real
materializers. Display generic user-table rows along with Client/Leader scope,
source capture/record, local and upstream heads, pending count, and Event count.
Represent loading and materialization failure as ordinary viewer states.

Call this result **reconstructed** or **replayed State**. It is a derived view
of one sampled Leader Event list, not the Client's actual historical database,
not session State, and not an atomic distributed snapshot. The completed
artifact and trace remain authoritative, and the viewer remains replay-only.

Materialization starts only when the user opens a Leader State inspector. Cache
completed and in-flight work by artifact/application, Client, and source record
so cursor playback does not rematerialize every frame; cursor changes merely
select another source record until the inspector requests it.

## Consequences

The first increment can inspect arbitrary registered Scenario Applications
without recurring raw database snapshots or a trace-version change. A source
record change is visible provenance rather than a claim of exact lineage.
Session reconstruction, provenance hardening across historical Application and
materializer revisions, and explicitly opted-in captured SQLite snapshots stay
as follow-ups. Such snapshots would require their own capability, retention,
and artifact semantics rather than silently replacing replay reconstruction.

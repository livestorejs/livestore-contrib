# LiveStore leader: implementation spec for the Rust port

Scope: everything in the leader **except** `sync/syncstate.ts` merge (separate note) and the WS wire
protocol (separate note). Target shape = `packages/@livestore/adapter-cloudflare` (one process, no
multi-tab client-session layer). The Rust app pushes already-numbered events straight into the leader.

Paths below are relative to core's `packages/@livestore/common/src/` (`repos/livestore/` here) unless prefixed.

---

## 0. Vocabulary

- `SeqNum` (client composite) = `{ global: u64, client: u64, rebaseGeneration: u64 }`.
  `schema/EventSequenceNumber/client.ts`.
  - `ROOT = {0,0,0}` (client.ts:212). `DEFAULT` client = 0.
  - **Ordering / comparison ignores `rebaseGeneration`**: `isGreaterThan`, `isGreaterThanOrEqual`
    compare `(global, client)` only (client.ts:147-155). `compare` (client.ts:64) also sorts by
    global then client (check the tail of the fn if you need a gen tiebreak). `isEqual` compares all
    three (client.ts:144).
  - "Same position" = `global` and `client` equal, generation ignored
    (`LeaderPersistence.ts:179`).
  - `nextPair({seqNum, isClientOnly, rebaseGeneration?})` (client.ts:224-253):
    - client-only: `seqNum = {g, c+1, gen}`, `parent = seqNum(prev)` (full prev, incl. its gen).
    - synced: `seqNum = {g+1, 0, gen}`, `parent = {g, 0, prev.gen}` (always `client: 0`).
    - `gen` defaults to `prev.rebaseGeneration`.
- Event encoded (`LiveStoreEvent.Client.Encoded`): `{name, args(JSON), seqNum, parentSeqNum, clientId, sessionId}`.
- Global event (on the wire): `toGlobal` (schema/LiveStoreEvent/client.ts:96) =
  `{name, args, seqNum: seqNum.global, parentSeqNum: parentSeqNum.global, clientId, sessionId}`.
  `fromGlobal` sets `client=0, rebaseGeneration=0` on both.

---

## 1. The two SQLite databases

In the CF adapter both live in the DO: the **state DB** is a wa-sqlite file in a VFS named
`state<schemaHash>@<liveStoreStorageFormatVersion>.db` (`adapter-cloudflare/src/make-adapter.ts:70`,
`schema/state/sqlite/persistence.ts:11`, `version.ts:38` → currently `6`); the **eventlog DB** is the
DO's own `storage.sql` (make-adapter.ts:84). In Rust: two separate SQLite files (or two connections).
Old state files are deleted after boot (`adapter-cloudflare/src/state-files.ts`); a schema change
therefore = new empty state file = full rebuild from the eventlog.

### DDL generation (applies to every table)

`schema-management/migrations.ts:152-208` + `schema/state/sqlite/column-spec.ts`:

```
create table if not exists "<name>" (<colspec>) strict
create [UNIQUE] index if not exists "<idxName>" on "<name>" ("c1", "c2")
```
colspec per column: `"<name>" <type> [primary key] [autoincrement] [not null] [default ...]`
(exact spacing: fields joined by single spaces, empty pieces leave double spaces — irrelevant for SQLite).
- Single PK column → inline `primary key` (no `not null`). Composite PK → trailing
  `PRIMARY KEY ("a", "b", ...)`, and each pk column gets `not null` only if `nullable === false`.
- Column types are only `text | integer | real | blob`. DSL sugar
  (`schema/state/sqlite/db-schema/dsl/field-defs.ts:128-242`): `json` → text (JSON string),
  `datetime` → text (ISO string), `datetimeInteger` → integer (ms), `boolean` → integer (0/1).
- `default`: none → nothing; thunk default → nothing (applied in app code); `null` → `default null`;
  SQL default → `default <sql>`; else encoded value, quoted `'..'` for text.
- **Tables are STRICT.** Bind values must match the column type exactly.

### 1a. Eventlog DB (`schema/state/sqlite/system-tables/eventlog-tables.ts`)

Created by `initEventlogDb` (`leader-thread/eventlog.ts:23-42`) with `create-if-not-exists`,
`skipMetaTable: true` (no `__livestore_schema` row in this DB).

```sql
create table if not exists "eventlog" (
  "seqNumGlobal" integer, "seqNumClient" integer, "seqNumRebaseGeneration" integer,
  "parentSeqNumGlobal" integer, "parentSeqNumClient" integer, "parentSeqNumRebaseGeneration" integer,
  "name" text, "argsJson" text, "clientId" text, "sessionId" text,
  "schemaHash" integer, "syncMetadataJson" text,
  PRIMARY KEY ("seqNumGlobal", "seqNumClient", "seqNumRebaseGeneration")
) strict;
create index if not exists "idx_eventlog_seqNumGlobal" on "eventlog" ("seqNumGlobal");
create index if not exists "idx_eventlog_seqNum" on "eventlog" ("seqNumGlobal","seqNumClient","seqNumRebaseGeneration");

create table if not exists "__livestore_sync_status" (
  "head" integer primary key, "backendId" text
) strict;
INSERT INTO __livestore_sync_status (head) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM __livestore_sync_status);
```
(Nullability: DSL columns default to `nullable: false` → `not null`, except `backendId` which is
nullable. Dump the real DDL from a TS run (`sqlite_master`) for byte-exact parity if needed.)

Column encodings:
- `argsJson`: `JSON.stringify(args ?? {})` (eventlog.ts:254).
- `syncMetadataJson`: JSON of an Effect `Option<Json>`: exactly `{"_tag":"None"}` or
  `{"_tag":"Some","value":<json>}` (verified with effect v4 encoder).
- `schemaHash`: Effect `Schema.hash(eventDef.schema)` (32-bit int) or `UNKNOWN_EVENT_SCHEMA_HASH` for
  unknown events (materialize-event.ts:36-41, 61). Only used to log a warning during rebuild
  (rematerialize-from-eventlog.ts:76). Rust cannot reproduce Effect's hash → store your own stable
  hash; never compared against server data.
- PK includes `rebaseGeneration`, but deletes are by `(global, client)` only (see below).

Readers / writers:
| op | SQL | where |
|---|---|---|
| insert event | `INSERT INTO eventlog (all 12 cols) VALUES (...)` | `insertIntoEventlog` eventlog.ts:216 (from `materializeEvent`) |
| delete rolled-back | `DELETE FROM eventlog WHERE (seqNumGlobal, seqNumClient) IN ((?,?),...)` chunks of 100, in a savepoint | `deleteEvents` eventlog.ts:89 |
| set sync metadata on confirm | `UPDATE eventlog SET syncMetadataJson=? WHERE seqNumGlobal=? AND seqNumClient=?` | `updateSyncMetadataForDb` eventlog.ts:273 |
| local head | `select ... order by seqNumGlobal DESC, seqNumClient DESC limit 1` (ROOT if empty) | `getClientHeadFromDb` eventlog.ts:186 |
| pending at boot | all rows `seqNumGlobal >= backendHead`, keep `compare(e, since) > 0`, sort asc | `getEventsSince` eventlog.ts:47 |
| pull cursor | `SELECT syncMetadataJson FROM eventlog WHERE seqNumGlobal = <upstreamHead> ORDER BY seqNumClient ASC LIMIT 1` → `Some({eventSequenceNumber: head, metadata})`; `None` if head = 0 | `getSyncBackendCursorInfoForDb` eventlog.ts:302 |
| backend head | `select head from __livestore_sync_status` / `UPDATE ... SET head = <global>` | eventlog.ts:200-206 |
| backendId | `select backendId ...` / `UPDATE ... SET backendId = '<id>'` (string-interpolated!) | eventlog.ts:208-214; exposed to the sync backend as a KeyValueStore (make-leader-thread-layer.ts:141-179) |
| stream API | `seqNumGlobal > since [AND <= until] [name IN] [clientId IN] [sessionId IN] [AND seqNumClient <= 0 unless includeClientOnly] ORDER BY g,c LIMIT batch` | `getEventsFromEventlog` eventlog.ts:109 |

`backendId` is written by the sync backend implementation (via the KV store) when it first sees the
server's id, and compared by it; a mismatch surfaces as `BackendIdMismatchError` from push/pull.

### 1b. State DB (`schema/state/sqlite/system-tables/state-tables.ts`)

System tables (all created by `migrateDb`, in this order: `stateSystemTables` state-tables.ts:99):

```sql
"__livestore_schema"            ("tableName" text primary key, "schemaHash" text not null, "updatedAt" text not null) strict
"__livestore_schema_event_defs" ("eventName" text primary key, "schemaHash" integer not null, "updatedAt" text not null) strict
"__livestore_state_head"        ("id" integer primary key, "seqNumGlobal" integer not null, "seqNumClient" integer not null, "seqNumRebaseGeneration" integer not null) strict
"__livestore_materialization_journal" ("seqNumGlobal" integer not null, "seqNumClient" integer not null, "seqNumRebaseGeneration" integer not null, "changeset" blob) strict
   + index "idx_materialization_journal_id" ("seqNumGlobal","seqNumClient")   -- NO primary key
"__livestore_rebuild"           ("id" integer primary key) strict
```

- `__livestore_schema`: one row per table (system + user) = `fingerprint(tableAst)` + ISO time.
  Upserted by every `migrateTable` (migrations.ts:182-193). Informational in the current flow (see §4).
- `__livestore_schema_event_defs`: `INSERT OR REPLACE (eventName, Schema.hash, now)` for every event
  def; boot **fails** if a registered event name no longer exists in the schema
  (`schema-management/validate-schema.ts:13-21`). Note: tables are freshly created per state file, so
  in practice this only matters within one state file.
- `__livestore_state_head`: single row `id=1`, `INSERT OR REPLACE` (`StateHead.ts:33-46`). Read back
  as ROOT when missing. Updated inside every materialization savepoint and after rollback.
- `__livestore_materialization_journal` (`MaterializationJournal.ts`): one row per materialized,
  not-yet-confirmed event; `changeset` = SQLite session changeset bytes, or NULL for unknown events.
  - `record`: `DELETE WHERE g=? AND c=? AND gen=?` then `INSERT (g,c,gen,changeset)` (l.103-127).
  - `rollback(keys)`: sort keys **descending**, select their changesets (chunks of 100, padded by
    repeating the last key), fail if any key missing, apply `invert(changeset)` in that order (skip
    NULL), delete the rows; all in one savepoint (l.128-163).
  - `discardUpTo(k)`: `DELETE WHERE g < k.g OR (g = k.g AND c <= k.c)` (l.164-179).
- `__livestore_rebuild`: `INSERT OR IGNORE (id) VALUES (1)` only after a successful full rebuild
  (`recreate-db.ts:31`). Presence of all 5 system tables **and** this row = "state is complete"
  (`hasCompletedState` recreate-db.ts:22).
- User tables: from `State.SQLite.table(...)` defs → DDL above. Client documents
  (`schema/state/sqlite/client-document-def.ts:72-75`): table `(id text primary key, value text)`
  with value = JSON.

---

## 2. Materialization (`leader-thread/materialize-event.ts`)

`materializeEvent(event, {skipEventlog=false, syncMetadata=None})`:

1. Resolve event def (`resolveEventDef`, honours `schema.unknownEventHandling`: warn/ignore/fail/callback).
2. **Unknown event** (l.53-75): if `!skipEventlog` insert into eventlog with `UNKNOWN_EVENT_SCHEMA_HASH`;
   then in a state savepoint: `journal.record({key: seqNum, changeset: NULL})`, `stateHead.set(seqNum)`.
   Return hash None. No state change.
3. Known event:
   1. Decode args with the event schema, call materializer → SQL statements
      (`materializer-helper.ts:15-84`). Materializer result can be a string, `{sql, bindValues, writeTables}`,
      a query builder, or an array thereof. Bind values: object → keys rewritten to `$key` and only
      kept if the key text occurs in the SQL (`util.ts:59`); arrays are positional. A bare string SQL
      gets the encoded args as bind object. Materializers may run `query(...)` (SELECTs) against dbState.
   2. `materializerHash` = `Hash.string(JSON.stringify(statements))` only in dev mode, else None
      (l.89, materializer-helper.ts:114). Purely a dev diagnostic comparing leader vs session
      materializer output (`MaterializerHashMismatchError`). **Not needed in Rust** (no session layer);
      emit None.
   3. In a **state savepoint** (l.102-118):
      - `session = sqlite3session_create(db,'main'); sqlite3session_attach(session, NULL)` (all tables).
      - execute each statement.
      - `changeset = sqlite3session_changeset(session)`; `sqlite3session_delete`.
      - `journal.record({key: seqNum, changeset})` and `stateHead.set(seqNum)` (outside the session,
        so system-table writes are not in the changeset).
      Caveat: SQLite sessions ignore tables without a PRIMARY KEY → changes to such tables cannot be
      rolled back. Same in TS.
   4. If `!skipEventlog`: insert into eventlog with that event's schema hash (l.123-135).
4. Errors → `MaterializeError` (journal errors pass through).

Changeset apply conflict policy for rollback (`packages/@livestore/sqlite-wasm/src/make-sqlite-db.ts:236-262`):
`sqlite3changeset_apply(db, inverted, NULL, cb)` with cb: `DATA|CONFLICT → REPLACE`, otherwise `OMIT`.
Rust (rusqlite `session` feature): `Changeset::invert` + `apply` with the same conflict handler.

### Rollback / rebase order (`LeaderPersistence.persistUpstream`, LeaderPersistence.ts:112-170)
Inside `BEGIN` on state, `BEGIN` on eventlog (`withCoordinatedTransactions` l.184-224; commit **state
first, then eventlog**; on any failure ROLLBACK both; uninterruptible):
1. If `rollbackEvents` non-empty: `journal.rollback(keys)` (reverse order) → `stateHead.set(rollbackEvents[0].parentSeqNum)`
   → `deleteEvents(eventlog, keys)` (by (global,client)).
2. Materialize `plan.events` in order (each one writes state + journal + head + eventlog row);
   syncMetadata for each event = the pulled event at the same seqNum (`isEqual`, gen included) else None.
3. If `confirmedEvents` non-empty: update `syncMetadataJson` of eventlog rows of pulled events at the same
   position as a confirmed event (they are already materialized, not re-inserted).
4. `journal.discardUpTo(backendHead)`.
5. `UPDATE __livestore_sync_status SET head = backendHead.global`.
6. Read stateHead and return a receipt.

`persistLocal` (l.90-110): same transaction wrapper, just `materializeEvent` for each event (with
eventlog insert, syncMetadata None).

Note on CF: the DO-SQL eventlog drops BEGIN/COMMIT (make-adapter.ts:81-83); Rust should do real
transactions on both.

---

## 3. LeaderSyncProcessor (`leader-thread/LeaderSyncProcessor.ts`)

Single mailbox actor; only the loop mutates `model`. Background fibers (provider push, provider pull,
retry timers) only send messages. Every async operation carries an `operationId`; late results with a
stale id are ignored.

### Model (l.882-891)
```
lifecycle: starting|running|stopping|failed
syncState: {pending, upstreamHead, localHead}   (SyncState; merge = other note)
pull: disabled | streaming{pullId, pagination: between-pages|more-expected, attempt} | retry-wait{retryId, attempt} | completed
push: disabled | idle{queued} | in-flight{opId, attempt, batch, queued} | retry-wait{retryId, attempt, batch, queued} | awaiting-pull{queued}
localQueue: [LocalItem{requestId, index, event}]
upstreamQueue: [UpstreamBatch{pullId, batchId, events, pulledEvents, pageInfo}]
```
Initial (l.902-919): with backend: `pull=completed`, `push=idle{queued = pending.filter(!clientOnly)}`;
without backend: both `disabled`. Config: `localPushBatchSize=10`, `backendPushBatchSize=50`
(l.146-153), `onError` default `'ignore'`, `onBackendIdMismatch` default `'reset'`, `livePull` default true
(make-leader-thread-layer.ts:227-229).

### Boot sequence
`makeLeaderThreadLayer` (make-leader-thread-layer.ts:86-285):
1. `stateNeedsRebuild = !hasCompletedState(dbState)`; if so, wipe the state DB (import an empty DB) (l.122-137).
2. `initEventlogDb` (§1a).
3. Build sync backend (with backendId KV) and fork `syncBackend.connect` (l.141-184).
4. If rebuild needed: `recreateDb` (§4).
5. Initial SyncState (`getInitialSyncState` l.292-330):
   `backendHead = sync_status.head`, `localHead = max eventlog row`, assert `backendHead <= localHead.global`,
   `upstreamHead = {backendHead, 0, 0}`, `pending = getEventsSince({backendHead, 0, localHead.gen})`
   (i.e. every eventlog row strictly after `(backendHead, 0)`: unconfirmed synced events and all
   client-only events after the backend head).
6. `syncProcessor.boot` (l.718-742): fork the loop, send `Started`, resolve `bootDeferred` with localHead.
   `Started` → `lifecycle=running`, `startProviderPull(0)`, `startProviderPush()` (l.511-520) — so
   pending events from the previous run are pushed right away.
7. If `initialSyncOptions = Blocking{timeout}`, boot waits until a page with `pageInfo=NoMore` is durable
   or the timeout fires (l.332-377, 406-416).

### Local commit (Rust app → leader)
- Rust assigns numbers itself: take the push head = last queued local item's seqNum, else
  `syncState.localHead`; `nextPair({seqNum: head, isClientOnly: eventDef.clientOnly, rebaseGeneration: head.gen})`.
  (In TS the ClientSessionSyncProcessor does this; also replaces `SessionIdSymbol` in client-document
  set events with the real sessionId.)
- `push(events)` (l.690-716): register request, send `LocalPushRequested`, await completion = durable
  commit + publication + push scheduled.
- `LocalPushRequested` (l.527-548): `validatePushBatch(events, pushHead)` (l.1062-1132):
  - strictly increasing within batch, else `NonMonotonicBatchError`;
  - `pushHead >= batch[0]` → `LeaderAheadError`;
  - `batch[0].gen < pushHead.gen` → `StaleRebaseGenerationError`;
  - each event must equal `nextPair(prev, clientOnly(e), e.gen)` (seqNum `isEqual`, parent same
    position) else `NonContiguousBatchError`.
  On success append to `localQueue`, send `ContinueWork`.
- `processNextWork` (l.425-463): upstream first (coalesced, see pull); if pull says `more-expected`,
  pause local work; take up to 10 items; items with `gen < localHead.gen` are rejected
  (`StaleRebaseGenerationError`); else `processLocalBatch`.
- `processLocalBatch` (l.300-370):
  1. `merge(local-push)`. `reject` → reject this batch + all queued items of the same generation with
     `LeaderAheadError{expectedMinimumId}`. `rebase` → fatal.
  2. events = `newSyncState.pending.slice(oldPending.length)` (must equal `newEvents.length`).
  3. `persistLocal(events)`; receipt.stateHead must `isEqual` new localHead, else fatal.
  4. publish (syncState + PullItem `upstream-advance`), enqueue non-clientOnly events into `push.queued`,
     `startProviderPush`, resolve the requests.

### Backend push
- `startProviderPush` (l.203-209): only when running and `push=idle` with queued items; batch = first 50.
- `runProviderPush` (l.926-967): wait `isConnected`, `syncBackend.push(batch.map(toGlobal))`.
- `PushSucceeded` → `idle{queued: rest}`, start next. Note: confirmation of pushed events happens via
  **pull**, not via push success.
- `PushFailed` (l.626-663):
  - `ServerAheadError` → `awaiting-pull{queued: batch ++ queued}`. Nothing is retried until the next
    upstream batch is applied, which calls `replacePushPlan(pending.filter(!clientOnly))` and restarts
    push. (So the backend must deliver the missing events through pull; with `livePull=false` and a
    completed pull this stalls.)
  - `BackendIdMismatchError` → `handleBackendMismatch('push')`.
  - defect + `onError='shutdown'` → stop.
  - otherwise retry: `retry-wait`, sleep `min(30s, 1s * 2^(attempt-1))`, then rerun same batch
    (l.1372 `retryDelay`).

### Backend pull
- `startProviderPull(attempt)` (l.251-271): `cursor = syncState.upstreamHead`; `cursorInfo` from §1a;
  `syncBackend.pull(cursorInfo, {live})`.
- `runProviderPull` (l.970-1055): for each page `{batch, pageInfo}`: wait connected, convert with
  `fromGlobal`, keep `metadata` per event, send `UpstreamBatchReceived`. Reads ahead up to 16 pages
  (`MAX_PAGES_AHEAD`) before waiting for durability. On stream end sends `PullCompleted`; failure →
  `PullFailed`.
- `UpstreamBatchReceived` (l.555-583): ignore if stale pullId; reset `attempt=0`; empty page only updates
  pagination; else `pagination = NoMore ? between-pages : more-expected` and append to `upstreamQueue`.
- `coalesceUpstreamBatches` (l.810-820): all queued pages of the same pullId at the front are merged into
  one batch (one merge, one rebase).
- `processUpstreamBatch` (l.372-422):
  1. `merge(upstream-advance{newEvents}, ignoreClientOnlyEvents: true)`. `reject` → fatal.
  2. `rollbackEvents` (rebase) / `confirmedEvents` (advance); `backendHead = last event seqNum`.
  3. `persistUpstream({pulledEvents, events: merge.newEvents, rollbackEvents, confirmedEvents, backendHead})`.
  4. Check receipt stateHead **same position** (gen may differ) as new localHead and backendHead equal; else fatal.
  5. publish (`upstream-rebase{rollbackEvents,newEvents}` or `upstream-advance`), complete pull batches,
     `replacePushPlan(newSyncState.pending.filter(!clientOnly))` (cancels an in-flight push; new numbers
     after a rebase).
- `PullFailed` (l.592-613): `IsOfflineError` → `retry-wait`, wait for a false→true connectivity edge or a
  jittered (×0.8–1.2) `retryDelay(attempt)` timeout, then restart (attempt reset to 0 if reconnected).
  `BackendIdMismatchError` → handler. Other error: `onError='shutdown'` → stop; else `pull=completed`.
- `PullCompleted` → `pull=completed` (no automatic restart).

### Client-only events
`schema.eventsDefsMap.get(name).options.clientOnly` (l.154). They get `client+1` numbers, are stored in
the eventlog + materialized + journaled, stay in `pending`, but are **never pushed** (filtered at
l.364, 420, 912). Upstream merge ignores them for conflicts (`ignoreClientOnlyEvents`); on rebase they are
re-numbered along with synced pending events by merge. Client-document `<name>Set` events are client-only.

### BackendId mismatch (l.466-504)
- `ignore`: pull → `completed`; push → `disabled`.
- `shutdown`: stop with error, local data kept.
- `reset` (default): stop work, `DELETE FROM eventlog; DELETE FROM __livestore_sync_status;` and
  `DROP TABLE` every non-`sqlite_%` table in the state DB (l.1352-1369), then stop with
  `IntentionalShutdownCause{reason:'backend-id-mismatch'}`. Next boot starts fresh.

### Errors and shutdown
Any thrown error in the loop → `stop(failed, notify)`; `stop` interrupts all fibers and pending push
requests (l.177-198).

---

## 4. Schema hashing / migrations at boot

- State DB file name embeds `schema.state.sqlite.hash` = `fingerprint({_tag:'dbSchema', tables: [all table ASTs incl. system tables]})`
  (`schema/state/sqlite/mod.ts:59-62`; algorithm `schema/state/sqlite/db-schema/ast/fingerprint.ts`, canonical
  bytes + digest). Any table change → new file → no completion marker → rebuild.
  Rust: pick any stable hash of your table DDL; it only needs to be stable for the Rust client
  (not shared with server). Byte-compat with TS fingerprints only matters if Rust must open TS-written files.
- `recreateDb` (recreate-db.ts:34-93):
  1. `PRAGMA foreign_keys=ON` (configureConnection), user `hooks.init`.
  2. `migrateDb` (migrations.ts:83-150): create system tables; register/validate event defs; compare
     each table's `fingerprint` with `__livestore_schema`; for mismatches run `migrateTable` with
     **`create-if-not-exists`** (no drop — the DB is already empty because a rebuild always starts
     from a wiped/new file) and upsert the hash.
  3. `hooks.pre`, then `rematerializeFromEventlog` (rematerialize-from-eventlog.ts:17-153): page through
     the eventlog `WHERE g > $g OR (g = $g AND c > $c) ORDER BY g, c LIMIT batch` (default batch
     `STATE_REBUILD_BATCH_SIZE_DEFAULT`), each page in a savepoint; for each row
     `materializeEvent(e, {skipEventlog: true})` (unknown → no-op that still advances head + journal NULL;
     known → warn on schema-hash mismatch, args must decode or boot fails).
     Note: all events, including rows of every rebase generation, are replayed; journal rows are created
     for all of them (none discarded until the next upstream persist).
  4. `hooks.post`, then insert `__livestore_rebuild` marker.
- If state is complete, nothing is replayed; leader state = state DB as is.

---

## 5. What leaves the client

Only events. `runProviderPush` sends `batch.map(toGlobal)` = `{name, args, seqNum(global), parentSeqNum(global), clientId, sessionId}`
(LeaderSyncProcessor.ts:939). Changesets, journal, state-head, rebaseGeneration, `client` sub-numbers,
`schemaHash`, and the DB bytes never go to the sync backend. Client-only events never leave. Sync
metadata flows the other way (server → `syncMetadataJson`) and is sent back only as the pull cursor
(`cursorInfo.metadata`). DB bytes leave only through devtools/`export` APIs (make-adapter.ts:134-135),
not sync.

---

## 6. Prioritized behaviors with TS test references

Tests in `tests/package-common/src/leader-thread/`. Fixture schema: `fixture.ts` (todos table with text/boolean/
datetime columns, `app_config` client document, events `todoCreated`, `todoCompleted`, `todoDeletedNonPure`).
"JSON" = good candidate for a JSON fixture (input events + expected rows of eventlog/state/journal-presence/
sync_status) for a Rust differential test. "Behavioral" = needs a scripted mock backend / timing harness.

P0 – storage and materialization
1. Materialize known event: state rows + journal row + state head + eventlog row.
   `LeaderPersistence.test.ts:16` "commits local events without mutating the plan" — JSON.
2. Atomicity: failure mid-batch rolls back both DBs. `LeaderPersistence.test.ts:57`, `:35` — JSON (with an
   injected failing event).
3. Rebase in one commit: rollback via inverted changesets, delete, re-materialize, advance backend head.
   `LeaderPersistence.test.ts:116` — JSON (best single fixture for rollback correctness; compare final state rows).
4. Confirmation writes sync metadata + backend head. `LeaderPersistence.test.ts:148` — JSON.
5. `LeaderPersistence.test.ts:71` (the multi-line test, read it for its exact claim) — likely JSON.
6. `deleteEvents` removes all generations at a position. `eventlog.test.ts:12` — JSON.
7. Unknown events: logged, not materialized, head advances, also during rebuild.
   `unknown-events.test.ts:28,43,57,78,96,139` — JSON (`:139` especially).
8. Rebuild after partial/failed boot; marker written last. `recreate-db.test.ts:35`, `:206` — JSON-ish
   (input eventlog → expected state), hooks part is TS-specific.

P1 – local push protocol
9. Push validation errors (non-monotonic, leader-ahead, stale gen, non-contiguous).
   `LeaderSyncProcessor.test.ts:702` "invalid push", `:855`, `:909`, `:655`, `:938` — JSON (input head +
   batch → expected error tag). Pure function `validatePushBatch`, easy to table-test.
10. Many / duplicate local pushes. `:800`, `:831` — JSON.
11. Client-only events not pushed; `stream-events.test.ts:382` covers eventlog filtering — JSON.
12. `:1061` accepts rebased client events when generation increases — JSON.

P2 – sync loop (behavioral; script mock backend)
13. Basic sync `:420`; materializer hashes published `:450` (skip in Rust).
14. Pending across restart pushed exactly once even if first page rebases them `:195` — high value.
15. Confirm a pending event that was rebased before backend accepted it `:748` — JSON-able as a pull page
    sequence + expected final eventlog.
16. Paginated non-live pull then local pushes `:480`; blocking initial sync release `:538`.
17. ServerAheadError → wait for pull → push again `:1020`.
18. Push retry/backoff `:570`, `:1100`; defect shutdown paths `:607`, `:633`.
19. Offline pull retry / reconnect wake `:116`, `:262`, `:349` (timing, last priority).
20. BackendIdMismatch: `:1131`, `:1159` (reset clears DBs), `:1208`, `:1251`; pull variant is skipped `:1301`.

P3 – eventlog streaming API (only if the Rust client exposes it): `stream-events.test.ts:140-496`.

Suggested differential harness: run the TS leader with the mock backend
(`common/src/sync/mock-sync-backend.ts`) on a scripted scenario, then dump `eventlog`,
`__livestore_sync_status`, user tables, `__livestore_state_head`, and the key set of the journal
(not the changeset bytes — they are SQLite-version specific) to JSON; run the same script on Rust and diff.

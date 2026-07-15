# LiveStore CRDT benchmark harness

Phase 0 provides the shared logical workload, semantic oracle, conformance gate,
metric collectors, and result protocol used by the gated Phase 2 runners. It is
an ESM-only Node 24 package with no package dependencies.

## Phase 2 runner protocol

Every runner consumes one trace and implements this `RichTextArm` contract:

```js
{
  id: string,
  benchmarkable: boolean,
  bootstrap(actorId, initialDocument) => Awaitable<state>,
  applyLocal(state, logicalEdit) => Awaitable<{ state, update: Uint8Array }>,
  applyRemote(state, update) => Awaitable<state>,
  canonicalize(state) => Awaitable<CanonicalDocument>,
  encodeSnapshot(state) => Awaitable<Uint8Array>,
  decodeSnapshot(snapshot, actorId) => Awaitable<state>,
}
```

Bootstrap exactly once, encode that bootstrap state once, then initialize every
replica with `decodeSnapshot(sharedBootstrapSnapshot, actorId)`. Execute trace v2
`events` in order: an `edit` calls `applyLocal` on
`event.operation.actorId` and stores its emitted update by operation ID; a
`sync` delivers exactly `event.operationIds`, in order, to `event.toActorId`
with `applyRemote`. Count each delivered update occurrence at this wire
boundary. `compileSchedule` exposes the deterministic actor turns and delivery
opportunities separately when needed.

`LogicalEdit` is the tagged vocabulary validated by `assertLogicalEdit`: text
insertion, evolving-position deletion, mark set/unset, block split/join, and
block-type change. Text offsets and half-open ranges use Unicode code points.
Runners must preserve each trace operation's logical order and actor metadata;
technology-specific update bytes are the `applyLocal` result, not the logical
edit JSON. Correctness is compared through `canonicalize`, never encoded bytes.

Before a row counts, call:

```js
runConformanceSuite(arm) => Promise<{
  armId, passed, suite: { id, version, hash }, scenarioCount,
  editCount, snapshotBytes, canonical
}>
```

The complete public API is:

```js
// src/model.mjs
POSITION_UNIT: 'unicode-code-point'
EDIT_TAGS: readonly string[]
TEXT_ORIGINS: readonly string[]
MARK_KEYS: readonly string[]
BLOCK_TYPES: readonly string[]
codePointLength(text: string) => number
utf8ByteLength(text: string) => number
assertLogicalEdit(edit: LogicalEdit) => LogicalEdit

// src/trace.mjs
DOCUMENT_SIZES_BYTES: readonly number[]
EDIT_COUNTS: readonly number[]
CONCURRENCY_LEVELS: readonly number[]
OFFLINE_DURATION_RATIOS: readonly number[]
WORKLOAD_MATRIX: readonly Workload[]
generateTrace({ seed, docSizeBytes, editCount, concurrency,
  offlineBranchDurations? }) => TraceV2
compileSchedule({ seed, actorIds, editCount, offlineWindows }) => {
  ticks, finalDrainPairs
}
TraceV2 = { schemaVersion: 2, events: Array<EditEvent | SyncEvent>,
  operations, initialDocument, finalOracleDocument, ... }
summarizeTrace(trace: Trace) => {
  operationCount, counts, proportions
}

// src/oracle.mjs
canonicalizeDocument(document) => CanonicalDocument
applyLogicalEdit(document, edit) => CanonicalDocument
documentsEqual(left, right) => boolean

// src/conformance.mjs
CONFORMANCE_SUITE_ID: 'livestore-rich-text-conformance-v1'
CONFORMANCE_SUITE_VERSION: string
CONFORMANCE_SUITE_HASH: `sha256:${string}`
runConformanceSuite(arm: RichTextArm) => Promise<ConformanceReport>
conformanceInitialDocument() => CanonicalDocument
conformanceEdits() => LogicalEdit[]
ConformanceError extends Error

// src/metrics.mjs
summarize(samples: Iterable<number>) => NumericSummary
byteLength(payload: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView) => number
collectOperationBytes(payloads: Iterable<binary | string>) => NumericSummary
collectTransferredBytes(payloads) => { total, perOp }
collectSnapshotBytes(snapshot: binary | string) => number
serializeEvidenceNdjson(records: Iterable<JsonValue>) => string
writeEvidenceArtifact({ path, records, compression? })
  => Promise<ExternalEvidenceReference>
verifyEvidenceArtifact(reference: ExternalEvidenceReference) => Promise<{
  valid, errors, observed?: { hash, count, encoding, compression? }
}>
measureRepeated(fn, { warmups = 1, iterations = 5 } = {})
  => Promise<{ values, elapsedMs: NumericSummary }>
measureRetainedMemory({ allocate, release?, warmups = 1,
  iterations = 5, gc = true }) => Promise<{
    gcAvailable, gcUsed,
    samples: Array<{ before, after, delta, afterRelease }>,
    rssDeltaBytes: SignedNumericSummary,
    heapUsedDeltaBytes: SignedNumericSummary
  }>
checkConvergence({ states, canonicalize, expected }) => Promise<{
  converged, oracleMatched, stateCount, reference, expected,
  mismatchedIndices, oracleMismatchedIndices, mismatches, canonicalStates
}>

// src/results.mjs
REQUIRED_CONFORMANCE_SUITE: Readonly<{ id, version, hash, scenarioCount }>
measured(value) => { _tag: 'measured', value }
notApplicable(reason) => { _tag: 'not-applicable', reason }
validateBenchmarkResult(value) => { valid, errors }
validateResultDocument(value) => { valid, errors }
validateTaxRow(value) => { valid, errors }
assessCountability(embeddedResult, standaloneResult)
  => Promise<Countable | NotCountable>
computeTaxRow(embeddedResult, standaloneResult)
  => Promise<TaxRow | NotCountable>

// src/plain-reference-arm.mjs
plainReferenceArm: RichTextArm // smoke-only; benchmarkable === false
```

The timing helpers perform unmeasured warm-ups and return every measured value
plus the elapsed-time distribution, including the median. Collectors return raw
samples to the runner, but stored distributions omit `samples` and put evidence
at `value.evidence`. Large per-delivery observations are serialized once as a
deterministic external artifact (NDJSON is recommended); the result stores only
the aggregate distribution and this reference:

```js
{ _tag: 'external', path, hash, count, encoding, compression? }
```

Use `serializeEvidenceNdjson` for deterministic canonical-key-order records.
`writeEvidenceArtifact` accepts absent `compression` or `'gzip'` only. Gzip
output is deterministic, the reference keeps `encoding: 'ndjson'` and adds
`compression: 'gzip'`, and its hash covers the stored bytes (compressed bytes
for gzip). The writer creates the artifact once and never overwrites it. If an
artifact already contains the exact requested deterministic bytes, the writer
returns the same reference successfully; different existing bytes fail with
`EEXIST`. `verifyEvidenceArtifact` hashes the stored bytes, decompresses gzip
when declared, then validates NDJSON syntax, trailing record newlines, and
record count. The writer supplies canonical key order.

Bounded evidence with at most 1000 observations may be stored inline:

```js
{ _tag: 'inline', hash, count, reference, samples }
```

When samples are retained elsewhere or can be regenerated, compact evidence is:

```js
{ _tag: 'summary', hash, count, reference }
```

Timing and memory distributions may use inline evidence when bounded; wire
per-operation distributions use summary or external evidence and never inline
per-delivery arrays. Number metrics such as total transferred, snapshot, and
history bytes have no evidence field. Retained-memory collection still exposes
raw before/after/delta/after-release observations to the runner, signed RSS and
heap delta distributions, and whether explicit GC was available and used. Use
`notApplicable(reason)` rather than substituting zero.

Stored successful convergence contains only `converged`, `oracleMatched`,
`stateCount`, SHA-256 `canonicalDigests`, `oracleDigest`, and the two mismatch
index arrays. It does not retain canonical documents or mismatch structures. A
failed convergence check may additionally link an external `mismatchArtifact`.
The conformance metric records `passed`, `scenarioCount`, and the canonical
suite `{ id, version, hash }` exported by `src/conformance.mjs`. The suite
identity must exactly match `REQUIRED_CONFORMANCE_SUITE` from `src/results.mjs`;
its separately stored `scenarioCount` must equal that protocol constant so the
gate remains explicitly countable.

Every stored document must strictly pass `validateResultDocument`; benchmark
observations and computed TAX rows must also pass `validateBenchmarkResult` and
`validateTaxRow`, respectively. Extra properties are rejected. A runner must
record CPU identity plus trace ID/hash, CRDT identity/version, harness/protocol/
library versions, measurement protocol, and the exact wire protocol in
provenance. `provenance.trace.deliveryCount` records the number of delivered
update occurrences at the wire boundary. `validateBenchmarkResult` and
`validateResultDocument` are synchronous storage-shape and semantic validators;
they do not read external artifacts. `assessCountability` requires passed
conformance, oracle-backed convergence, measured core metrics, complete
provenance, matching workloads, and a comparable `embedded`/`standalone` pair.
It verifies every nested external-evidence reference in both results before
returning `countable`. Missing, unreadable, tampered, bad-gzip, hash/count/
encoding-invalid evidence returns `not-countable` with its nested result path.
`computeTaxRow` performs the same verification through `assessCountability` and
returns that assessment unchanged instead of producing TAX when ineligible;
otherwise its headline values are `embedded / standalone`.

Embedded runners must additionally record `payloadInflation`, a measured
`orderingEffect` in `single-writer-total-order` mode whose
`serializedOperationCount` covers every logical edit, and uncompacted
`logGrowth` checkpoints whose final checkpoint covers every edit. Embedded
provenance must include `versions.liveStore: { version, commit }`. All three
evidence hooks plus LiveStore version and commit are required for countability.

`reference-only` observations are valid and storable, while their adapter has
`benchmarkable === false`. They are never paired for TAX, and runners must not
call `assessCountability` or `computeTaxRow` for them. `crdv` observations also
remain separate from the embedded-versus-standalone TAX pairing.

## Smoke test

`CI=1 node --test` (or `pnpm test`) includes one end-to-end smoke flow using two
actual `plainReferenceArm` replicas at 256 initial bytes, 50 edits, 2 actors,
seed `phase0-smoke`, and one five-edit offline window. Both replicas start from
one shared bootstrap snapshot, then execute the trace's edit/sync events and
exact operation-ID deliveries. The smoke records temporary divergence before
sync, final oracle-backed convergence, delivered wire occurrences, a final
snapshot, warm-up/repeated timings, retained-memory evidence, provenance, and
strict result validation. It prints one compact JSON observation. Assertions
cover structure and correctness only; the measurements have no pass/fail
thresholds or performance conclusions. Countability/TAX is explicitly not
attempted because this is a reference-only non-CRDT.

The smoke materializes and retains
`evidence/plain-reference-smoke-deliveries.ndjson`. Repeated runs exercise the
idempotent equal-bytes path and verify the retained artifact; a byte mismatch
would fail with `EEXIST` rather than overwrite it.

Generated concurrency currently uses conflict-free, actor-owned block lanes.
This exercises deterministic offline scheduling and exact delivery without
making shared-region conflict claims. Adversarial edits to the same rich-text
region are deferred to Phase 3; the Phase 0 smoke proves scheduling/delivery,
not shared-region CRDT conflict semantics.

## Explicit exclusions

Phase 0 does not implement or import Loro, Automerge, or LiveStore benchmark
arms. It does not execute the 27-cell workload matrix, large workloads, the
full benchmark, or TAX comparisons. The plain reference arm is not a CRDT and
its smoke measurements support no performance claim or technology comparison.

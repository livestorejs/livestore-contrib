# DELTA-002 — Native `expo-sqlite`, not the portable WASM SQLite build

Status: open

Core LS.SYS.RT-R09 requires that leader and session databases "run on the same
WASM SQLite build exposed through per-platform entrypoints (browser, node, cf),
keeping materialization identical across platforms" — refining the determinism
requirement LS-R05. The Expo adapter does not use that shared build. Both the
file-backed leader databases and the in-memory client-session database are opened
through `expo-sqlite`'s native SQLite (`import * as SQLite from 'expo-sqlite'`,
`src/make-sqlite-db.ts:12`; `SQLite.openDatabaseSync(...)`,
`src/make-sqlite-db.ts:37`, `:51`), so the *whole* adapter is off the WASM build.

The consequence is scoped: `expo-sqlite` is still SQLite, so this does not by
itself break determinism — the same eventlog is expected to materialize the same
state. But R09's mechanism (one WASM build everywhere) is what makes
cross-platform materialization identity a *construction guarantee*. Under this
delta it becomes an *assumption*: identity between Expo and the WASM-based
adapters rests on the two SQLite builds agreeing (functions, collations,
serialization format used by `serializeSync` / `deserializeDatabaseSync`,
`src/make-sqlite-db.ts:121`, `:157`), which is not verified.

Close condition: either the (unbuilt) shared adapter conformance suite (core
LS.SYS.VER.CONF-R03) exercises Expo against the reference and confirms
materialization identity, or core LS.SYS.RT-R09 is refined to admit
platform-native SQLite for contrib adapters and LSC.ADAPT.EXPO-R02 is restated as
a conformant realization of that refined contract.

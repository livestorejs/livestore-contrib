# Expo Adapter — Intuition

_For: contributors to `adapter-expo` · Assumes: the core runtime mental model
(leader ⇄ client-session) and the [Node adapter](../node/intuition.md) ·
Covers: how Expo differs from Node's already-collapsed topology_

Start from the Node adapter and take away one more thing. Node collapses the web
adapter's topology to a single always-leader session but still lets you push the
leader into a `worker_threads` worker. Expo doesn't even have that choice: there
is one JS thread, the leader lives in it, and the single session simply _is_ the
leader. So the proxy is always the in-process direct-call shape — never an RPC
boundary. This makes Expo the flattest realization of the runtime contract.

The two things that actually make Expo _Expo_, rather than just a smaller Node:

1. **The database is `expo-sqlite`, not the WASM build.** Every other first-party
   adapter (web, node, cf) runs the same portable WASM SQLite so materialization
   is identical by construction. Expo runs the platform's native SQLite through
   `expo-sqlite`. It is still SQLite, but the "same build everywhere" guarantee
   the core leans on for determinism is now an _assumption_ here, not a fact — see
   [.delta/DELTA-002](./.delta/DELTA-002-native-sqlite-substrate.md).
2. **Devtools point the other way.** Node _hosts_ a devtools server the browser
   connects into. Expo _connects out_ to a server on the developer's machine,
   resolving the host from the React Native dev server so a real device or
   emulator can reach it. Nothing durable depends on this — it is a dev-time
   convenience — but it is the opposite direction of flow from Node.

Two traps. First, the always-leader session tempts you to treat Expo like the
multi-tab web case; it is not — Expo is single-session _today_ (a same-thread
shutdown channel with a TODO to add multi-threading), so handover is unrealized
([.delta/DELTA-001](./.delta/DELTA-001-no-handover.md), LSC.ADAPT.EXPO-R03).
Second, `storageMode` is hardcoded `'persisted'`: unlike web there is no
degrade-to-in-memory path, so don't reach for the storage-mode-transparency
machinery — it is deliberately absent (LSC.ADAPT.EXPO-DQ2).

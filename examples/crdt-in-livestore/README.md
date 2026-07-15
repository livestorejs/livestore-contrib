# CRDTs in LiveStore

This example packages an exploration of how a rich-text CRDT can coexist with
LiveStore. It includes two runnable Loro/ProseMirror applications, their
Cloudflare Durable Object workers, and the benchmark harness used to measure
the cost of embedding CRDT updates in LiveStore events.

## Architecture portfolio

The exploration considered three paths:

- **Reference-only (B):** LiveStore stores document metadata and a reference;
  the CRDT owns document bytes, persistence, and synchronization. The
  `apps/ref` example implements this baseline with a Loro relay Durable Object.
- **Opaque bytes in events (A):** LiveStore is the source of truth and carries
  base64-encoded native Loro updates as events over `@livestore/sync-cf`.
  The `apps/embed` example implements this path, including the sync worker.
- **Merge in the materializer (C-crdv):** a proposed deeper integration in
  which CRDT merge semantics live at the materialization boundary. This path
  was evaluated but is not implemented by the demo applications.

Across the measured Loro cells, embedding native updates in JSON events used
roughly twice the wire and event-history bytes of native Loro transport. The
exact ratio varies with payload and workload; see the published results rather
than treating 2x as a universal constant.

The deeper materializer integration was correctness-capable in the tested
model, but its compaction hypothesis was falsified: merging during
materialization does not itself compact the immutable event history.

## Live artifacts

- [Results and methodology](https://livestore-crdt.scratch.schickling.dev)
- [Opaque-bytes LiveStore demo](https://livestore-crdt-embed.scratch.schickling.dev)
- [Reference-only demo](https://livestore-crdt-ref.scratch.schickling.dev)

## Run locally

From the repository root, materialize and install the workspace according to
the repository development instructions. Then run:

```bash
pnpm --filter livestore-example-crdt-in-livestore dev:embed
pnpm --filter livestore-example-crdt-in-livestore dev:ref
pnpm --filter livestore-example-crdt-in-livestore test
```

The embed app needs `VITE_SYNC_URL` set to the `wss://` endpoint of its Worker.
Run the Worker from `apps/embed` with Wrangler. The reference app defaults to a
local relay at `ws://127.0.0.1:8788/loro`; run its Worker from `apps/ref` with
Wrangler or set `VITE_LORO_RELAY_URL`.

The benchmark code is under `bench/`. `bench/harness` contains the reusable
trace, conformance, oracle, metric, and result modules. `bench/run-loro`
contains the paired native-versus-embedded Loro arm and runner. Large matrix
runs can consume substantial time and disk, so the default `test` script runs
only the harness and runner unit tests.

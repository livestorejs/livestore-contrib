# Decision 0008: Opt-in managed cloud sync-cf

Status: accepted (scenario backend implementation and deployed integration evidence, 2026-08-01)

## Decision

Add `cloud-sync-cf` as an execution realization without adding placement to the
portable Scenario AST. Selecting it explicitly either attaches to a configured
endpoint or idempotently deploys the Scenario-owned sync-cf Worker through
Wrangler. The ordinary local and CI surfaces do not provision cloud resources.

Participant traffic crosses a local TLS-aware availability proxy while the
authoritative backend observer connects directly. Managed runs use a unique
physical Store ID, authenticate through a scoped credential kept outside the
repository, record the deployed backend revision independently from the client
source revision, and clear the run's Durable Object storage during teardown.

## Consequences

Maintainers can exercise actual Cloudflare routing, WebSockets, hibernation,
and SQLite Durable Object persistence with the same Scenario corpus and host
profiles. The reusable Worker remains deployed for subsequent runs; deleting
that account-level resource remains an explicit maintainer action. An
interrupted process can leave an isolated Store behind, but later runs cannot
collide with it because physical Store IDs are unique.

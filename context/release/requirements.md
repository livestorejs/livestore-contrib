# Contrib Release — Requirements

## LSC.REL-R1 — A pull request's package cohort is installable

A pull request that is trusted for snapshot publishing produces an npm version
of every publishable contrib package, installable without building the branch.

## LSC.REL-R2 — Fork code never holds publishing authority

The job that builds and packs a pull request's code runs without registry
credentials and without a write-scoped token. Nothing it produces reaches the
registry except through a separate trusted evaluation.

## LSC.REL-R3 — A published snapshot names the core build it was compiled against

Every published contrib package pins its core dependencies to the exact core
version the branch composed, so an installed cohort cannot silently mix
contrib code with an unrelated core build.

`refines: LS.DEL.REL-R02`

## LSC.REL-R4 — Trust is revocable

Publishing eligibility for a fork branch is granted and withdrawn by a
maintainer-managed label, re-checked immediately before publication. Withdrawal
stops publications that have not started; it does not retract published
versions.

The core contract for fork trust postdates the core revision this repo pins, so
this requirement carries no `refines:` marker yet; it gains one when the pin
advances past that contract.

## LSC.REL-R5 — Snapshot versions are immutable

A published snapshot version is never overwritten. Republishing the same
version is permitted only when the bytes are identical.

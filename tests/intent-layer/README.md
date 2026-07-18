# Contrib intent-layer enforcement

Mechanical checks for the contrib intent layer (`context/`), mirroring the core
suite (`livestorejs/livestore` `tests/package-common/src/intent-layer/`) plus a
cross-repo half. Contract: `context/spec.md` §Enforcement.

## Run

No workspace install required — the checks are plain `fs` + regex:

```sh
bun tests/intent-layer/check.ts
```

Exits non-zero on any violation. The cross-repo `refines: LS.*` half resolves
against the megarepo-pinned core intent layer at `repos/livestore/context/`.
When that pin predates the intent layer (the current June pin), the cross-repo
half is skipped with a logged notice; the LSC-local checks always run. Point at
a local core checkout to exercise the cross-repo half:

```sh
LIVESTORE_CORE_CONTEXT_DIR=/path/to/livestore/context bun tests/intent-layer/check.ts
```

## Checks

`src/checks.ts` (`runChecks`) returns check-name → violations for: LSC ID
uniqueness, namespace↔directory mapping (parsed from the `context/spec.md` ID
Scheme table), `refines:` resolution (LSC.* locally, LS.* cross-repo, guarded),
relative-link integrity, spec `Status` headers, empty companion dirs,
decision-record shape, and the maturity vocabulary.

## CI wiring (follow-up)

CI can run `bun tests/intent-layer/check.ts` directly (no install), or this
directory can be registered as a workspace package with a thin Vitest wrapper
around `runChecks`. Either wiring (a `ci.yml.genie.ts` step or a `genie/`
workspace entry) must be done in a megarepo-materialized environment — where
`repos/livestore/` exists so genie can regenerate and the cross-repo half runs
against a real core checkout.

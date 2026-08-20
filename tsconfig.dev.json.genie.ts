import { contribPackageNames } from './genie/internal.ts'
import { tsconfigJson } from './genie/repo.ts'

/**
 * Reference every first-party package (not just the test projects) so the
 * composite `tsc -b` typechecks all package sources. Previously only the two test
 * projects were referenced, which — under `tsc -b` — left packages outside the
 * tests' dependency closure (cli, solid, svelte, graphql, adapter-expo,
 * devtools-expo) unchecked and let API regressions false-green.
 */
export default tsconfigJson({
  compilerOptions: {},
  include: [],
  references: [
    // Derived from the canonical package list so a new contrib package is typechecked
    // automatically; a hand-maintained copy here would silently leave it unchecked.
    ...contribPackageNames.map((name) => ({ path: `./packages/@livestore/${name}` })),
    { path: './tests/integration' },
    { path: './tests/sync-provider' },
  ],
})

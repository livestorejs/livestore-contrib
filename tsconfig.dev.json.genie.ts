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
    { path: './packages/@livestore/adapter-expo' },
    { path: './packages/@livestore/adapter-node' },
    { path: './packages/@livestore/cli' },
    { path: './packages/@livestore/devtools-expo' },
    { path: './packages/@livestore/graphql' },
    { path: './packages/@livestore/solid' },
    { path: './packages/@livestore/svelte' },
    { path: './packages/@livestore/sync-electric' },
    { path: './packages/@livestore/sync-s2' },
    { path: './tests/integration' },
    { path: './tests/sync-provider' },
  ],
})

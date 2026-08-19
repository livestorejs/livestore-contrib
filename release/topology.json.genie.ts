import { jsonArtifact } from '../repos/effect-utils/packages/@overeng/genie/src/runtime/json-artifact/mod.ts'
import { contribPackageNames } from '../genie/internal.ts'

/**
 * The trusted package topology for PR snapshot validation.
 *
 * This is the list the main-branch validator checks an untrusted candidate against: a fork-authored
 * pack job cannot add a package to the cohort or omit one, because the tarball set has to match this
 * file exactly. It is generated rather than hand-written so it cannot drift from the workspace.
 */
export default jsonArtifact({
  data: {
    publishablePackageNames: [...contribPackageNames]
      .map((name) => `@livestore/${name}`)
      .toSorted((a, b) => a.localeCompare(b)),
  },
})

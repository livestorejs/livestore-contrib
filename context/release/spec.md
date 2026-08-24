# Contrib Release — Spec

## Status

Draft.

## Realization

Contrib composes the shared PR snapshot pipeline rather than implementing one.
The job graph, the candidate validator and the trust label are supplied by
`effect-utils`, and livestore consumes the same factory, so the rules deciding
what may be published are one implementation rather than two.

`refines: LS.DEL.REL-R02`

## Shape

| Stage     | Trust     | Role                                                           |
| --------- | --------- | -------------------------------------------------------------- |
| pack      | untrusted | builds and packs the pull request's code; no credentials       |
| validate  | trusted   | checks the candidate against the topology without executing it |
| attest    | trusted   | binds the validated digests to the pull request head           |
| authorize | trusted   | current-head review, or the fork trust label                   |
| publish   | trusted   | publishes via registry OIDC, then verifies the cohort          |

## Version Scheme

PR snapshots use `0.0.0-snapshot-pr.<pr>.<contribSha>`, identical to core's.
The contrib head SHA determines the core pin, because the lockfile is committed,
so the core SHA is omitted from the version string and appears in the published
manifests' dependencies instead (LSC.REL-R3).

The main-branch snapshot scheme is unchanged and still carries both SHAs.

## Manual Mirrored Dev Publication

The generated release workflow exposes a maintainer-dispatched `publish-dev`
mode on `main` as a narrow escape hatch for a coordinated prerelease. The
dispatcher supplies `contrib_version` and `core_version`; both must be the same
`x.y.z-dev.N` SemVer. Before contrib can publish, the live npm `dev` tag for
`@livestore/common` must already point to that version, and every required core
package must be visible at it.

The trusted job publishes the exact `release/topology.json` contrib cohort
under the npm `dev` tag with provenance. An existing package version is accepted
only when its registry digest matches the newly packed artifact; the job
verifies the mutable tag (and fails rather than attempting an out-of-band tag
repair), verifies direct rewritten core dependencies, and
records the source SHA and package digests in an uploaded manifest.

This escape hatch does not implement core-triggered dispatch or automatic
lockstep orchestration. A maintainer must dispatch contrib after verifying the
matching core cohort; automatic mirrored publication remains future work.

## Core Version Resolution

The core version a snapshot depends on is read from the registry, not derived.
A core commit on the default branch publishes as `0.0.0-snapshot-<sha>`, while a
core pull-request head publishes as `0.0.0-snapshot-pr.<n>.<sha>`. Both end in
the SHA, so resolution selects the unique published version with that suffix and
fails when zero or several match.

Deriving the version instead would produce the wrong shape whenever contrib pins
a core pull request — the case that motivates this work.

## Topology

`release/topology.json` is generated from the workspace and lists the
publishable package names. The trusted validator requires the candidate's
tarball set to match it exactly, so an untrusted pack job can neither add a
package to the cohort nor omit one.

## Deviations

See [`.delta/`](./.delta/) for confirmed divergence from the core contract.

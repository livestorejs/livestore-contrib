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
repair), verifies direct rewritten core dependencies and the presence of the
registry SLSA provenance bundle, and records source SHA, package digests and
provenance metadata in an uploaded manifest. Any missing or mismatched evidence
fails publication verification, including when re-running an existing version.
Verification tolerates registry propagation with at most 21 attempts, backoff
from 5 to 15 seconds, and a five-minute deadline. Each attempt re-reads package
metadata and tags. Missing versions/digests, stale tags, missing provenance
metadata, attestation HTTP 404s and absent provenance bundles are pending states.
Digest mismatches, unexpected endpoints and malformed responses fail immediately;
pending evidence that does not converge within the bound also fails.

This escape hatch does not implement core-triggered dispatch or automatic
lockstep orchestration. A maintainer must dispatch contrib after verifying the
matching core cohort; automatic mirrored publication remains future work.

## Stable Publication Runbook

After core is published, dispatch `.github/workflows/release.yml` on `main`
with `mode=publish-stable`, `core_version=x.y.z`, and `contrib_version=x.y.z`.
Both versions must be identical stable SemVer (no prerelease or build suffix).
The live npm `latest` tag for `@livestore/livestore` must point to that version,
and every required core dependency must already exist on npm. The job runs
`release:stable`, publishing the complete topology cohort on `latest` through
npm OIDC trusted publishing with provenance; token authentication is refused.
The same digest, dist-tag, dependency and provenance checks as the dev path
apply. Review the uploaded stable release manifest and job summary.

For a hypothetical release that is not on npm yet, run:

```sh
LIVESTORE_RELEASE_VERSION=0.5.0 LIVESTORE_CORE_RELEASE_VERSION=0.5.0 \
  devenv tasks run release:stable:dryrun
```

This reuses the snapshot runner's `--dry-run` packing/building/publish simulation
and never publishes. It deliberately omits the live core registry preflight so
unpublished hypothetical versions can be rehearsed; a successful dry run does
not prove core publication or OIDC/provenance availability.

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

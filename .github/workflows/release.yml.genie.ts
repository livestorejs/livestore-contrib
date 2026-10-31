import { prSnapshotAttestationPredicateType, releaseTopologyPath } from '../../genie/pr-snapshot-paths.ts'
import {
  bashShellDefaults,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupSteps,
  namespaceRunner,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
  savePnpmStateStep,
} from '../../genie/repo.ts'
import { prSnapshotForeignEventGuard, prSnapshotReleaseJobs } from '../../repos/effect-utils/genie/ci-workflow.ts'

const withNixDiagnosticsOnFailure = (steps: unknown[]) => [
  ...steps,
  savePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  nixDiagnosticsArtifactStep(),
]

const prSnapshot = prSnapshotReleaseJobs({
  // Q415: hosted under the Q423 exception until 2026-12-31; moves to a fleet profile on admission.
  runsOn: 'ubuntu-24.04',
  topologyPath: releaseTopologyPath,
  attestationPredicateType: prSnapshotAttestationPredicateType,
})

export default githubWorkflow({
  name: 'Release',
  actionlint: defaultActionlintConfig,

  on: {
    workflow_dispatch: {
      inputs: {
        ...prSnapshot.dispatchInputs,
        /**
         * Declared because the factory's scheduled-recovery dispatch passes `-f npm_tag=latest`
         * (`pr-snapshot.ts:301`) while `dispatchInputs` does not declare it. GitHub rejects a
         * `workflow run` carrying an undeclared input, so without this the retry path that
         * re-dispatches an authorized-but-incomplete cohort fails instead of recovering.
         *
         * Nothing here reads it — the publish tag comes from the validator's `npm-tag` output —
         * so this exists purely to satisfy the dispatch contract. Core happens to be unaffected
         * because it already declares `npm_tag` for its own release jobs.
         *
         * Remove once the factory stops sending an input it does not declare
         * (overengineeringstudio/effect-utils#1091).
         */
        npm_tag: {
          description: 'Unused by contrib; declared so the factory-issued promotion dispatch is accepted',
          required: false,
          default: 'latest',
          type: 'string',
        },
        contrib_version: {
          description: 'Contrib semver; must match core_version (stable for publish-stable, dev for publish-dev)',
          required: false,
          type: 'string',
        },
        core_version: {
          description: 'Published core semver; must match contrib_version',
          required: false,
          type: 'string',
        },
        mode: {
          description: 'Release workflow mode',
          required: true,
          default: 'validate-release-surface',
          type: 'choice',
          options: [
            'validate-release-surface',
            'publish-dev',
            'publish-stable',
            'publish-snapshot',
            prSnapshot.dispatchModeOption,
          ],
        },
      },
    },
    workflow_run: prSnapshot.workflowRunTrigger,
    schedule: prSnapshot.scheduleTrigger,
    pull_request: {},
    push: {
      branches: ['main'],
    },
  },

  permissions: {
    contents: 'read',
    'id-token': 'write',
  },

  env: {
    CACHIX_AUTH_TOKEN: '${{ secrets.CACHIX_AUTH_TOKEN }}',
    CI: 'true',
    FORCE_SETUP: '1',
  },

  jobs: {
    ...prSnapshot.jobs,

    'release-surface': {
      // The snapshot triggers widen this workflow to a cron and to every producer CI completion.
      // Without this guard a full toolchain build would run every few minutes.
      if: prSnapshotForeignEventGuard,
      'runs-on': namespaceRunner('${{ github.run_id }}'),
      defaults: bashShellDefaults,
      steps: withNixDiagnosticsOnFailure([
        ...livestoreContribSetupSteps,
        {
          name: 'Validate release surface',
          run: runDevenvTasksBefore('release:surface:check'),
        },
      ]),
    },

    'publish-snapshot-version': {
      if: "(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'publish-snapshot')",
      'runs-on': 'ubuntu-24.04',
      permissions: {
        contents: 'read',
        'id-token': 'write',
      },
      defaults: bashShellDefaults,
      steps: withNixDiagnosticsOnFailure([
        {
          name: 'Checkout',
          uses: 'actions/checkout@v4',
          with: {
            ref: '${{ github.event.workflow_run.head_sha || github.sha }}',
          },
        },
        ...livestoreContribSetupSteps.slice(1),
        {
          name: 'Select snapshot versions',
          run: `set -euo pipefail
core_sha="$(jq -r '.members.livestore.commit' megarepo.lock)"
if [ -z "$core_sha" ] || [ "$core_sha" = "null" ]; then
  echo "megarepo.lock is missing members.livestore.commit" >&2
  exit 1
fi
contrib_sha="$(git rev-parse HEAD)"
echo "GIT_SHA=$contrib_sha" >> "$GITHUB_ENV"
echo "LIVESTORE_CORE_GIT_SHA=$core_sha" >> "$GITHUB_ENV"
echo "LIVESTORE_CORE_RELEASE_VERSION=0.0.0-snapshot-$core_sha" >> "$GITHUB_ENV"
echo "LIVESTORE_RELEASE_VERSION=0.0.0-snapshot-$core_sha.$contrib_sha" >> "$GITHUB_ENV"`,
        },
        {
          name: 'Publish contrib snapshot version',
          run: runDevenvTasksBefore('release:snapshot:git-sha'),
        },
      ]),
    },

    ...Object.fromEntries(
      (['dev', 'stable'] as const).map((channel) => {
        const tag = channel === 'stable' ? 'latest' : 'dev'
        return [
          `publish-${channel}-version`,
          {
            if: `github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'publish-${channel}'`,
            'runs-on': 'ubuntu-24.04',
            concurrency: {
              // All versions of a channel mutate the same package-wide dist-tags.
              group: `publish-${channel}`,
              'cancel-in-progress': false,
            },
            permissions: {
              contents: 'read',
              'id-token': 'write',
            },
            defaults: bashShellDefaults,
            steps: withNixDiagnosticsOnFailure([
              {
                name: 'Checkout',
                uses: 'actions/checkout@v4',
                with: {
                  ref: '${{ github.sha }}',
                  'persist-credentials': false,
                },
              },
              {
                name: `Validate matching ${channel} version inputs`,
                env: {
                  CORE_VERSION: '${{ inputs.core_version }}',
                  CONTRIB_VERSION: '${{ inputs.contrib_version }}',
                },
                run: `set -euo pipefail
semver_pattern='^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)${channel === 'dev' ? '-dev\\.(0|[1-9][0-9]*)' : ''}$'
[[ "$CONTRIB_VERSION" =~ $semver_pattern ]]
test "$CONTRIB_VERSION" = "$CORE_VERSION"`,
              },
              ...livestoreContribSetupSteps.slice(1),
              {
                name: `Publish matching contrib ${channel} version`,
                env: {
                  LIVESTORE_CORE_RELEASE_VERSION: '${{ inputs.core_version }}',
                  LIVESTORE_RELEASE_VERSION: '${{ inputs.contrib_version }}',
                  LIVESTORE_RELEASE_MANIFEST: '${{ runner.temp }}/' + channel + '-release-manifest.json',
                },
                run: runDevenvTasksBefore(`release:${channel}`),
              },
              {
                id: 'upload-release-manifest',
                name: `Upload ${channel} release manifest`,
                uses: 'actions/upload-artifact@v4',
                with: {
                  name: channel + '-release-${{ inputs.contrib_version }}-${{ github.sha }}',
                  path: '${{ runner.temp }}/' + channel + '-release-manifest.json',
                  'if-no-files-found': 'error',
                },
              },
              {
                name: `Record ${channel} release`,
                env: {
                  ARTIFACT_DIGEST: '${{ steps.upload-release-manifest.outputs.artifact-digest }}',
                  ARTIFACT_URL: '${{ steps.upload-release-manifest.outputs.artifact-url }}',
                  MANIFEST: '${{ runner.temp }}/' + channel + '-release-manifest.json',
                },
                run: `set -euo pipefail
{
  echo '## Contrib ${tag} release'
  echo
  echo "- Source: $(jq -r .sourceSha "$MANIFEST")"
  echo "- Version: $(jq -r .version "$MANIFEST")"
  echo "- Core version: $(jq -r .coreVersion "$MANIFEST")"
  echo "- npm tag: $(jq -r .npmTag "$MANIFEST")"
  echo "- Cohort packages: $(jq -r .packageCount "$MANIFEST")"
  echo "- Manifest artifact digest: $ARTIFACT_DIGEST"
  echo "- Manifest artifact: $ARTIFACT_URL"
} >> "$GITHUB_STEP_SUMMARY"`,
              },
            ]),
          },
        ]
      }),
    ),
  },
})

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
        mode: {
          description: 'Release workflow mode',
          required: true,
          default: 'validate-release-surface',
          type: 'choice',
          options: ['validate-release-surface', 'publish-snapshot', prSnapshot.dispatchModeOption],
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
  },
})

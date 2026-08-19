import {
  bashShellDefaults,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupSteps,
  livestoreContribSetupStepsAfterCheckout,
  livestoreDefaultRefPolicyJob,
  namespaceRunner,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
  savePnpmStateStep,
} from '../../genie/repo.ts'
import { prSnapshotPackJob } from '../../repos/effect-utils/genie/ci-workflow.ts'
import {
  prSnapshotValidatorPath,
  prSnapshotValidatorTestPath,
  releaseTopologyPath,
} from '../../genie/pr-snapshot-paths.ts'

const withNixDiagnosticsOnFailure = (steps: unknown[]) => [
  ...steps,
  savePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  nixDiagnosticsArtifactStep(),
]

const standardCIJob = (config: { name?: string; steps: unknown[] }) => ({
  name: config.name,
  'runs-on': namespaceRunner('${{ github.run_id }}'),
  defaults: bashShellDefaults,
  steps: withNixDiagnosticsOnFailure(config.steps),
})

export default githubWorkflow({
  name: 'ci',
  actionlint: defaultActionlintConfig,

  on: {
    push: {
      branches: ['main'],
    },
    pull_request: {},
    workflow_dispatch: {},
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
    'source-policy': livestoreDefaultRefPolicyJob,

    // Runs fork-authored code with no secrets and a read-only token; everything it uploads is treated
    // as untrusted input by the release workflow. Kept on the shared runner because contrib's build
    // composes core from source and would otherwise pay a cold Nix build on every pull request.
    ...prSnapshotPackJob({
      topologyPath: releaseTopologyPath,
      validatorScriptPath: prSnapshotValidatorPath,
      validatorTestPath: prSnapshotValidatorTestPath,
      setupStepsAfterCheckout: livestoreContribSetupStepsAfterCheckout,
      packTask: 'release:snapshot:pack:git-sha',
      runsOn: namespaceRunner('${{ github.run_id }}'),
    }),

    'pr-quality': standardCIJob({
      name: 'pr/quality',
      steps: [...livestoreContribSetupSteps, { name: 'Run quality checks', run: runDevenvTasksBefore('ci:quality') }],
    }),

    'pr-types': standardCIJob({
      name: 'pr/types',
      steps: [...livestoreContribSetupSteps, { name: 'Run type checks', run: runDevenvTasksBefore('ci:types') }],
    }),

    'pr-packages': standardCIJob({
      name: 'pr/packages',
      steps: [
        ...livestoreContribSetupSteps,
        { name: 'Run package unit tests', run: runDevenvTasksBefore('ci:packages') },
      ],
    }),

    'pr-examples-build': standardCIJob({
      name: 'pr/examples-build',
      steps: [
        ...livestoreContribSetupSteps,
        { name: 'Build contrib examples', run: runDevenvTasksBefore('ci:examples-build') },
      ],
    }),

    'pr-node': standardCIJob({
      name: 'pr/node',
      steps: [
        ...livestoreContribSetupSteps,
        { name: 'Run node integration coverage', run: runDevenvTasksBefore('ci:node') },
      ],
    }),
  },
})

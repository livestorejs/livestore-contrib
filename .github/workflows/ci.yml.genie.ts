import {
  bashShellDefaults,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupSteps,
  livestoreDefaultRefPolicyJob,
  namespaceRunner,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
  savePnpmStateStep,
} from '../../genie/repo.ts'

const withNixDiagnosticsOnFailure = (steps: unknown[]) => [
  ...steps,
  savePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  nixDiagnosticsArtifactStep(),
]

const standardCIJob = (config: { steps: unknown[] }) => ({
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

    'check-all': standardCIJob({
      steps: [...livestoreContribSetupSteps, { name: 'Run contrib checks', run: runDevenvTasksBefore('check:all') }],
    }),
  },
})

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

const withNixDiagnosticsOnFailure = (steps: unknown[]) => [
  ...steps,
  savePnpmStateStep({ keyPrefix: 'livestore-contrib-pnpm-state-v1' }),
  nixDiagnosticsArtifactStep(),
]

export default githubWorkflow({
  name: 'Release',
  actionlint: defaultActionlintConfig,

  on: {
    workflow_dispatch: {
      inputs: {
        mode: {
          description: 'Release workflow mode',
          required: true,
          default: 'validate-release-surface',
          type: 'choice',
          options: ['validate-release-surface'],
        },
      },
    },
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
    'release-surface': {
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
  },
})

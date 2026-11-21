import {
  bashShellDefaults,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupSteps,
  namespaceRunner,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
} from '../../genie/repo.ts'

// The toolchain comes from devenv and the build reads the pinned core, so those inputs trigger it too.
const paths = [
  'rust/**',
  '.github/workflows/rust.yml*',
  'devenv.nix',
  'devenv.yaml',
  'devenv.lock',
  'megarepo.kdl',
  'megarepo.lock',
]

export default githubWorkflow({
  name: 'rust',
  actionlint: defaultActionlintConfig,
  on: {
    push: { branches: ['main'], paths },
    pull_request: { paths },
    workflow_dispatch: {},
  },
  permissions: { contents: 'read', 'id-token': 'write' },
  env: {
    CI: 'true',
    FORCE_SETUP: '1',
  },
  jobs: {
    rust: {
      name: 'rust/client',
      'runs-on': namespaceRunner('${{ github.run_id }}'),
      'timeout-minutes': 60,
      defaults: bashShellDefaults,
      steps: [
        ...livestoreContribSetupSteps,
        {
          name: 'Restore cargo cache',
          uses: 'actions/cache@v4',
          with: {
            path: '~/.cargo/registry\n~/.cargo/git\nrust/target',
            key: "cargo-${{ runner.os }}-${{ hashFiles('rust/Cargo.lock', 'devenv.lock') }}",
            'restore-keys': 'cargo-${{ runner.os }}-',
          },
        },
        { name: 'Check and lint', run: runDevenvTasksBefore('rust:fmt', 'rust:check', 'rust:clippy', 'rust:doc') },
        { name: 'Test', run: runDevenvTasksBefore('rust:test') },
        nixDiagnosticsArtifactStep(),
      ],
    },
  },
})

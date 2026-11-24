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

// Cached build scripts embed Nix runtime paths; even fallback restores must use the same toolchain.
const toolchainHash = "${{ hashFiles('devenv.nix', 'devenv.yaml', 'devenv.lock', 'megarepo.lock') }}"

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
            key: `cargo-\${{ runner.os }}-${toolchainHash}-\${{ hashFiles('rust/Cargo.lock') }}`,
            'restore-keys': `cargo-\${{ runner.os }}-${toolchainHash}-`,
          },
        },
        { name: 'Check and lint', run: runDevenvTasksBefore('rust:fmt', 'rust:check', 'rust:clippy', 'rust:doc') },
        { name: 'Test', run: runDevenvTasksBefore('rust:test') },
        { name: 'SQLite matches core wa-sqlite', run: runDevenvTasksBefore('rust:sqlite-check') },
        { name: 'Live tests against the pinned core sync-cf worker', run: runDevenvTasksBefore('rust:test-live') },
        nixDiagnosticsArtifactStep(),
      ],
    },
    examples: {
      name: 'rust/examples',
      'runs-on': namespaceRunner('${{ github.run_id }}-examples'),
      'timeout-minutes': 60,
      defaults: bashShellDefaults,
      steps: [
        ...livestoreContribSetupSteps,
        {
          name: 'Restore cargo cache',
          uses: 'actions/cache@v4',
          with: {
            path: '~/.cargo/registry\n~/.cargo/git\nrust/examples/*/target',
            key: `cargo-examples-\${{ runner.os }}-${toolchainHash}-\${{ hashFiles('rust/examples/*/Cargo.lock') }}`,
            'restore-keys': `cargo-examples-\${{ runner.os }}-${toolchainHash}-`,
          },
        },
        { name: 'Check, lint and build the examples', run: runDevenvTasksBefore('rust:examples') },
        nixDiagnosticsArtifactStep(),
      ],
    },
  },
})

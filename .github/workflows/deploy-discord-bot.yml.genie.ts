import {
  bashShellDefaults,
  checkoutStep,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupStepsAfterCheckout,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
} from '../../genie/repo.ts'

// Pushes to main deploy staging only. Production requires an explicit dispatch
// from main; staging success never authorizes a production rollout.
// Initial Worker creation remains operator-only; github.sha identifies the release.
const deployJob = (stage: 'staging' | 'production') => ({
  'runs-on': 'ubuntu-24.04',
  'timeout-minutes': 45,
  ...(stage === 'production'
    ? {
        if: "${{ github.event_name == 'workflow_dispatch' && inputs.stage == 'production' && github.ref == 'refs/heads/main' }}",
      }
    : { if: "${{ github.event_name == 'push' || inputs.stage == 'staging' }}" }),
  environment: stage,
  concurrency: { group: `discord-bot-deploy-${stage}`, 'cancel-in-progress': false },
  defaults: bashShellDefaults,
  env: {
    STAGE: stage,
    CF_GATEWAY_TRANSPORT:
      "${{ (inputs.transport != '' && inputs.transport != 'default' && inputs.transport) || vars.CF_GATEWAY_TRANSPORT || 'embedded' }}",
    CF_ALLOW_RELAY_ROLLBACK: "${{ inputs.transport == 'embedded' && '1' || '0' }}",
    RELEASE_ID: '${{ github.sha }}',
    CF_WORKER_NAME: '${{ vars.CF_WORKER_NAME }}',
    CF_BOT_STATE_NAMESPACE_ID: '${{ vars.CF_BOT_STATE_NAMESPACE_ID }}',
    CF_WORKER_URL: '${{ vars.CF_WORKER_URL }}',
  },
  steps: [
    checkoutStep({ ref: '${{ github.sha }}' }),
    { uses: 'actions/setup-node@v6', with: { 'node-version': '24', 'package-manager-cache': false } },
    ...(stage === 'staging'
      ? [
          {
            name: 'Install standalone Discord bot dependencies',
            'working-directory': 'apps/discord-bot',
            run: 'corepack pnpm install --frozen-lockfile',
          },
        ]
      : [
          ...livestoreContribSetupStepsAfterCheckout,
          { name: 'Install workspace dependencies', run: runDevenvTasksBefore('pnpm:install', 'discord-bot:install') },
        ]),
    {
      name: 'Plan and enforce staging adoption gate',
      if: "${{ env.STAGE == 'staging' }}",
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        DISCORD_BOT_TOKEN: '${{ secrets.DISCORD_BOT_TOKEN }}',
        DOCS_CORRELATION_KEY: '${{ secrets.DOCS_CORRELATION_KEY }}',
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        GATEWAY_RELAY_TOKEN: '${{ secrets.GATEWAY_RELAY_TOKEN }}',
        E2E_ACTOR_TOKEN: '${{ secrets.E2E_ACTOR_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      },
      'working-directory': 'apps/discord-bot',
      run: 'bash cf/scripts/remote.sh plan --stage staging',
    },
    {
      name: 'Plan and enforce production adoption gate',
      if: "${{ env.STAGE == 'production' }}",
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        DISCORD_BOT_TOKEN: '${{ secrets.DISCORD_BOT_TOKEN }}',
        DOCS_CORRELATION_KEY: '${{ secrets.DOCS_CORRELATION_KEY }}',
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        GATEWAY_RELAY_TOKEN: '${{ secrets.GATEWAY_RELAY_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
        DISCORD_APPLICATION_ID: '${{ vars.DISCORD_APPLICATION_ID }}',
        CF_DEPLOY_STAGE: 'production',
      },
      run: `set -euo pipefail
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  bash cf/scripts/remote.sh plan --stage production
'`,
    },
    {
      name: 'Deploy approved staging plan',
      if: "${{ env.STAGE == 'staging' }}",
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        DISCORD_BOT_TOKEN: '${{ secrets.DISCORD_BOT_TOKEN }}',
        DOCS_CORRELATION_KEY: '${{ secrets.DOCS_CORRELATION_KEY }}',
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        GATEWAY_RELAY_TOKEN: '${{ secrets.GATEWAY_RELAY_TOKEN }}',
        E2E_ACTOR_TOKEN: '${{ secrets.E2E_ACTOR_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
        AGENT_ACTION_APPROVAL: 'deploy',
      },
      'working-directory': 'apps/discord-bot',
      run: 'bash cf/scripts/remote.sh deploy --stage staging --yes',
    },
    {
      name: 'Deploy approved production plan',
      if: "${{ env.STAGE == 'production' }}",
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        DISCORD_BOT_TOKEN: '${{ secrets.DISCORD_BOT_TOKEN }}',
        DOCS_CORRELATION_KEY: '${{ secrets.DOCS_CORRELATION_KEY }}',
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        GATEWAY_RELAY_TOKEN: '${{ secrets.GATEWAY_RELAY_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
        DISCORD_APPLICATION_ID: '${{ vars.DISCORD_APPLICATION_ID }}',
        CF_DEPLOY_STAGE: 'production',
        AGENT_ACTION_APPROVAL: 'deploy',
      },
      run: `set -euo pipefail
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  bash cf/scripts/remote.sh deploy --stage production --yes
'`,
    },
    {
      name: 'Record deployed Cloudflare version',
      id: 'deployment',
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        CF_DEPLOY_STAGE: stage,
      },
      'working-directory': 'apps/discord-bot',
      run: `receipt=$(node --experimental-strip-types cf/scripts/rollback.ts current)
node --input-type=module -e '
        import { appendFileSync, readFileSync } from "node:fs"
        const receipt = JSON.parse(readFileSync(0, "utf8"))
        if (receipt.releaseId !== process.env.RELEASE_ID || !receipt.currentVersionId) {
          throw new Error("Cloudflare deployment receipt does not match the requested release")
        }
        appendFileSync(process.env.GITHUB_OUTPUT, "version=" + receipt.currentVersionId + String.fromCharCode(10))
        console.log("Verified Cloudflare deployment", receipt.currentVersionId)
      ' <<< "$receipt"`,
    },
    ...(stage === 'staging'
      ? [
          {
            name: 'Activate staging gateway for this deploy',
            id: 'staging_gateway',
            if: "${{ env.CF_GATEWAY_TRANSPORT != 'relay' }}",
            env: { ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}' },
            run: 'node --experimental-strip-types apps/discord-bot/cf/scripts/staging-gateway.ts activate',
          },
        ]
      : []),
    {
      name: 'Verify gateway adoption and readiness',
      env: { EXPECTED_WORKER_VERSION: '${{ steps.deployment.outputs.version }}' },
      run: 'node apps/discord-bot/cf/scripts/verify-deployed-gateway.mjs',
    },
    {
      name: 'Converge application commands',
      env: {
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        DISCORD_APPLICATION_ID: '${{ vars.DISCORD_APPLICATION_ID }}',
      },
      ...(stage === 'staging'
        ? {
            'working-directory': 'apps/discord-bot',
            run: 'node --experimental-strip-types cf/scripts/commands-sync.ts staging',
          }
        : {
            run: `set -euo pipefail
echo "::add-mask::$ADMIN_TOKEN"
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  node --experimental-strip-types cf/scripts/commands-sync.ts "$STAGE"
'`,
          }),
    },
    ...(stage === 'staging'
      ? [
          {
            name: 'Park staging gateway',
            if: "${{ always() && steps.staging_gateway.outcome != 'skipped' && steps.staging_gateway.outcome != '' }}",
            env: { ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}' },
            run: 'node --experimental-strip-types apps/discord-bot/cf/scripts/staging-gateway.ts park',
          },
        ]
      : []),
    ...(stage === 'production' ? [nixDiagnosticsArtifactStep()] : []),
  ],
})

export default githubWorkflow({
  name: 'Deploy Discord bot',
  actionlint: defaultActionlintConfig,
  on: {
    push: {
      branches: ['main'],
      paths: ['apps/discord-bot/**', '.github/workflows/deploy-discord-bot.yml*'],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description: 'Cloudflare stage (production requires a main ref)',
          required: true,
          type: 'choice',
          options: ['staging', 'production'],
        },
        transport: {
          description: 'Override the stage gateway transport for a cutover or rollback',
          required: false,
          type: 'choice',
          default: 'default',
          options: ['default', 'embedded', 'relay'],
        },
      },
    },
  },
  permissions: { contents: 'read', 'id-token': 'write' }, // Cachix in the shared Nix setup.
  env: {
    CACHIX_AUTH_TOKEN: '${{ secrets.CACHIX_AUTH_TOKEN }}',
    CI: 'true',
    FORCE_SETUP: '1',
  },
  jobs: {
    staging: deployJob('staging'),
    production: deployJob('production'),
  },
})

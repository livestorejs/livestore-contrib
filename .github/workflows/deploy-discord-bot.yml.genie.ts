import {
  bashShellDefaults,
  checkoutStep,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupStepsAfterCheckout,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
} from '../../genie/repo.ts'

// A push to main deploys staging first, then production only after staging's
// release and command-sync checks pass. Manual dispatch keeps single-stage runs.
// Initial Worker creation remains operator-only; github.sha identifies the release.
const deployJob = (stage: 'staging' | 'production') => ({
  'runs-on': 'ubuntu-24.04',
  'timeout-minutes': 45,
  ...(stage === 'production'
    ? {
        needs: ['staging'],
        if: "${{ always() && ((github.event_name == 'push' && needs.staging.result == 'success') || (github.event_name == 'workflow_dispatch' && inputs.stage == 'production' && github.ref == 'refs/heads/main')) }}",
      }
    : { if: "${{ github.event_name == 'push' || inputs.stage == 'staging' }}" }),
  environment: stage,
  concurrency: { group: `discord-bot-deploy-${stage}`, 'cancel-in-progress': false },
  defaults: bashShellDefaults,
  env: {
    STAGE: stage,
    RELEASE_ID: '${{ github.sha }}',
    CF_WORKER_NAME: '${{ vars.CF_WORKER_NAME }}',
    CF_BOT_STATE_NAMESPACE_ID: '${{ vars.CF_BOT_STATE_NAMESPACE_ID }}',
    CF_WORKER_URL: '${{ vars.CF_WORKER_URL }}',
  },
  steps: [
    checkoutStep({ ref: '${{ github.sha }}' }),
    ...livestoreContribSetupStepsAfterCheckout,
    { name: 'Install workspace dependencies', run: runDevenvTasksBefore('pnpm:install', 'discord-bot:install') },
    {
      name: 'Plan and enforce staging adoption gate',
      if: "${{ env.STAGE == 'staging' }}",
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        DISCORD_BOT_TOKEN: '${{ secrets.DISCORD_BOT_TOKEN }}',
        DOCS_CORRELATION_KEY: '${{ secrets.DOCS_CORRELATION_KEY }}',
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        E2E_ACTOR_TOKEN: '${{ secrets.E2E_ACTOR_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      },
      run: `set -euo pipefail
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  pnpm cf:plan --stage "$STAGE" 2>&1 | tee "$RUNNER_TEMP/discord-bot-plan.log"
  node --experimental-strip-types cf/scripts/check-deploy-plan.ts "$RUNNER_TEMP/discord-bot-plan.log"
'`,
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
        E2E_ACTOR_TOKEN: '${{ secrets.E2E_ACTOR_TOKEN }}',
        OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
        AGENT_ACTION_APPROVAL: 'deploy',
      },
      run: `set -euo pipefail
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  pnpm cf:deploy --stage "$STAGE" --yes
'`,
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
      name: 'Verify gateway readiness and release',
      run: `node --input-type=module <<'NODE'
import { setTimeout } from 'node:timers/promises'
const url = new URL('/readyz', process.env.CF_WORKER_URL)
if (url.protocol !== 'https:' || !process.env.CF_WORKER_URL || !process.env.RELEASE_ID) {
  throw new Error('CF_WORKER_URL must be an HTTPS URL and RELEASE_ID must be set')
}
const checks = ['journalCurrent', 'supervisorReady', 'sessionPresent', 'gatewayHealthy', 'errorFree']
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (response.status === 200) {
      const report = await response.json()
      if (report.ready === true && report.releaseId === process.env.RELEASE_ID &&
          checks.every((key) => report.checks?.[key] === true)) {
        console.log('Discord bot ready at expected release', report.releaseId)
        process.exit(0)
      }
    }
  } catch (error) {
    console.log('Readiness request failed:', error instanceof Error ? error.message : String(error))
  }
  await setTimeout(5000)
}
throw new Error('Discord bot readiness did not reach expected release within 120 seconds')
NODE`,
    },
    {
      name: 'Converge application commands',
      env: {
        ADMIN_TOKEN: '${{ secrets.ADMIN_TOKEN }}',
        DISCORD_APPLICATION_ID: '${{ vars.DISCORD_APPLICATION_ID }}',
      },
      run: `set -euo pipefail
echo "::add-mask::$ADMIN_TOKEN"
DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "\${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bash -euo pipefail -c '
  cd apps/discord-bot
  node --experimental-strip-types cf/scripts/commands-sync.ts "$STAGE"
'`,
    },
    nixDiagnosticsArtifactStep(),
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

import {
  bashShellDefaults,
  checkoutStep,
  defaultActionlintConfig,
  githubWorkflow,
  livestoreContribSetupStepsAfterCheckout,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
} from '../../genie/repo.ts'

// Production is deliberately absent: cf/alchemy.run.ts admits only staging.
// Dispatch with `gh workflow run deploy-discord-bot.yml --ref <approved-branch-or-tag> -f stage=staging`;
// github.sha is the dispatch ref's resolved commit, not an independently supplied release ID.
export default githubWorkflow({
  name: 'Deploy Discord bot',
  actionlint: defaultActionlintConfig,
  on: {
    workflow_dispatch: {
      inputs: {
        stage: {
          description: 'Cloudflare stage (production requires separate stack admission)',
          required: true,
          type: 'choice',
          options: ['staging'],
        },
      },
    },
  },
  permissions: { contents: 'read', 'id-token': 'write' }, // Cachix in the shared Nix setup.
  concurrency: {
    group: 'discord-bot-deploy-${{ inputs.stage }}',
    'cancel-in-progress': false,
  },
  env: {
    CACHIX_AUTH_TOKEN: '${{ secrets.CACHIX_AUTH_TOKEN }}',
    CI: 'true',
    FORCE_SETUP: '1',
  },
  jobs: {
    deploy: {
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 45,
      environment: '${{ inputs.stage }}',
      defaults: bashShellDefaults,
      env: {
        STAGE: '${{ inputs.stage }}',
        RELEASE_ID: '${{ github.sha }}',
        CF_WORKER_NAME: '${{ vars.CF_WORKER_NAME }}',
        CF_BOT_STATE_NAMESPACE_ID: '${{ vars.CF_BOT_STATE_NAMESPACE_ID }}',
        CF_WORKER_URL: '${{ vars.CF_WORKER_URL }}',
      },
      steps: [
        checkoutStep({ ref: '${{ github.sha }}' }),
        ...livestoreContribSetupStepsAfterCheckout,
        { name: 'Install workspace dependencies', run: runDevenvTasksBefore('pnpm:install') },
        {
          name: 'Plan and enforce adoption gate',
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
          name: 'Deploy approved staging plan',
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
        nixDiagnosticsArtifactStep(),
      ],
    },
  },
})

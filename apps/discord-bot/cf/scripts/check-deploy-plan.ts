import { readFile } from 'node:fs/promises'

/** Worker binding ids: plain names, or Alchemy's cron trigger rows such as `Cron(* * * * *)`. */
const bindingIdPattern = /^(?:[A-Za-z0-9_-]+|Cron\([0-9*/, -]+\))$/

/** Every binding the first production Worker declares; production never binds the E2E actor secret. */
const initialProductionBindings = new Set([
  'ADMIN_TOKEN',
  'BotState',
  'CF_VERSION_METADATA',
  'Cron(* * * * *)',
  'DEPLOY_STAGE',
  'DISCORD_APPLICATION_ID',
  'DISCORD_BOT_TOKEN',
  'DOCS_CORRELATION_KEY',
  'OPENAI_API_KEY',
  'RELEASE_ID',
])

/** Alchemy beta.72 LoggingCli plan rows; reject unknown formats rather than approving an unparsed plan. */
export const checkDeployPlan = (
  text: string,
  stage: 'staging' | 'production' = 'staging',
  allowInitialCreate = false,
  allowRelayRollback = false,
): true => {
  // oxlint-disable-next-line no-control-regex -- ANSI escape stripping is intentional for Alchemy CLI output.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (allowInitialCreate === true && stage !== 'production') throw new Error('initial create is production-only')
  const summaries = [...plain.matchAll(/^Plan: (.+)$/gm)]
  if (summaries.length !== 1) throw new Error('expected exactly one Alchemy plan summary')
  const summary = summaries[0]?.[1]
  if (summary === undefined || summary === 'no changes') {
    throw new Error('expected an existing Worker plan with explicit resource rows')
  }

  const counts: Record<string, number> = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 }
  for (const part of summary.split(', ')) {
    const match = /^(\d+) to (create|update|replace|delete|noop)$/.exec(part)
    if (match === null || counts[match[2]!] !== 0) throw new Error('unrecognized plan summary')
    counts[match[2]!] = Number(match[1])
  }
  if (counts.replace !== 0 || counts.delete !== 0) throw new Error('plan contains replace or delete actions')

  const rows = [...plain.matchAll(/^\[([^\]\n]+)\] (create|update|replace|delete|noop)(?: \([^\n)]*\))*$/gm)]
  const resourceRows = rows.filter((row) => !row[1]!.includes('/'))
  if (resourceRows.length !== Object.values(counts).reduce((sum, count) => sum + count, 0)) {
    throw new Error('plan resource rows do not match the summary')
  }
  if (rows.filter((row) => row[1] === 'DiscordBot').length !== 1) {
    throw new Error('plan must identify the existing DiscordBot Worker')
  }
  if (allowInitialCreate === true) {
    // Alchemy renders the Durable Object namespace as a Worker binding row, so the first
    // production plan is one Worker create whose bindings are exactly the declared set.
    const bindings = rows.filter((row) => row[1] !== 'DiscordBot').map((row) => row[1]!.slice('DiscordBot/'.length))
    if (
      resourceRows.length !== 1 ||
      resourceRows[0]?.[2] !== 'create' ||
      counts.create !== 1 ||
      counts.update !== 0 ||
      counts.noop !== 0 ||
      bindings.length !== initialProductionBindings.size ||
      bindings.some((binding) => initialProductionBindings.has(binding) === false) === true
    ) {
      throw new Error('initial production plan must create exactly the Worker with its declared bindings')
    }
  }
  for (const row of rows) {
    const id = row[1]!
    const action = row[2]!
    if (id === 'DiscordBot' || id === 'BotState') {
      if ((allowInitialCreate === true ? action !== 'create' : action !== 'update' && action !== 'noop') === true) {
        throw new Error(`top-level resource ${id} cannot ${action}`)
      }
    } else if (
      id.startsWith('DiscordBot/') === true &&
      bindingIdPattern.test(id.slice('DiscordBot/'.length)) === true
    ) {
      if (
        allowInitialCreate === false &&
        allowRelayRollback === true &&
        action === 'delete' &&
        (id === 'DiscordBot/GATEWAY_RELAY_TOKEN' || id === 'DiscordBot/GATEWAY_TRANSPORT')
      )
        continue
      if (
        (allowInitialCreate === true
          ? action !== 'create'
          : action !== 'create' && action !== 'update' && action !== 'noop') === true
      ) {
        throw new Error(`binding ${id} cannot ${action}`)
      }
    } else {
      throw new Error(`unexpected plan resource ${id}`)
    }
  }
  // Reject unparsed action rows, including a new CLI format that our row parser does not understand.
  const actionLines = plain.split('\n').filter((line) => /^\[.+\] (?:create|update|replace|delete|noop)\b/.test(line))
  if (actionLines.length !== rows.length) throw new Error('unrecognized plan action row')
  return true
}

if (import.meta.main) {
  const [path, stageFlag, stage, bootstrapFlag] = process.argv.slice(2)
  if (
    path === undefined ||
    (stageFlag !== undefined && stageFlag !== '--stage') ||
    (stageFlag === '--stage' && stage !== 'staging' && stage !== 'production') ||
    (bootstrapFlag !== undefined && bootstrapFlag !== '--allow-initial-create') ||
    process.argv.length > 6
  ) {
    throw new Error('usage: check-deploy-plan.ts <plan-log> [--stage staging|production [--allow-initial-create]]')
  }
  checkDeployPlan(
    await readFile(path, 'utf8'),
    stage ?? 'staging',
    bootstrapFlag === '--allow-initial-create',
    process.env.CF_GATEWAY_TRANSPORT === 'embedded' && process.env.CF_ALLOW_RELAY_ROLLBACK === '1',
  )
  console.log('Discord bot plan gate passed')
}

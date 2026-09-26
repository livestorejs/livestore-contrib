import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { canonicalStagingIdentity } from '../src/release.ts'

const VersionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const Version = Schema.Struct({
  id: VersionId,
  number: Schema.optional(Schema.Number),
  metadata: Schema.optional(
    Schema.Struct({ created_on: Schema.optional(Schema.String), source: Schema.optional(Schema.String) }),
  ),
})
const Deployment = Schema.Struct({
  id: VersionId,
  created_on: Schema.String,
  strategy: Schema.Literal('percentage'),
  versions: Schema.Array(Schema.Struct({ version_id: VersionId, percentage: Schema.Number })),
})
const VersionsResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ items: Schema.Array(Version) }),
})
const DeploymentsResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ deployments: Schema.Array(Deployment) }),
})
const VersionResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: VersionId,
    resources: Schema.Struct({
      bindings: Schema.optional(Schema.Unknown),
      script_runtime: Schema.optional(Schema.Struct({ migration_tag: Schema.optional(Schema.String) })),
    }),
  }),
})
const DeploymentResponse = Schema.Struct({ success: Schema.Literal(true), result: Deployment })

export type RollbackCommand =
  | { readonly action: 'list' }
  | { readonly action: 'select'; readonly version: typeof VersionId.Type; readonly assertDoCompatible: boolean }

export const parseRollbackArgs = (args: readonly string[], approval: string | undefined): RollbackCommand => {
  if (args.length === 1 && args[0] === 'list') return { action: 'list' }
  if (args[0] !== 'select')
    throw new Error('usage: cf:rollback list | select --version <UUID> --yes --assert-do-compatible')
  const flags = args.slice(1)
  if (flags.length !== 4 || flags[0] !== '--version' || flags[2] !== '--yes' || flags[3] !== '--assert-do-compatible') {
    throw new Error('select requires --version <UUID> --yes --assert-do-compatible (in that order)')
  }
  const version = Schema.decodeUnknownSync(VersionId)(flags[1])
  if (approval !== 'deploy') throw new Error('select requires AGENT_ACTION_APPROVAL=deploy')
  return { action: 'select', version, assertDoCompatible: true }
}

const Binding = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})
const releaseIdFromBindings = (raw: unknown): string | undefined => {
  const bindings = Array.isArray(raw)
    ? raw.map((binding) => ['', binding] as const)
    : raw !== null && typeof raw === 'object'
      ? Object.entries(raw)
      : []
  for (const [key, binding] of bindings) {
    const decoded = Schema.decodeUnknownOption(Binding)(binding)
    if (
      decoded._tag === 'Some' &&
      decoded.value.type === 'plain_text' &&
      (decoded.value.name ?? key) === 'RELEASE_ID'
    ) {
      return decoded.value.text
    }
  }
  return undefined
}

export interface RollbackHttpClient {
  readonly request: (url: string, init: RequestInit) => Promise<Response>
}

export interface RollbackConfig {
  readonly accountId: string
  readonly workerName: string
  readonly apiToken: string
}

export const rollback = (command: RollbackCommand, config: RollbackConfig, client: RollbackHttpClient) =>
  Effect.gen(function* () {
    if (
      config.workerName !== canonicalStagingIdentity.workerName ||
      config.accountId !== '0e7b96be3cd78f3fc7a134ef6fed4c39'
    ) {
      return yield* Effect.die('rollback is admitted only for the canonical staging account and Worker')
    }
    const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(config.workerName)}`
    const request = (path: string, init: RequestInit = {}) =>
      Effect.tryPromise({
        try: async () => {
          const response = await client.request(`${base}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${config.apiToken}`, ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(15_000),
          })
          if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status}`)
          return response.json() as Promise<unknown>
        },
        catch: () => new Error('Cloudflare rollback API request failed (response details withheld)'),
      })
    const decode = <A, I>(schema: Schema.Codec<A, I>, payload: unknown) => Schema.decodeUnknownEffect(schema)(payload)
    const versions = yield* request('/versions?deployable=true').pipe(
      Effect.flatMap((payload) => decode(VersionsResponse, payload)),
    )
    const deployments = yield* request('/deployments?per_page=1').pipe(
      Effect.flatMap((payload) => decode(DeploymentsResponse, payload)),
    )
    const current = deployments.result.deployments[0]
    const details = (id: typeof VersionId.Type) =>
      request(`/versions/${encodeURIComponent(id)}`).pipe(Effect.flatMap((payload) => decode(VersionResponse, payload)))
    if (command.action === 'list') {
      return {
        environment: 'staging',
        currentVersionId:
          current?.versions.length === 1 && current.versions[0]?.percentage === 100
            ? current.versions[0].version_id
            : undefined,
        versions: yield* Effect.forEach(versions.result.items, (version) =>
          Effect.map(details(version.id), (detail) => ({
            versionId: version.id,
            number: version.number,
            createdOn: version.metadata?.created_on,
            source: version.metadata?.source,
            releaseId: releaseIdFromBindings(detail.result.resources.bindings),
            migrationTag: detail.result.resources.script_runtime?.migration_tag,
          })),
        ),
      }
    }
    if (current === undefined || current.versions.length !== 1 || current.versions[0]?.percentage !== 100) {
      return yield* Effect.die('current deployment is absent or split; binary rollback is unsafe')
    }
    const currentId = current.versions[0].version_id
    if (command.assertDoCompatible !== true) return yield* Effect.die('explicit DO compatibility assertion is required')
    if (command.version === currentId) return yield* Effect.die('selected version is already deployed')
    if (!versions.result.items.some((version) => version.id === command.version)) {
      return yield* Effect.die('selected version is not a deployable version of the staging Worker')
    }
    const from = yield* details(currentId)
    const to = yield* details(command.version)
    const fromReleaseId = releaseIdFromBindings(from.result.resources.bindings)
    const toReleaseId = releaseIdFromBindings(to.result.resources.bindings)
    if (
      fromReleaseId === undefined ||
      toReleaseId === undefined ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(fromReleaseId) ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(toReleaseId)
    )
      return yield* Effect.die('both Worker versions must expose safe, nonempty RELEASE_ID bindings')
    const fromTag = from.result.resources.script_runtime?.migration_tag
    const toTag = to.result.resources.script_runtime?.migration_tag
    if (fromTag !== undefined && toTag !== undefined && fromTag !== toTag) {
      return yield* Effect.die(
        'Durable Object migration tags differ; old code cannot be selected across a migration boundary',
      )
    }
    const body = {
      strategy: 'percentage' as const,
      versions: [{ version_id: command.version, percentage: 100 }],
      annotations: { 'workers/message': `Discord bot staging select existing version ${command.version}` },
    }
    const deployed = yield* request('/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).pipe(Effect.flatMap((payload) => decode(DeploymentResponse, payload)))
    if (
      deployed.result.versions.length !== 1 ||
      deployed.result.versions[0]?.version_id !== command.version ||
      deployed.result.versions[0]?.percentage !== 100
    )
      return yield* Effect.die('Cloudflare deployment response does not confirm a binary selection')
    return {
      environment: 'staging',
      fromVersionId: currentId,
      toVersionId: command.version,
      fromReleaseId,
      toReleaseId,
      time: deployed.result.created_on,
      deploymentId: deployed.result.id,
      readiness: 'UNVERIFIED' as const,
    }
  })

const main = Effect.gen(function* () {
  let command: RollbackCommand
  try {
    command = parseRollbackArgs(process.argv.slice(2), process.env['AGENT_ACTION_APPROVAL'])
  } catch {
    console.error(
      'Rollback arguments or approval invalid; usage: cf:rollback list | select --version <UUID> --yes --assert-do-compatible (AGENT_ACTION_APPROVAL=deploy)',
    )
    process.exitCode = 2
    return
  }
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID']
  const workerName = process.env['CF_WORKER_NAME']
  const apiToken = process.env['CLOUDFLARE_API_TOKEN']
  if (!accountId || !workerName || !apiToken) {
    console.error('Rollback requires CLOUDFLARE_ACCOUNT_ID, CF_WORKER_NAME, CLOUDFLARE_API_TOKEN')
    process.exitCode = 2
    return
  }
  const exit = yield* Effect.exit(rollback(command, { accountId, workerName, apiToken }, { request: fetch }))
  if (exit._tag === 'Failure') {
    console.error('Rollback failed; verify staging identity, version metadata, API permissions, and DO compatibility')
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(exit.value))
})

if (import.meta.main) NodeRuntime.runMain(main)

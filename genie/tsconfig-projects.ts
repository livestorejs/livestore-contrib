import { rootWorkspacePackages } from '../package.json.genie.ts'
import adapterExpoTsconfig from '../packages/@livestore/adapter-expo/tsconfig.json.genie.ts'
import adapterNodeTsconfig from '../packages/@livestore/adapter-node/tsconfig.json.genie.ts'
import cliTsconfig from '../packages/@livestore/cli/tsconfig.json.genie.ts'
import devtoolsExpoTsconfig from '../packages/@livestore/devtools-expo/tsconfig.json.genie.ts'
import graphqlTsconfig from '../packages/@livestore/graphql/tsconfig.json.genie.ts'
import solidTsconfig from '../packages/@livestore/solid/tsconfig.json.genie.ts'
import svelteTsconfig from '../packages/@livestore/svelte/tsconfig.json.genie.ts'
import syncElectricTsconfig from '../packages/@livestore/sync-electric/tsconfig.json.genie.ts'
import syncS2Tsconfig from '../packages/@livestore/sync-s2/tsconfig.json.genie.ts'
import type { GenieOutput, TSConfigArgs } from '../repos/effect-utils/genie/external.ts'
import testsIntegrationTsconfig from '../tests/integration/tsconfig.json.genie.ts'
import testsScenariosTsconfig from '../tests/scenarios/tsconfig.json.genie.ts'
import testsSyncProviderTsconfig from '../tests/sync-provider/tsconfig.json.genie.ts'

export type RootTsconfigProject = {
  path: string
  tsconfig: GenieOutput<TSConfigArgs>
}

const workspaceTsconfigsByPath: Record<string, GenieOutput<TSConfigArgs>> = {
  'packages/@livestore/adapter-expo': adapterExpoTsconfig,
  'packages/@livestore/adapter-node': adapterNodeTsconfig,
  'packages/@livestore/cli': cliTsconfig,
  'packages/@livestore/devtools-expo': devtoolsExpoTsconfig,
  'packages/@livestore/graphql': graphqlTsconfig,
  'packages/@livestore/solid': solidTsconfig,
  'packages/@livestore/svelte': svelteTsconfig,
  'packages/@livestore/sync-electric': syncElectricTsconfig,
  'packages/@livestore/sync-s2': syncS2Tsconfig,
  'tests/integration': testsIntegrationTsconfig,
  'tests/scenarios': testsScenariosTsconfig,
  'tests/sync-provider': testsSyncProviderTsconfig,
}

const rootWorkspacePackagePaths = rootWorkspacePackages.map((pkg) => pkg.meta.workspace.memberPath)

const missingTsconfigPaths = rootWorkspacePackagePaths.filter((path) => workspaceTsconfigsByPath[path] === undefined)
const extraTsconfigPaths = Object.keys(workspaceTsconfigsByPath).filter(
  (path) => rootWorkspacePackagePaths.includes(path) === false,
)

if (missingTsconfigPaths.length > 0 || extraTsconfigPaths.length > 0) {
  throw new Error(
    [
      'root tsconfig project registry drifted from rootWorkspacePackages',
      missingTsconfigPaths.length > 0
        ? `missing tsconfig data for workspace packages: ${missingTsconfigPaths.join(', ')}`
        : undefined,
      extraTsconfigPaths.length > 0
        ? `tsconfig data without workspace package: ${extraTsconfigPaths.join(', ')}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  )
}

const workspaceTsconfigProject = (path: string): RootTsconfigProject => {
  const tsconfig = workspaceTsconfigsByPath[path]
  if (tsconfig === undefined) {
    throw new Error(`missing tsconfig data for workspace package: ${path}`)
  }
  return { path, tsconfig }
}

export const rootWorkspaceTsconfigProjects = rootWorkspacePackagePaths.map(workspaceTsconfigProject)

export const rootTsconfigProjects = rootWorkspaceTsconfigProjects

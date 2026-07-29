import { readFileSync } from 'node:fs'

import { coreOwnedPackageNames, rootWorkspaceExtraMembers as rootExampleWorkspaceMembers } from './genie/internal.ts'
import { packageJson } from './genie/repo.ts'
import adapterExpoPkg from './packages/@livestore/adapter-expo/package.json.genie.ts'
import adapterNodePkg from './packages/@livestore/adapter-node/package.json.genie.ts'
import cliPkg from './packages/@livestore/cli/package.json.genie.ts'
import devtoolsCommonPkg from './packages/@livestore/devtools-common/package.json.genie.ts'
import devtoolsExpoPkg from './packages/@livestore/devtools-expo/package.json.genie.ts'
import graphqlPkg from './packages/@livestore/graphql/package.json.genie.ts'
import solidPkg from './packages/@livestore/solid/package.json.genie.ts'
import sveltePkg from './packages/@livestore/svelte/package.json.genie.ts'
import syncElectricPkg from './packages/@livestore/sync-electric/package.json.genie.ts'
import syncS2Pkg from './packages/@livestore/sync-s2/package.json.genie.ts'
import testsIntegrationPkg from './tests/integration/package.json.genie.ts'
import testsSyncProviderPkg from './tests/sync-provider/package.json.genie.ts'

export const rootWorkspacePackages = [
  adapterExpoPkg,
  adapterNodePkg,
  cliPkg,
  devtoolsCommonPkg,
  devtoolsExpoPkg,
  graphqlPkg,
  solidPkg,
  sveltePkg,
  syncElectricPkg,
  syncS2Pkg,
  testsIntegrationPkg,
  testsSyncProviderPkg,
] as const

const materializedCorePackageClosureMemberPaths = [
  ...new Set(
    rootWorkspacePackages.flatMap(
      (pkg) =>
        (
          JSON.parse(readFileSync(`${pkg.meta.workspace.memberPath}/package.json`, 'utf8')) as {
            $genie?: { workspaceClosureDirs?: readonly string[] }
          }
        ).$genie?.workspaceClosureDirs?.filter(
          (path) =>
            path.startsWith('repos/livestore/packages/@livestore/') ||
            path.startsWith('repos/effect-utils/packages/@overeng/'),
        ) ?? [],
    ),
  ),
].toSorted()

export const rootWorkspaceExtraMembers = [
  ...rootExampleWorkspaceMembers,
  ...materializedCorePackageClosureMemberPaths,
] as const

const rootWorkspace = packageJson.aggregateFromPackages({
  packages: rootWorkspacePackages,
  name: 'livestore-contrib-workspace',
  repoName: 'livestore-contrib',
  extraMembers: rootWorkspaceExtraMembers,
})

const rootWorkspaceExtraFields = {
  scripts: {
    format: 'oxfmt .',
    lint: 'oxlint --import-plugin',
  },
} as const

const rootWorkspaceWithScripts = {
  ...rootWorkspace,
  data: {
    ...rootWorkspace.data,
    ...rootWorkspaceExtraFields,
  },
  stringify: (ctx: Parameters<typeof rootWorkspace.stringify>[0]) => {
    const generated = JSON.parse(rootWorkspace.stringify(ctx))
    return `${JSON.stringify(
      {
        ...generated,
        $genie: {
          ...generated.$genie,
          coreOwnedPackageNames,
        },
        scripts: {
          ...generated.scripts,
          ...rootWorkspaceExtraFields.scripts,
        },
      },
      null,
      2,
    )}\n`
  },
} satisfies typeof rootWorkspace

export const rootWorkspaceMemberPaths = rootWorkspaceWithScripts.data.workspaces

export default rootWorkspaceWithScripts

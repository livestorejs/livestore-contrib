import { rootWorkspaceExtraMembers } from './genie/internal.ts'
import { packageJson } from './genie/repo.ts'

export const rootWorkspacePackages = [] as const

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

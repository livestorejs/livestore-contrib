import { packageJson } from './genie/repo.ts'
import { rootWorkspaceExtraMembers } from './genie/internal.ts'

export const rootWorkspacePackages = [] as const

const rootWorkspace = packageJson.aggregateFromPackages({
  packages: rootWorkspacePackages,
  name: 'livestore-contrib-workspace',
  repoName: 'livestore-contrib',
  extraMembers: rootWorkspaceExtraMembers,
})

export const rootWorkspaceMemberPaths = rootWorkspace.data.workspaces

export default rootWorkspace

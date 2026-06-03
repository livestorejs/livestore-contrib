import {
  catalog,
  commonPnpmPolicySettings,
  pnpmWorkspaceYaml,
  repoPnpmAllowBuilds,
} from './genie/repo.ts'
import { rootWorkspaceExtraMembers } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'livestore-contrib',
  extraMembers: rootWorkspaceExtraMembers,
  catalogVersions: catalog,
  ...commonPnpmPolicySettings,
  injectWorkspacePackages: false,
  allowBuilds: repoPnpmAllowBuilds,
  strictPeerDependencies: false,
  linkWorkspacePackages: true,
})

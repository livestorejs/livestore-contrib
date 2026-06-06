import { catalog } from './genie/external.ts'
import { commonPnpmPolicySettings, pnpmWorkspaceYaml, repoPnpmAllowBuilds } from './genie/repo.ts'
import { rootWorkspaceExtraMembers, rootWorkspacePackages } from './package.json.genie.ts'

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

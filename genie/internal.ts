import {
  livestoreContribExampleMembers,
  livestoreContribPackageNames,
  livestoreCorePackageNames,
  materializedMemberPathsForProjection,
} from '../repos/livestore/genie/external.ts'

export const contribPackageNames = livestoreContribPackageNames
export const coreOwnedPackageNames = livestoreCorePackageNames
export const contribExampleMembers = livestoreContribExampleMembers

export const contribWorkspaceMemberPaths = [
  ...contribPackageNames.map((name) => `packages/@livestore/${name}`),
  ...contribExampleMembers,
] as const

export const materializedCoreWorkspaceMemberPaths = materializedMemberPathsForProjection('core', 'repos/livestore')

export const rootWorkspaceExtraMembers = [
  ...contribWorkspaceMemberPaths,
  ...materializedCoreWorkspaceMemberPaths,
] as const

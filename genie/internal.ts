import { livestoreCorePackageNames, materializedMemberPathsForProjection } from '../repos/livestore/genie/external.ts'

export const contribPackageNames = [
  'adapter-expo',
  'adapter-node',
  'cli',
  'devtools-expo',
  'graphql',
  'solid',
  'svelte',
  'sync-electric',
  'sync-s2',
] as const

export const coreOwnedPackageNames = livestoreCorePackageNames

export const contribExampleMembers = [
  'examples/cf-chat',
  'examples/cf-chat-solid',
  'examples/expo-linearlite',
  'examples/expo-todomvc-sync-cf',
  'examples/node-effect-cli',
  'examples/node-todomvc-sync-cf',
  'examples/web-multi-store',
  'examples/web-todomvc-solid',
  'examples/web-todomvc-svelte',
  'examples/web-todomvc-sync-electric',
  'examples/web-todomvc-sync-s2',
] as const

export const contribWorkspaceMemberPaths = [
  ...contribPackageNames.map((name) => `packages/@livestore/${name}`),
  ...contribExampleMembers,
] as const

export const materializedCoreWorkspaceMemberPaths = materializedMemberPathsForProjection('core', 'repos/livestore')

export const rootWorkspaceExtraMembers = [...contribExampleMembers, ...materializedCoreWorkspaceMemberPaths] as const

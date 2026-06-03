export const contribPackageNames = [
  'adapter-expo',
  'adapter-node',
  'cli',
  'devtools-expo',
  'devtools-web-common',
  'graphql',
  'solid',
  'svelte',
  'sync-electric',
  'sync-s2',
] as const

export const coreOwnedPackageNames = [
  'adapter-cloudflare',
  'adapter-web',
  'common',
  'common-cf',
  'framework-toolkit',
  'livestore',
  'peer-deps',
  'react',
  'sqlite-wasm',
  'sync-cf',
  'utils',
  'utils-dev',
  'wa-sqlite',
  'webmesh',
] as const

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

export const materializedCoreWorkspaceMemberPaths = coreOwnedPackageNames.map(
  (name) => `repos/livestore/packages/@livestore/${name}`,
)

export const rootWorkspaceExtraMembers = [
  ...contribWorkspaceMemberPaths,
  ...materializedCoreWorkspaceMemberPaths,
] as const

import { readFileSync } from 'node:fs'

import {
  livestoreCorePackageNames,
  packageDirForPackageName,
  type LivestorePackageName,
} from '../repos/livestore/genie/external.ts'

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
  'examples/crdt-in-livestore',
  'examples/expo-linearlite',
  'examples/expo-todomvc-sync-cf',
  'examples/node-effect-cli',
  'examples/node-todomvc-sync-cf',
  'examples/web-multi-store',
  'examples/web-todomvc-custom-elements',
  'examples/web-todomvc-experimental',
  'examples/web-todomvc-solid',
  'examples/web-todomvc-svelte',
  'examples/web-todomvc-sync-electric',
  'examples/web-todomvc-sync-s2',
] as const

export const contribWorkspaceMemberPaths = [
  ...contribPackageNames.map((name) => `packages/@livestore/${name}`),
  ...contribExampleMembers,
] as const

const corePackageNames = new Set<string>(livestoreCorePackageNames)

const corePackageNameFromPackageJsonName = (name: string): LivestorePackageName | undefined => {
  if (!name.startsWith('@livestore/')) return undefined

  const packageName = name.slice('@livestore/'.length)
  return corePackageNames.has(packageName) ? (packageName as LivestorePackageName) : undefined
}

const dependenciesForExample = (memberPath: string) => {
  const manifest = JSON.parse(readFileSync(`${memberPath}/package.json`, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }

  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  })
}

export const materializedCoreExampleWorkspaceMemberPaths = [
  ...new Set(
    contribExampleMembers
      .flatMap(dependenciesForExample)
      .map(corePackageNameFromPackageJsonName)
      .filter((name): name is LivestorePackageName => name !== undefined)
      .map((name) => `repos/livestore/${packageDirForPackageName(name)}`),
  ),
].toSorted()

export const rootWorkspaceExtraMembers = [
  ...contribExampleMembers,
  ...materializedCoreExampleWorkspaceMemberPaths,
] as const

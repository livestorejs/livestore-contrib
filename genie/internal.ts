import { readFileSync } from 'node:fs'

import {
  livestoreCorePackageNames,
  packageDirForPackageName,
  type LivestorePackageName,
} from '../repos/livestore/genie/external.ts'
import { contribExampleMembers } from './examples.ts'

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

export const contribWorkspaceMemberPaths = [
  ...contribPackageNames.map((name) => `packages/@livestore/${name}`),
  ...contribExampleMembers,
] as const

const corePackageNames = new Set<string>(livestoreCorePackageNames)

const corePackageNameFromPackageJsonName = (name: string): LivestorePackageName | undefined => {
  if (name.startsWith('@livestore/') === false) return undefined

  const packageName = name.slice('@livestore/'.length)
  return corePackageNames.has(packageName) === true ? (packageName as LivestorePackageName) : undefined
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

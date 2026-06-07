#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

const rootDir = process.cwd()
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const readJson = (path) => JSON.parse(readFileSync(join(rootDir, path), 'utf8'))

const errors = []
const addError = (message) => errors.push(message)

const coreVersion = readJson('repos/livestore/release/version.json').version
if (typeof coreVersion !== 'string' || coreVersion.length === 0) {
  addError('repos/livestore/release/version.json must contain a non-empty version string')
}

const rootManifest = readJson('package.json')
const coreOwnedPackageNames = rootManifest.$genie?.coreOwnedPackageNames
if (!Array.isArray(coreOwnedPackageNames) || coreOwnedPackageNames.length === 0) {
  addError('package.json must expose $genie.coreOwnedPackageNames')
}

const corePackageNames = new Set(
  Array.isArray(coreOwnedPackageNames) ? coreOwnedPackageNames.map((name) => `@livestore/${name}`) : [],
)

const packageRoot = join(rootDir, 'packages/@livestore')
const packagePaths = readdirSync(packageRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/@livestore/${entry.name}/package.json`)
  .filter((path) => existsSync(join(rootDir, path)))
  .sort()

const packages = packagePaths.map((path) => ({ path, manifest: readJson(path) }))
const publishablePackages = packages.filter(
  ({ manifest }) => manifest.private !== true && manifest.publishConfig?.access === 'public',
)
const contribPackageNames = new Set(publishablePackages.map(({ manifest }) => manifest.name))

const cloneJson = (value) => JSON.parse(JSON.stringify(value))
const isLocalProtocol = (spec) =>
  typeof spec === 'string' && (spec.startsWith('workspace:') || spec.startsWith('link:') || spec.startsWith('file:'))

const rewriteDependency = ({ packageName, section, dependencyName, spec }) => {
  if (typeof spec !== 'string') return spec

  if (spec.startsWith('link:')) {
    if (!corePackageNames.has(dependencyName)) {
      addError(`${packageName} ${section}.${dependencyName} uses ${spec}, but ${dependencyName} is not a core package`)
      return spec
    }
    if (!spec.startsWith('link:../../../repos/livestore/packages/@livestore/')) {
      addError(`${packageName} ${section}.${dependencyName} uses unsupported core link path ${spec}`)
      return spec
    }
    return coreVersion
  }

  if (spec.startsWith('workspace:')) {
    if (!contribPackageNames.has(dependencyName)) {
      addError(
        `${packageName} ${section}.${dependencyName} uses ${spec}, but ${dependencyName} is not a publishable contrib package`,
      )
      return spec
    }
    return coreVersion
  }

  if (spec.startsWith('file:')) {
    addError(`${packageName} ${section}.${dependencyName} uses unsupported publish-time file protocol ${spec}`)
  }

  return spec
}

const plan = {
  coreVersion,
  packageCount: publishablePackages.length,
  packages: [],
}

for (const { path, manifest } of publishablePackages) {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    addError(`${path} must have a package name`)
    continue
  }
  if (manifest.version !== coreVersion) {
    addError(`${manifest.name} version ${manifest.version} does not match core version ${coreVersion}`)
  }

  const simulatedManifest = cloneJson(manifest)
  const rewrites = []

  for (const section of dependencySections) {
    const dependencies = simulatedManifest[section]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      addError(`${manifest.name} ${section} must be an object when present`)
      continue
    }

    for (const [dependencyName, spec] of Object.entries(dependencies)) {
      const rewritten = rewriteDependency({
        packageName: manifest.name,
        section,
        dependencyName,
        spec,
      })
      if (rewritten !== spec) {
        rewrites.push({ section, dependencyName, from: spec, to: rewritten })
        dependencies[dependencyName] = rewritten
      }
    }
  }

  for (const section of dependencySections) {
    for (const [dependencyName, spec] of Object.entries(simulatedManifest[section] ?? {})) {
      if (isLocalProtocol(spec)) {
        addError(`${manifest.name} ${section}.${dependencyName} still uses local protocol ${spec}`)
      }
    }
  }

  plan.packages.push({
    name: manifest.name,
    path,
    version: simulatedManifest.version,
    rewrites,
    manifest: simulatedManifest,
  })
}

if (publishablePackages.length === 0) {
  addError('expected at least one publishable contrib package')
}

const outIndex = process.argv.indexOf('--out')
let outPath
if (outIndex !== -1) {
  outPath = process.argv[outIndex + 1]
  if (outPath === undefined || outPath.length === 0) {
    addError('--out requires a path')
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

if (outPath !== undefined) {
  const absoluteOutPath = isAbsolute(outPath) ? outPath : join(rootDir, outPath)
  mkdirSync(dirname(absoluteOutPath), { recursive: true })
  writeFileSync(absoluteOutPath, `${JSON.stringify(plan, null, 2)}\n`)
}

const rewriteCount = plan.packages.reduce((count, pkg) => count + pkg.rewrites.length, 0)
console.log(
  `Simulated ${plan.packageCount} publishable packages at ${coreVersion}; rewrote ${rewriteCount} local dependency specs.`,
)
for (const pkg of plan.packages) {
  const packagePath = relative(rootDir, join(rootDir, pkg.path))
  console.log(`- ${pkg.name}: ${pkg.rewrites.length} rewrites (${packagePath})`)
}

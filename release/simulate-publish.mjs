#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

import { applyVendorPlan, cleanupVendorPlan, planVendorPackage } from './vendor-package.mjs'

const rootDir = process.cwd()
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const readJson = (path) => JSON.parse(readFileSync(join(rootDir, path), 'utf8'))
const writeJson = (path, value) => writeFileSync(join(rootDir, path), `${JSON.stringify(value, null, 2)}\n`)

const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const hasArg = (name) => args.includes(name)

const gitSha = readArg('--git-sha')
const explicitVersion = readArg('--version')
const explicitCoreVersion = readArg('--core-version') ?? process.env.LIVESTORE_CORE_RELEASE_VERSION
const releaseVersion = explicitVersion ?? (gitSha === undefined ? undefined : `0.0.0-snapshot-${gitSha}`)
const publish = hasArg('--publish')
const dryRun = hasArg('--dry-run')
const verifyCore = hasArg('--verify-core')

if (publish === true && dryRun === true) {
  console.error('--publish and --dry-run are mutually exclusive')
  process.exit(1)
}

const errors = []
const addError = (message) => errors.push(message)

const coreVersion = readJson('repos/livestore/release/version.json').version
if (typeof coreVersion !== 'string' || coreVersion.length === 0) {
  addError('repos/livestore/release/version.json must contain a non-empty version string')
}
const coreReleaseVersion = explicitCoreVersion ?? coreVersion

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
const requiredCorePackages = new Set()

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
    requiredCorePackages.add(dependencyName)
    return coreReleaseVersion
  }

  if (spec.startsWith('workspace:')) {
    if (!contribPackageNames.has(dependencyName)) {
      addError(
        `${packageName} ${section}.${dependencyName} uses ${spec}, but ${dependencyName} is not a publishable contrib package`,
      )
      return spec
    }
    return releaseVersion ?? coreVersion
  }

  if (spec.startsWith('file:')) {
    addError(`${packageName} ${section}.${dependencyName} uses unsupported publish-time file protocol ${spec}`)
  }

  return spec
}

const plan = {
  coreVersion: coreReleaseVersion,
  packageCount: publishablePackages.length,
  packages: [],
}
const vendorPlans = new Map()

const DEFAULT_RELEASE_BUILD = {
  command: ['pnpm', 'exec', 'tsc', '--build', 'tsconfig.json', '--noCheck'],
  outputs: ['dist'],
}

// Only pnpm may be invoked: the build runs with the repo's toolchain on PATH, so an
// arbitrary binary here would be an unreviewed execution surface in the release path.
const ALLOWED_BUILD_BINARIES = new Set(['pnpm'])

/**
 * Resolve a package's release build. Absence means "the tsc default" so existing
 * packages need no change, but a malformed spec is an error rather than a silent
 * fallback — a package that declares a build must get the build it declared.
 */
const releaseBuildFor = ({ name, manifest }) => {
  const spec = manifest.$genie?.releaseBuild
  if (spec === undefined) return DEFAULT_RELEASE_BUILD
  if (Array.isArray(spec.command) === false || Array.isArray(spec.outputs) === false) {
    addError(`${name} $genie.releaseBuild must be { command: string[], outputs: string[] }`)
    return DEFAULT_RELEASE_BUILD
  }
  if (spec.command.length > 0 && ALLOWED_BUILD_BINARIES.has(spec.command[0]) === false) {
    addError(
      `${name} $genie.releaseBuild.command must start with one of: ${[...ALLOWED_BUILD_BINARIES].join(', ')}`,
    )
  }
  return spec
}

for (const { path, manifest } of publishablePackages) {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    addError(`${path} must have a package name`)
    continue
  }
  const expectedVersion = releaseVersion ?? coreVersion
  if (manifest.version !== expectedVersion) {
    addError(`${manifest.name} version ${manifest.version} does not match release version ${expectedVersion}`)
  }

  let simulatedManifest = cloneJson(manifest)
  let vendorPlan = { manifest: simulatedManifest, vendors: [] }
  try {
    vendorPlan = planVendorPackage({
      rootDir,
      targetPackageDir: dirname(join(rootDir, path)),
      manifest: simulatedManifest,
    })
    simulatedManifest = vendorPlan.manifest
    vendorPlans.set(manifest.name, vendorPlan)
  } catch (error) {
    addError(`${manifest.name} release vendor: ${error instanceof Error ? error.message : String(error)}`)
  }
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

  const releaseBuild = releaseBuildFor({ name: manifest.name, manifest })

  // Static honesty check: whatever the build emits must actually be shipped.
  // Runs on the no-build `release:surface:check` path too, so a package that builds
  // into a directory it does not publish fails at PR time rather than at publish.
  const shippedPaths = simulatedManifest.publishConfig?.files ?? simulatedManifest.files ?? []
  for (const output of releaseBuild.outputs ?? []) {
    const root = output.split('/')[0]
    if (shippedPaths.includes(root) === false) {
      addError(`${manifest.name} $genie.releaseBuild emits "${output}" but "${root}" is not in files`)
    }
  }

  plan.packages.push({
    name: manifest.name,
    path,
    version: simulatedManifest.version,
    rewrites,
    releaseBuild,
    vendors: vendorPlan.vendors.map((vendor) => ({
      dependency: vendor.dependency,
      fileCount: vendor.fileCount,
      provenance: vendor.provenance,
    })),
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

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, DEVENV_TASK_PASSTHROUGH: '1' },
    stdio: 'inherit',
    ...options,
  })

const npmViewExists = (name, version) => {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: rootDir,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

const waitForNpmView = (name, version) => {
  const attempts = 24
  const delayMs = 5_000

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (npmViewExists(name, version) === true) return

    if (attempt !== attempts) {
      console.log(`${name}@${version} is not visible on npm yet; retrying in ${delayMs / 1_000}s`)
      sleep(delayMs)
    }
  }

  throw new Error(`${name}@${version} is not visible on npm after publish`)
}

const packPackage = (pkg) => {
  const packageDir = dirname(join(rootDir, pkg.path))
  const packDir = mkdtempSync(join(tmpdir(), 'livestore-contrib-pack-'))
  run('pnpm', ['--dir', packageDir, 'pack', '--pack-destination', packDir])
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball for ${pkg.name}, found ${tarballs.length}`)
  }
  return { packDir, tarballPath: join(packDir, tarballs[0]) }
}

const walkFiles = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name)
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath]
  })

const localProtocolPaths = (value, path = []) => {
  if (typeof value === 'string') return isLocalProtocol(value) ? [path.join('.')] : []
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, entry]) => localProtocolPaths(entry, [...path, key]))
}

const bareOverengSpecifier = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](@overeng\/[^'"]+)['"]/g
const moduleFileExtension = /\.(?:[cm]?[jt]sx?)$/

const verifyPackedTarball = ({ pkg, tarballPath, vendorPlan }) => {
  const extractDir = mkdtempSync(join(tmpdir(), 'livestore-contrib-pack-verify-'))
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir], {
      cwd: rootDir,
      stdio: 'ignore',
    })

    const packageDir = join(extractDir, 'package')
    const packedManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const protocolPaths = localProtocolPaths(packedManifest)
    if (protocolPaths.length > 0) {
      throw new Error(`${pkg.name} packed manifest contains local protocols at: ${protocolPaths.join(', ')}`)
    }

    for (const section of dependencySections) {
      const overengDependencies = Object.keys(packedManifest[section] ?? {}).filter((name) =>
        name.startsWith('@overeng/'),
      )
      if (overengDependencies.length > 0) {
        throw new Error(`${pkg.name} packed manifest contains @overeng dependencies: ${overengDependencies.join(', ')}`)
      }
    }
    for (const [specifier, target] of Object.entries(packedManifest.imports ?? {})) {
      if (typeof target === 'string' && target.startsWith('@overeng/')) {
        throw new Error(`${pkg.name} packed imports.${specifier} contains bare specifier ${target}`)
      }
    }

    for (const path of walkFiles(packageDir).filter((path) => moduleFileExtension.test(path))) {
      const source = readFileSync(path, 'utf8')
      const match = bareOverengSpecifier.exec(source)
      bareOverengSpecifier.lastIndex = 0
      if (match !== null) {
        throw new Error(`${pkg.name} packed file ${relative(packageDir, path)} contains bare specifier ${match[1]}`)
      }
    }

    for (const vendor of vendorPlan?.vendors ?? []) {
      const vendorDir = join(packageDir, vendor.target)
      if (existsSync(vendorDir) === false || statSync(vendorDir).isDirectory() === false) {
        throw new Error(`${pkg.name} packed tarball is missing vendored directory ${vendor.target}`)
      }
      const license = readFileSync(join(vendorDir, 'LICENSE'), 'utf8')
      if (
        license.includes('Copyright (c) 2017 Xiaoyi Chen') === false ||
        license.includes('Johannes Schickling') === false
      ) {
        throw new Error(`${pkg.name} packed vendor LICENSE is missing required notices`)
      }
      const upstream = readFileSync(join(vendorDir, 'UPSTREAM.md'), 'utf8')
      if (upstream.includes('storybookjs/react-inspector') === false) {
        throw new Error(`${pkg.name} packed vendor UPSTREAM.md is missing provenance`)
      }
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

const buildPackages = () => {
  for (const pkg of plan.packages) {
    const build = pkg.releaseBuild ?? DEFAULT_RELEASE_BUILD
    if (build.command.length === 0) {
      console.log(`- ${pkg.name}: no release build declared, skipping`)
      continue
    }

    const packageDir = dirname(join(rootDir, pkg.path))
    const [binary, ...rest] = build.command
    run(binary, ['--dir', packageDir, ...rest])

    // Post-condition: without this a build that writes to the wrong directory
    // produces an empty tarball and the failure surfaces at install time.
    for (const output of build.outputs) {
      if (existsSync(join(packageDir, output)) === false) {
        throw new Error(`${pkg.name} release build did not produce "${output}"`)
      }
    }
  }
}

const originalManifests = new Map(
  plan.packages.map((pkg) => {
    const path = join(rootDir, pkg.path)
    return [
      pkg.path,
      {
        content: readFileSync(path, 'utf8'),
        mode: statSync(path).mode,
      },
    ]
  }),
)
let manifestRewritesApplied = false

const applyManifestRewrites = () => {
  manifestRewritesApplied = true
  for (const pkg of plan.packages) {
    const path = join(rootDir, pkg.path)
    chmodSync(path, originalManifests.get(pkg.path).mode | 0o200)
    writeJson(pkg.path, pkg.manifest)
  }
}

const restoreManifestRewrites = () => {
  if (manifestRewritesApplied === false) return
  manifestRewritesApplied = false
  for (const [path, original] of originalManifests) {
    const absolutePath = join(rootDir, path)
    chmodSync(absolutePath, original.mode | 0o200)
    writeFileSync(absolutePath, original.content)
    chmodSync(absolutePath, original.mode)
  }
}

const restoreManifestsOnSignal = (signal) => {
  const handler = () => {
    restoreManifestRewrites()
    process.removeListener(signal, handler)
    process.kill(process.pid, signal)
  }
  process.once(signal, handler)
}

restoreManifestsOnSignal('SIGINT')
restoreManifestsOnSignal('SIGTERM')

const restoreGeneratedFiles = () => {
  const env = { ...process.env, DEVENV_TASK_PASSTHROUGH: '1' }
  delete env.LIVESTORE_RELEASE_VERSION
  execFileSync('genie', ['--writeable'], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  })
}

const verifyRequiredCorePackages = () => {
  if (verifyCore === false) return
  for (const packageName of [...requiredCorePackages].sort()) {
    if (npmViewExists(packageName, plan.coreVersion) === false) {
      throw new Error(`Required core package is not visible on npm: ${packageName}@${plan.coreVersion}`)
    }
  }
}

const smokeInstallPackedTarballs = (packed) => {
  if (verifyCore === false) return

  const smokeDir = mkdtempSync(join(tmpdir(), 'livestore-contrib-install-smoke-'))
  try {
    const smokeManifest = {
      private: true,
      dependencies: Object.fromEntries(packed.map(({ pkg, tarballPath }) => [pkg.name, `file:${tarballPath}`])),
    }
    writeFileSync(join(smokeDir, 'package.json'), `${JSON.stringify(smokeManifest, null, 2)}\n`)
    writeFileSync(
      join(smokeDir, 'pnpm-workspace.yaml'),
      `packages: []\noverrides:\n${packed.map(({ pkg, tarballPath }) => `  ${JSON.stringify(pkg.name)}: ${JSON.stringify(`file:${tarballPath}`)}`).join('\n')}\n`,
    )
    run('pnpm', ['install', '--ignore-scripts'], { cwd: smokeDir })

    for (const { pkg } of packed) {
      const installedManifest = join(smokeDir, 'node_modules', ...pkg.name.split('/'), 'package.json')
      if (existsSync(installedManifest) === false) {
        throw new Error(`Install smoke did not materialize ${pkg.name}`)
      }
    }
  } finally {
    rmSync(smokeDir, { recursive: true, force: true })
  }
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
  const vendorCount = pkg.vendors.reduce((count, vendor) => count + vendor.fileCount, 0)
  console.log(`- ${pkg.name}: ${pkg.rewrites.length} rewrites, ${vendorCount} vendored files (${packagePath})`)
}

if (dryRun === true || publish === true) {
  verifyRequiredCorePackages()

  const packed = []
  const appliedVendorPlans = []
  try {
    applyManifestRewrites()

    for (const pkg of plan.packages) {
      const vendorPlan = vendorPlans.get(pkg.name)
      if (vendorPlan === undefined || vendorPlan.vendors.length === 0) continue
      applyVendorPlan(vendorPlan)
      appliedVendorPlans.push(vendorPlan)
    }

    buildPackages()

    for (const pkg of plan.packages) {
      const { packDir, tarballPath } = packPackage(pkg)
      packed.push({ pkg, packDir, tarballPath })
      verifyPackedTarball({ pkg, tarballPath, vendorPlan: vendorPlans.get(pkg.name) })
    }

    smokeInstallPackedTarballs(packed)

    for (const { pkg, tarballPath } of packed) {
      const existing = npmViewExists(pkg.name, pkg.version)
      if (existing === true && publish === true) {
        console.log(`${pkg.name}@${pkg.version} already published, skipping`)
        continue
      }

      const publishArgs = ['publish', tarballPath, '--tag=snapshot', '--access=public', '--ignore-scripts']
      if (dryRun === true) publishArgs.push('--dry-run')
      run('npm', publishArgs)
      console.log(`${dryRun === true ? 'Dry-ran' : 'Published'} ${pkg.name}@${pkg.version}`)
    }

    if (publish === true) {
      for (const pkg of plan.packages) {
        waitForNpmView(pkg.name, pkg.version)
      }
    }
  } finally {
    restoreManifestRewrites()
    for (const vendorPlan of appliedVendorPlans.reverse()) cleanupVendorPlan(vendorPlan)
    restoreGeneratedFiles()
    for (const { packDir } of packed) {
      rmSync(packDir, { recursive: true, force: true })
    }
  }
}

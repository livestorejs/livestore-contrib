#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

const rootDir = process.cwd()
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
/** Contrib publishes only under the snapshot dist-tag; verification checks this same tag. */
const SNAPSHOT_TAG = 'snapshot'

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

for (const { path, manifest } of publishablePackages) {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    addError(`${path} must have a package name`)
    continue
  }
  const expectedVersion = releaseVersion ?? coreVersion
  if (manifest.version !== expectedVersion) {
    addError(`${manifest.name} version ${manifest.version} does not match release version ${expectedVersion}`)
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

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, DT_PASSTHROUGH: '1' },
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

/** `npm view --json`, with any failure (unpublished version, network) reported as absent. */
const npmViewJson = (args) => {
  try {
    const raw = execFileSync('npm', ['view', ...args, '--json'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(raw.trim())
  } catch {
    return undefined
  }
}

/** What the registry currently serves for one package version. */
const readRegistryState = (name, version, tag) => {
  const manifest = npmViewJson([`${name}@${version}`])
  const distTags = npmViewJson([name, 'dist-tags'])
  const integrity = manifest?.dist?.integrity
  return {
    version: typeof manifest?.version === 'string' ? manifest.version : undefined,
    integrity: typeof integrity === 'string' ? integrity : undefined,
    distTag: typeof distTags?.[tag] === 'string' ? distTags[tag] : undefined,
  }
}

/** npm's `dist.integrity` format: base64 SHA-512 of the tarball, algorithm-prefixed. */
const tarballIntegrity = (tarballPath) =>
  `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`

/**
 * Compare what the registry serves against what was published.
 *
 * `pending` and `mismatch` need opposite handling: propagation is eventually
 * consistent and worth retrying, whereas a tarball digest that disagrees with what
 * we packed can never become correct, because a published npm version is immutable.
 *
 * Mirrors `registryVerification` in `@overeng/npm-release`; this copy exists until
 * contrib can consume that package (see effect-utils DELTA-001).
 */
const registryVerification = ({ name, version, tag, localIntegrity, remote }) => {
  if (remote.version === undefined) {
    return { status: 'pending', reason: `${name}@${version} is not visible on the registry yet` }
  }
  if (remote.version !== version) {
    return { status: 'mismatch', reason: `${name}: registry serves version ${remote.version}, expected ${version}` }
  }
  if (localIntegrity !== undefined && remote.integrity !== undefined && remote.integrity !== localIntegrity) {
    return {
      status: 'mismatch',
      reason: `${name}@${version}: registry tarball digest ${remote.integrity} does not match the locally packed ${localIntegrity}`,
    }
  }
  if (remote.distTag === undefined) {
    return {
      status: 'pending',
      reason: `${name}: dist-tag "${tag}" is absent, so ${version} published but nothing resolves to it`,
    }
  }
  if (remote.distTag !== version) {
    return {
      status: 'pending',
      reason: `${name}: dist-tag "${tag}" points at ${remote.distTag}, expected ${version}`,
    }
  }
  return { status: 'ok' }
}

/**
 * Wait for the registry to agree that the release is live.
 *
 * `localIntegrity` is only supplied for packages this run actually published — a
 * repack of an already-published package need not be byte-identical, so comparing
 * its digest would report a mismatch that isn't one.
 */
const verifyPublished = ({ name, version, tag, localIntegrity }) => {
  const attempts = 24
  const delayMs = 5_000
  let lastReason

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = registryVerification({
      name,
      version,
      tag,
      localIntegrity,
      remote: readRegistryState(name, version, tag),
    })

    if (result.status === 'ok') return
    if (result.status === 'mismatch') throw new Error(result.reason)

    lastReason = result.reason
    if (attempt !== attempts) {
      console.log(`${result.reason}; retrying in ${delayMs / 1_000}s`)
      sleep(delayMs)
    }
  }

  throw new Error(`${lastReason} — registry did not converge within the verification window`)
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

const buildPackages = () => {
  for (const pkg of plan.packages) {
    const packageDir = dirname(join(rootDir, pkg.path))
    run('pnpm', ['--dir', packageDir, 'exec', 'tsc', '--build', 'tsconfig.json', '--noCheck'])
  }
}

const originalManifestContents = new Map(
  plan.packages.map((pkg) => [pkg.path, readFileSync(join(rootDir, pkg.path), 'utf8')]),
)

const applyManifestRewrites = () => {
  for (const pkg of plan.packages) {
    writeJson(pkg.path, pkg.manifest)
  }
}

const restoreManifestRewrites = () => {
  for (const [path, content] of originalManifestContents) {
    writeFileSync(join(rootDir, path), content)
  }
}

const restoreGeneratedFiles = () => {
  const env = { ...process.env, DT_PASSTHROUGH: '1' }
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
  console.log(`- ${pkg.name}: ${pkg.rewrites.length} rewrites (${packagePath})`)
}

if (dryRun === true || publish === true) {
  verifyRequiredCorePackages()

  const packed = []
  try {
    applyManifestRewrites()
    buildPackages()

    for (const pkg of plan.packages) {
      const { packDir, tarballPath } = packPackage(pkg)
      packed.push({ pkg, packDir, tarballPath })
    }

    smokeInstallPackedTarballs(packed)

    /** Digest of each tarball this run uploaded, so verification can prove the registry serves it. */
    const publishedIntegrity = new Map()

    for (const { pkg, tarballPath } of packed) {
      const existing = npmViewExists(pkg.name, pkg.version)
      if (existing === true && publish === true) {
        console.log(`${pkg.name}@${pkg.version} already published, skipping`)
        continue
      }

      const publishArgs = ['publish', tarballPath, `--tag=${SNAPSHOT_TAG}`, '--access=public', '--ignore-scripts']
      if (dryRun === true) {
        publishArgs.push('--dry-run')
      } else if (process.env.GITHUB_ACTIONS === 'true') {
        // SLSA provenance from the job's OIDC identity, matching how core publishes.
        publishArgs.push('--provenance')
      }
      run('npm', publishArgs)
      if (publish === true) publishedIntegrity.set(pkg.name, tarballIntegrity(tarballPath))
      console.log(`${dryRun === true ? 'Dry-ran' : 'Published'} ${pkg.name}@${pkg.version}`)
    }

    if (publish === true) {
      for (const pkg of plan.packages) {
        verifyPublished({
          name: pkg.name,
          version: pkg.version,
          tag: SNAPSHOT_TAG,
          localIntegrity: publishedIntegrity.get(pkg.name),
        })
        console.log(`Verified ${pkg.name}@${pkg.version} (dist-tag ${SNAPSHOT_TAG} -> ${pkg.version})`)
      }
    }
  } finally {
    restoreManifestRewrites()
    restoreGeneratedFiles()
    for (const { packDir } of packed) {
      rmSync(packDir, { recursive: true, force: true })
    }
  }
}

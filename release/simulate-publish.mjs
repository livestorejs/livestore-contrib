#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import { cleanupPackedRun } from './simulate-publish-cleanup.mjs'

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
const coreSha = readArg('--core-sha')
const releaseVersion = explicitVersion ?? (gitSha === undefined ? undefined : `0.0.0-snapshot-${gitSha}`)
const publish = hasArg('--publish')
const dryRun = hasArg('--dry-run')
const packOnly = hasArg('--pack-only')
const outDir = readArg('--out-dir')
const manifestOut = readArg('--manifest-out')
const npmTag = readArg('--tag') ?? 'snapshot'
const verifyCore = hasArg('--verify-core')

const exclusiveModes = [publish, dryRun, packOnly].filter((mode) => mode === true)
if (exclusiveModes.length > 1) {
  console.error('--publish, --dry-run and --pack-only are mutually exclusive')
  process.exit(1)
}
if (packOnly === true && (outDir === undefined || outDir.length === 0)) {
  console.error('--pack-only requires --out-dir')
  process.exit(1)
}
if (hasArg('--manifest-out') && (manifestOut === undefined || manifestOut.length === 0)) {
  console.error('--manifest-out requires a path')
  process.exit(1)
}
if (manifestOut !== undefined && publish === false) {
  console.error('--manifest-out requires --publish')
  process.exit(1)
}
if (explicitCoreVersion !== undefined && coreSha !== undefined) {
  console.error('--core-version and --core-sha are mutually exclusive')
  process.exit(1)
}
if (coreSha !== undefined && /^[0-9a-f]{40}$/.test(coreSha) === false) {
  console.error(`--core-sha must be a full 40-character commit SHA, got ${coreSha}`)
  process.exit(1)
}

/**
 * Resolve the published core snapshot version for a pinned core commit.
 *
 * The core release version is not derivable from the SHA alone: a core commit on `main` publishes as
 * `0.0.0-snapshot-<sha>`, while a core *pull request* head publishes as `0.0.0-snapshot-pr.<n>.<sha>`.
 * Both end in the SHA, so the registry is the authority. Requiring exactly one match keeps this
 * deterministic instead of guessing a prefix.
 */
const resolveCoreVersionForSha = (sha) => {
  const raw = execFileSync(
    'npm',
    ['view', '@livestore/common', 'versions', '--json', '--registry=https://registry.npmjs.org'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  const matches = JSON.parse(raw).filter((version) => version.endsWith(sha) === true)
  if (matches.length !== 1) {
    console.error(`Expected exactly one published @livestore/common version ending in ${sha}, found ${matches.length}`)
    process.exit(1)
  }
  return matches[0]
}

const errors = []
const addError = (message) => errors.push(message)

const coreVersion = readJson('repos/livestore/release/version.json').version
if (typeof coreVersion !== 'string' || coreVersion.length === 0) {
  addError('repos/livestore/release/version.json must contain a non-empty version string')
}
const coreReleaseVersion =
  explicitCoreVersion ?? (coreSha === undefined ? coreVersion : resolveCoreVersionForSha(coreSha))

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
const releaseTopology = readJson('release/topology.json')
const topologyPackageNames = releaseTopology.publishablePackageNames
const discoveredPackageNames = publishablePackages.map(({ manifest }) => manifest.name).toSorted()
if (
  Array.isArray(topologyPackageNames) === false ||
  JSON.stringify([...topologyPackageNames].toSorted()) !== JSON.stringify(discoveredPackageNames)
) {
  addError('publishable package cohort must exactly match release/topology.json')
}
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
      if (npmTag === 'dev' && dependencyName === '@livestore/devtools-vite' && spec !== coreReleaseVersion) {
        addError(
          `${manifest.name} ${section}.@livestore/devtools-vite must equal core release version ${coreReleaseVersion}`,
        )
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

/**
 * Runs a child process, inheriting stdio so long builds stream live.
 *
 * `captureOnFailure` swaps stdout/stderr to pipes and re-emits them next to the thrown error.
 * Use it where the child's diagnostics are the whole story and would otherwise be separated
 * from the failure: devenv's task runner re-emits a failed task's output non-chronologically,
 * so the Node crash trace can land hundreds of lines *before* the cause that produced it, and
 * `execFileSync` with `stdio: 'inherit'` always reports `stdout: null, stderr: null` on the
 * error object regardless of what the child printed. Together those read as "no output at all".
 *
 * Keep it opt-in: `tsc --build`, `pnpm pack` and `npm publish` want live streaming, both for
 * long-build progress and for the CI retry wrapper's heartbeat.
 */
const run = (command, args, options = {}) => {
  const { captureOnFailure = false, ...execOptions } = options
  const base = { cwd: rootDir, env: { ...process.env, DEVENV_TASK_PASSTHROUGH: '1' } }

  if (captureOnFailure === false) {
    return execFileSync(command, args, { ...base, stdio: 'inherit', ...execOptions })
  }

  try {
    return execFileSync(command, args, { ...base, stdio: ['inherit', 'pipe', 'pipe'], ...execOptions })
  } catch (error) {
    const label = [command, ...args].join(' ')
    process.stderr.write(`\n--- ${label} failed; captured output follows ---\n`)
    if (error.stdout !== null && error.stdout !== undefined) process.stderr.write(`${error.stdout}`)
    if (error.stderr !== null && error.stderr !== undefined) process.stderr.write(`${error.stderr}`)
    process.stderr.write(`--- end captured output ---\n`)
    throw error
  }
}

const npmViewExists = (name, version) => {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry=https://registry.npmjs.org'], {
      cwd: rootDir,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

const npmViewJson = (spec, field) => {
  const commandArgs = ['view', spec]
  if (field !== undefined) commandArgs.push(field)
  commandArgs.push('--json', '--registry=https://registry.npmjs.org')
  return JSON.parse(
    execFileSync('npm', commandArgs, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )
}

const digestFile = (path, algorithm) => createHash(algorithm).update(readFileSync(path)).digest('base64')

const tarballDigests = (path) => ({
  integrity: `sha512-${digestFile(path, 'sha512')}`,
  shasum: createHash('sha1').update(readFileSync(path)).digest('hex'),
})

const registryMetadata = (name, version) => npmViewJson(`${name}@${version}`)

const registryTagVersion = (name, tag) => npmViewJson(name, 'dist-tags')?.[tag]

const assertRegistryArtifact = ({ pkg, digests }) => {
  const metadata = registryMetadata(pkg.name, pkg.version)
  if (metadata?.dist?.shasum !== digests.shasum || metadata?.dist?.integrity !== digests.integrity) {
    throw new Error(`${pkg.name}@${pkg.version} exists with registry bytes that differ from the packed candidate`)
  }
  return metadata
}

const dependencyChecksForPackage = ({ pkg, metadata }) => {
  const expectedDependencies = pkg.rewrites.map(({ section, dependencyName, to }) => ({
    section,
    name: dependencyName,
    expected: to,
  }))
  if (npmTag === 'dev') {
    for (const section of dependencySections) {
      const expected = pkg.manifest?.[section]?.['@livestore/devtools-vite']
      if (expected !== undefined) expectedDependencies.push({ section, name: '@livestore/devtools-vite', expected })
    }
  }
  return expectedDependencies.map(({ section, name, expected }) => {
    const actual = metadata?.[section]?.[name]
    return { section, name, expected, actual, verified: actual === expected }
  })
}

const verifyPublishedDependencies = ({ pkg, metadata }) => {
  for (const check of dependencyChecksForPackage({ pkg, metadata })) {
    if (check.verified === false) {
      throw new Error(
        `${pkg.name}@${pkg.version} ${check.section}.${check.name} is ${check.actual ?? 'missing'}, expected ${check.expected} on npm`,
      )
    }
  }
}

const verifyTag = (pkg) => {
  if (registryTagVersion(pkg.name, npmTag) !== pkg.version) {
    throw new Error(
      `${pkg.name} dist-tag ${npmTag} does not point to ${pkg.version}; this trusted-publishing lane cannot safely repair tags out of band`,
    )
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
  const packagesToVerify = new Set(requiredCorePackages)
  if (npmTag === 'dev') packagesToVerify.add('@livestore/devtools-vite')
  for (const packageName of [...packagesToVerify].sort()) {
    if (npmViewExists(packageName, plan.coreVersion) === false) {
      throw new Error(`Required core package is not visible on npm: ${packageName}@${plan.coreVersion}`)
    }
    if (npmTag === 'dev' && registryTagVersion(packageName, 'dev') !== plan.coreVersion) {
      throw new Error(`${packageName} dist-tag dev must point to ${plan.coreVersion} before contrib publishing`)
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
    run('pnpm', ['install', '--ignore-scripts'], { cwd: smokeDir, captureOnFailure: true })

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

if (dryRun === true || publish === true || packOnly === true) {
  verifyRequiredCorePackages()

  const packed = []
  try {
    applyManifestRewrites()
    buildPackages()

    for (const pkg of plan.packages) {
      const { packDir, tarballPath } = packPackage(pkg)
      packed.push({ pkg, packDir, tarballPath, digests: tarballDigests(tarballPath) })
    }

    smokeInstallPackedTarballs(packed)

    // `--pack-only` is the untrusted producer half of PR snapshot publishing: it emits the exact
    // tarballs a later trusted job will validate and publish, and must never touch the registry.
    if (packOnly === true) {
      const absoluteOutDir = isAbsolute(outDir) ? outDir : join(rootDir, outDir)
      mkdirSync(absoluteOutDir, { recursive: true })
      for (const { pkg, tarballPath } of packed) {
        const destination = join(absoluteOutDir, basename(tarballPath))
        copyFileSync(tarballPath, destination)
        console.log(`Packed ${pkg.name}@${pkg.version} -> ${basename(tarballPath)}`)
      }
    }

    if (packOnly === false) {
      for (const { pkg, tarballPath, digests } of packed) {
        const existing = npmViewExists(pkg.name, pkg.version)
        if (existing === true && publish === true) {
          assertRegistryArtifact({ pkg, digests })
          verifyTag(pkg)
          console.log(`${pkg.name}@${pkg.version} already matches the packed candidate; skipping publish`)
          continue
        }

        const publishArgs = ['publish', tarballPath, `--tag=${npmTag}`, '--access=public', '--ignore-scripts']
        if (publish === true) publishArgs.push('--provenance')
        if (dryRun === true) publishArgs.push('--dry-run')
        run('npm', publishArgs)
        console.log(`${dryRun === true ? 'Dry-ran' : 'Published'} ${pkg.name}@${pkg.version}`)
      }
    }

    if (publish === true) {
      const verifiedRegistryMetadata = new Map()
      for (const { pkg, digests } of packed) {
        waitForNpmView(pkg.name, pkg.version)
        const metadata = assertRegistryArtifact({ pkg, digests })
        verifyTag(pkg)
        verifyPublishedDependencies({ pkg, metadata })
        verifiedRegistryMetadata.set(pkg.name, metadata)
      }

      if (manifestOut !== undefined) {
        const absoluteManifestOut = isAbsolute(manifestOut) ? manifestOut : join(rootDir, manifestOut)
        mkdirSync(dirname(absoluteManifestOut), { recursive: true })
        writeFileSync(
          absoluteManifestOut,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
              npmTag,
              version: releaseVersion,
              coreVersion: plan.coreVersion,
              packageCount: plan.packageCount,
              cohort: plan.packages.map((pkg) => pkg.name),
              packages: packed.map(({ pkg, digests }) => ({
                name: pkg.name,
                version: pkg.version,
                shasum: digests.shasum,
                integrity: digests.integrity,
                dependencyChecks: dependencyChecksForPackage({
                  pkg,
                  metadata: verifiedRegistryMetadata.get(pkg.name),
                }),
              })),
            },
            null,
            2,
          )}\n`,
        )
      }
    }
  } finally {
    cleanupPackedRun({
      publish,
      restoreManifests: restoreManifestRewrites,
      restoreGeneratedProjection: restoreGeneratedFiles,
    })
    for (const { packDir } of packed) {
      rmSync(packDir, { recursive: true, force: true })
    }
  }
}

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

const cloneJson = (value) => JSON.parse(JSON.stringify(value))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const runGit = (repoDir, args) =>
  execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const assertRelativePath = (label, path) => {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    isAbsolute(path) === true ||
    path.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
}

const assertInside = (parent, child, label) => {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolve(child)
  if (resolvedChild !== resolvedParent && resolvedChild.startsWith(`${resolvedParent}${sep}`) === false) {
    throw new Error(`${label} escapes ${parent}`)
  }
}

const githubSourceUrl = (remote) => {
  const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
  if (sshMatch !== null) return `https://github.com/${sshMatch[1]}`
  return remote.replace(/^git\+/, '').replace(/\.git$/, '')
}

const effectPeerMajors = (range) =>
  new Set([...String(range ?? '').matchAll(/(\d+)\.\d+\.\d+/g)].map((match) => Number(match[1])))

const assertEffectPeersOverlap = ({ dependency, sourceRange, targetRange }) => {
  const sourceMajors = effectPeerMajors(sourceRange)
  const targetMajors = effectPeerMajors(targetRange)
  if (
    sourceMajors.size === 0 ||
    targetMajors.size === 0 ||
    [...sourceMajors].some((major) => targetMajors.has(major)) === false
  ) {
    throw new Error(
      `${dependency} Effect peer conflict: source declares ${JSON.stringify(sourceRange)}, target declares ${JSON.stringify(targetRange)}`,
    )
  }
}

const countFiles = (path) => {
  const stat = lstatSync(path)
  if (stat.isDirectory() === false) return 1
  return readdirSync(path).reduce((count, entry) => count + countFiles(join(path, entry)), 0)
}

const planOneVendor = ({ rootDir, targetPackageDir, manifest, spec }) => {
  for (const key of ['dependency', 'sourceRepo', 'sourcePackage', 'target', 'import', 'entry']) {
    if (typeof spec[key] !== 'string' || spec[key].length === 0) {
      throw new Error(`${manifest.name} $genie.releaseVendors.${key} must be a non-empty string`)
    }
  }
  if (Array.isArray(spec.files) === false || spec.files.length === 0) {
    throw new Error(`${manifest.name} $genie.releaseVendors.files must be a non-empty string array`)
  }

  assertRelativePath('release vendor sourceRepo', spec.sourceRepo)
  assertRelativePath('release vendor sourcePackage', spec.sourcePackage)
  assertRelativePath('release vendor target', spec.target)
  assertRelativePath('release vendor entry', spec.entry)
  for (const path of spec.files) assertRelativePath('release vendor file', path)

  if (spec.import.startsWith('#vendor/') === false) {
    throw new Error(`${manifest.name} release vendor import must use the #vendor/ namespace`)
  }

  const sourceRepoDir = join(rootDir, spec.sourceRepo)
  const sourcePackageDir = join(sourceRepoDir, spec.sourcePackage)
  const targetDir = join(targetPackageDir, spec.target)
  assertInside(rootDir, sourceRepoDir, 'release vendor source repo')
  assertInside(sourceRepoDir, sourcePackageDir, 'release vendor source package')
  assertInside(targetPackageDir, targetDir, 'release vendor target')

  const dirty = runGit(sourceRepoDir, ['status', '--short', '--untracked-files=all'])
  if (dirty.length > 0) {
    throw new Error(`${spec.dependency} source member is dirty:\n${dirty}`)
  }

  const sourceManifestPath = join(sourcePackageDir, 'package.json')
  if (existsSync(sourceManifestPath) === false) {
    throw new Error(`${spec.dependency} source package is missing package.json`)
  }
  const sourceManifest = readJson(sourceManifestPath)
  if (sourceManifest.name !== spec.dependency) {
    throw new Error(`${spec.dependency} source package declares ${JSON.stringify(sourceManifest.name)}`)
  }
  if (sourceManifest.license !== 'MIT') {
    throw new Error(`${spec.dependency} must declare the MIT licence before vendoring`)
  }

  for (const requiredPath of ['LICENSE', 'UPSTREAM.md']) {
    if (existsSync(join(sourcePackageDir, requiredPath)) === false) {
      throw new Error(`${spec.dependency} required attribution file is missing: ${requiredPath}`)
    }
    if (spec.files.includes(requiredPath) === false) {
      throw new Error(`${spec.dependency} release vendor files must include ${requiredPath}`)
    }
  }

  const license = readFileSync(join(sourcePackageDir, 'LICENSE'), 'utf8')
  if (license.includes('Copyright (c) 2017 Xiaoyi Chen') === false) {
    throw new Error(`${spec.dependency} LICENSE is missing the upstream Xiaoyi Chen notice`)
  }
  if (license.includes('Johannes Schickling') === false) {
    throw new Error(`${spec.dependency} LICENSE is missing the fork copyright`)
  }
  const upstream = readFileSync(join(sourcePackageDir, 'UPSTREAM.md'), 'utf8')
  if (upstream.includes('storybookjs/react-inspector') === false) {
    throw new Error(`${spec.dependency} UPSTREAM.md is missing the storybookjs/react-inspector provenance`)
  }

  assertEffectPeersOverlap({
    dependency: spec.dependency,
    sourceRange: sourceManifest.peerDependencies?.effect,
    targetRange: manifest.peerDependencies?.effect,
  })

  if (manifest.imports?.[spec.import] !== spec.dependency) {
    throw new Error(
      `${manifest.name} imports.${spec.import} must resolve to ${spec.dependency} before release vendoring`,
    )
  }
  if (typeof manifest.dependencies?.[spec.dependency] !== 'string') {
    throw new Error(`${manifest.name} must depend on ${spec.dependency} before release vendoring`)
  }
  if (existsSync(targetDir) === true) {
    throw new Error(`${manifest.name} release vendor target already exists: ${relative(rootDir, targetDir)}`)
  }

  const copyEntries = spec.files.map((path) => {
    const source = join(sourcePackageDir, path)
    if (existsSync(source) === false) {
      throw new Error(`${spec.dependency} release vendor file is missing: ${path}`)
    }
    return {
      source,
      target: join(targetDir, path),
      fileCount: countFiles(source),
    }
  })

  const commit = runGit(sourceRepoDir, ['rev-parse', 'HEAD'])
  const source = githubSourceUrl(runGit(sourceRepoDir, ['remote', 'get-url', 'origin']))

  return {
    dependency: spec.dependency,
    target: spec.target,
    targetDir,
    copyEntries,
    fileCount: copyEntries.reduce((count, entry) => count + entry.fileCount, 0),
    provenance: {
      source,
      commit,
      packagePath: spec.sourcePackage,
      version: sourceManifest.version,
      license: sourceManifest.license,
    },
    manifestPatch: {
      importSpecifier: spec.import,
      importTarget: `./${posix.join(spec.target, spec.entry.replace(/^\.\//, ''))}`,
      dependencies: sourceManifest.dependencies ?? {},
    },
  }
}

export const planVendorPackage = ({ rootDir, targetPackageDir, manifest }) => {
  const specs = manifest.$genie?.releaseVendors
  if (specs === undefined) return { manifest: cloneJson(manifest), vendors: [] }
  if (Array.isArray(specs) === false || specs.length === 0) {
    throw new Error(`${manifest.name} $genie.releaseVendors must be a non-empty array`)
  }

  const simulatedManifest = cloneJson(manifest)
  const vendors = specs.map((spec) =>
    planOneVendor({
      rootDir,
      targetPackageDir,
      manifest: simulatedManifest,
      spec,
    }),
  )

  for (const vendor of vendors) {
    delete simulatedManifest.dependencies[vendor.dependency]
    simulatedManifest.imports[vendor.manifestPatch.importSpecifier] = vendor.manifestPatch.importTarget

    for (const [dependency, version] of Object.entries(vendor.manifestPatch.dependencies)) {
      const existing = simulatedManifest.dependencies[dependency]
      if (existing !== undefined && existing !== version) {
        throw new Error(
          `${manifest.name} dependency conflict while vendoring ${vendor.dependency}: ${dependency} is ${existing}, vendor requires ${version}`,
        )
      }
      simulatedManifest.dependencies[dependency] = version
    }

    simulatedManifest.$vendored = {
      ...(simulatedManifest.$vendored ?? {}),
      [vendor.dependency]: vendor.provenance,
    }
  }

  delete simulatedManifest.$genie.releaseVendors
  return { manifest: simulatedManifest, vendors }
}

export const applyVendorPlan = (plan) => {
  const createdTargets = []
  try {
    for (const vendor of plan.vendors) {
      if (existsSync(vendor.targetDir) === true) {
        throw new Error(`release vendor target already exists: ${vendor.targetDir}`)
      }
      createdTargets.push(vendor.targetDir)
      for (const entry of vendor.copyEntries) {
        cpSync(entry.source, entry.target, {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
      }
    }
  } catch (error) {
    for (const target of createdTargets.reverse()) rmSync(target, { recursive: true, force: true })
    throw error
  }
}

export const cleanupVendorPlan = (plan) => {
  for (const vendor of [...plan.vendors].reverse()) {
    rmSync(vendor.targetDir, { recursive: true, force: true })
  }
}

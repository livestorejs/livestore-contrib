import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectionBackupName = '.livestore-scenario-backup'
const projectionLockName = '.livestore-scenario-lock'
const refWorktreePrefix = '.livestore-scenario-ref-'
const incompleteLockGraceMs = 30_000

export type CoreSelection =
  | { readonly _tag: 'current' }
  | { readonly _tag: 'path'; readonly path: string }
  | { readonly _tag: 'ref'; readonly ref: string }

export interface ParsedCoreSelection {
  readonly selection: CoreSelection
  readonly scenarioArgs: ReadonlyArray<string>
}

export interface ResolvedCoreSource {
  readonly path: string
  readonly label: string
  readonly sourceRevision: string
}

export const parseCoreSelection = (args: ReadonlyArray<string>): ParsedCoreSelection => {
  let selection: CoreSelection = { _tag: 'current' }
  const scenarioArgs: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg !== '--core-path' && arg !== '--core-ref') {
      scenarioArgs.push(arg)
      continue
    }

    if (selection._tag !== 'current') throw new Error('Use only one of --core-path or --core-ref')
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--') === true) throw new Error(`Missing value for ${arg}`)
    selection = arg === '--core-path' ? { _tag: 'path', path: value } : { _tag: 'ref', ref: value }
    index += 1
  }

  return { selection, scenarioArgs }
}

export const withCoreSource = async <T>(args: {
  readonly selection: CoreSelection
  readonly workspaceRoot: string
  readonly run: (core: ResolvedCoreSource) => Promise<T>
}): Promise<T> => {
  const currentCorePath = path.join(args.workspaceRoot, 'repos', 'livestore')
  return withProjectionLock(currentCorePath, async () => {
    const core = await resolveCoreSource({ selection: args.selection, workspaceRoot: args.workspaceRoot })
    return projectCore({ currentCorePath, selectedCorePath: core.path, run: () => args.run(core) })
  })
}

const resolveCoreSource = async (args: {
  readonly selection: CoreSelection
  readonly workspaceRoot: string
}): Promise<ResolvedCoreSource> => {
  const currentCorePath = path.join(args.workspaceRoot, 'repos', 'livestore')
  switch (args.selection._tag) {
    case 'current':
      return describeCoreSource({ corePath: currentCorePath, label: 'current materialization' })
    case 'path': {
      const selectedPath = path.resolve(args.workspaceRoot, args.selection.path)
      await assertCoreShape(selectedPath)
      await assertCoreDependenciesInstalled({ workspaceRoot: args.workspaceRoot, corePath: selectedPath })
      return describeCoreSource({ corePath: selectedPath, label: `local path ${selectedPath}` })
    }
    case 'ref': {
      const selectedPath = await prepareRefWorktree({
        workspaceRoot: args.workspaceRoot,
        currentCorePath,
        ref: args.selection.ref,
      })
      return describeCoreSource({ corePath: selectedPath, label: `Git ref ${args.selection.ref}` })
    }
  }
}

export const withCoreProjection = async <T>(args: {
  readonly currentCorePath: string
  readonly selectedCorePath: string
  readonly run: () => Promise<T>
}): Promise<T> => {
  return withProjectionLock(args.currentCorePath, () => projectCore(args))
}

const withProjectionLock = async <T>(currentCorePath: string, run: () => Promise<T>): Promise<T> => {
  const reposPath = path.dirname(currentCorePath)
  const backupPath = path.join(reposPath, projectionBackupName)
  const lockPath = path.join(reposPath, projectionLockName)
  await acquireProjectionLock({ currentCorePath, backupPath, lockPath })

  try {
    return await run()
  } finally {
    await restoreProjection({ currentCorePath, backupPath })
    await fs.rm(lockPath, { recursive: true, force: true })
  }
}

const projectCore = async <T>(args: {
  readonly currentCorePath: string
  readonly selectedCorePath: string
  readonly run: () => Promise<T>
}): Promise<T> => {
  const reposPath = path.dirname(args.currentCorePath)
  const backupPath = path.join(reposPath, projectionBackupName)
  const currentRealPath = await fs.realpath(args.currentCorePath)
  const selectedRealPath = await fs.realpath(args.selectedCorePath)
  if (currentRealPath === selectedRealPath) return args.run()

  const relativeTarget = path.relative(currentRealPath, selectedRealPath)
  if (
    relativeTarget === '' ||
    (relativeTarget.startsWith('..') === false && path.isAbsolute(relativeTarget) === false)
  ) {
    throw new Error('The selected LiveStore path cannot be inside the current repos/livestore materialization')
  }

  await fs.rename(args.currentCorePath, backupPath)
  await fs.symlink(selectedRealPath, args.currentCorePath, 'dir')
  return args.run()
}

const prepareRefWorktree = async (args: {
  readonly workspaceRoot: string
  readonly currentCorePath: string
  readonly ref: string
}): Promise<string> => {
  const commit = await resolveRef(args.currentCorePath, args.ref)
  const targetPath = path.join(args.workspaceRoot, 'repos', `${refWorktreePrefix}${commit.slice(0, 16)}`)
  const existingHead = await gitOptional(targetPath, ['rev-parse', 'HEAD'])

  if (existingHead === undefined) {
    await fs.rm(targetPath, { recursive: true, force: true })
    await git(args.currentCorePath, ['worktree', 'add', '--detach', targetPath, commit])
  } else if (existingHead !== commit) {
    throw new Error(`Managed LiveStore ref worktree has unexpected HEAD: ${targetPath}`)
  }

  await assertCoreShape(targetPath)
  await assertRuntimeDependencyCompatibility({
    workspaceRoot: args.workspaceRoot,
    currentCorePath: args.currentCorePath,
    selectedCorePath: targetPath,
  })
  await projectInstalledDependencies({
    workspaceRoot: args.workspaceRoot,
    currentCorePath: args.currentCorePath,
    selectedCorePath: targetPath,
  })
  return targetPath
}

const resolveRef = async (corePath: string, ref: string): Promise<string> => {
  for (const candidate of [ref, `refs/remotes/origin/${ref}`, `origin/${ref}`]) {
    const commit = await gitOptional(corePath, ['rev-parse', '--verify', `${candidate}^{commit}`])
    if (commit !== undefined) return commit
  }

  try {
    await git(corePath, ['fetch', 'origin', ref])
  } catch (cause) {
    throw new Error(`Could not resolve or fetch LiveStore ref '${ref}'`, { cause })
  }
  const fetched = await gitOptional(corePath, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
  if (fetched === undefined) throw new Error(`LiveStore ref '${ref}' did not resolve to a commit`)
  return fetched
}

const describeCoreSource = async (args: {
  readonly corePath: string
  readonly label: string
}): Promise<ResolvedCoreSource> => {
  await assertCoreShape(args.corePath)
  const commit = await gitOptional(args.corePath, ['rev-parse', 'HEAD'])
  if (commit === undefined) throw new Error(`LiveStore source is not a Git worktree: ${args.corePath}`)
  const status = await gitRaw(args.corePath, ['status', '--porcelain=v1', '--untracked-files=all'])
  const dirtySuffix = status.length === 0 ? '' : `+dirty.${await workingTreeHash(args.corePath)}`
  const sourceRevision = `livestore@${commit}${dirtySuffix}`
  return { path: await fs.realpath(args.corePath), label: args.label, sourceRevision }
}

const workingTreeHash = async (corePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  hash.update(await gitRaw(corePath, ['diff', '--binary', 'HEAD', '--']))
  const untracked = (await gitRaw(corePath, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((file) => file.length > 0)
    .toSorted()
  for (const file of untracked) {
    hash.update(`\0${file}\0`)
    const filePath = path.join(corePath, file)
    const stat = await fs.lstat(filePath)
    hash.update(stat.isSymbolicLink() === true ? await fs.readlink(filePath) : await fs.readFile(filePath))
  }
  return hash.digest('hex').slice(0, 16)
}

const assertCoreShape = async (corePath: string): Promise<void> => {
  const requiredPaths = [
    'package.json',
    'packages/@livestore/adapter-web/package.json',
    'packages/@livestore/common/package.json',
    'packages/@livestore/livestore/package.json',
    'packages/@livestore/sync-cf/package.json',
    'packages/@livestore/utils/package.json',
    'packages/@livestore/utils-dev/package.json',
  ]
  const missing: string[] = []
  for (const requiredPath of requiredPaths) {
    if ((await pathExists(path.join(corePath, requiredPath))) === false) missing.push(requiredPath)
  }
  if (missing.length > 0) throw new Error(`Invalid LiveStore source ${corePath}; missing ${missing.join(', ')}`)
}

const assertCoreDependenciesInstalled = async (args: {
  readonly workspaceRoot: string
  readonly corePath: string
}): Promise<void> => {
  const closure = await readCoreClosure(args.workspaceRoot)
  const missing: string[] = []
  for (const packagePath of closure) {
    if ((await pathExists(path.join(args.corePath, packagePath, 'node_modules'))) === false) missing.push(packagePath)
  }
  if (missing.length > 0) {
    throw new Error(
      `The selected LiveStore worktree is not installed (${missing.join(', ')}). Run its pinned pnpm install/devenv setup, then retry --core-path.`,
    )
  }
}

const assertRuntimeDependencyCompatibility = async (args: {
  readonly workspaceRoot: string
  readonly currentCorePath: string
  readonly selectedCorePath: string
}): Promise<void> => {
  const closure = await readCoreClosure(args.workspaceRoot)
  const incompatible: string[] = []
  for (const packagePath of closure) {
    const current = runtimeDependencies(await readJson(path.join(args.currentCorePath, packagePath, 'package.json')))
    const selected = runtimeDependencies(await readJson(path.join(args.selectedCorePath, packagePath, 'package.json')))
    if (canonicalJson(current) !== canonicalJson(selected)) incompatible.push(packagePath)
  }
  if (incompatible.length > 0) {
    throw new Error(
      `LiveStore ref changes the installed runtime dependency surface for ${incompatible.join(', ')}. Materialize and install that ref as a LiveStore worktree, then select it with --core-path.`,
    )
  }
}

const projectInstalledDependencies = async (args: {
  readonly workspaceRoot: string
  readonly currentCorePath: string
  readonly selectedCorePath: string
}): Promise<void> => {
  const closure = await readCoreClosure(args.workspaceRoot)
  for (const packagePath of closure) {
    const source = path.join(args.currentCorePath, packagePath, 'node_modules')
    const target = path.join(args.selectedCorePath, packagePath, 'node_modules')
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true })
  }
}

const readCoreClosure = async (workspaceRoot: string): Promise<ReadonlyArray<string>> => {
  const manifest = await readJson(path.join(workspaceRoot, 'tests', 'scenarios', 'package.json'))
  const genie = manifest.$genie
  const closure = isJsonObject(genie) === true ? genie.workspaceClosureDirs : undefined
  if (Array.isArray(closure) === false) throw new Error('Scenario workspace closure is missing from package.json')
  return closure
    .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('repos/livestore/'))
    .map((entry) => entry.slice('repos/livestore/'.length))
}

const runtimeDependencies = (manifest: Record<string, unknown>): Record<string, unknown> => ({
  dependencies: manifest.dependencies ?? {},
  optionalDependencies: manifest.optionalDependencies ?? {},
  peerDependencies: manifest.peerDependencies ?? {},
  peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
})

const canonicalJson = (input: unknown): string => JSON.stringify(sortJson(input))

const sortJson = (input: unknown): unknown => {
  if (Array.isArray(input) === true) return input.map(sortJson)
  if (isJsonObject(input) === false) return input
  return Object.fromEntries(
    Object.entries(input)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sortJson(value)]),
  )
}

const acquireProjectionLock = async (args: {
  readonly currentCorePath: string
  readonly backupPath: string
  readonly lockPath: string
}): Promise<void> => {
  try {
    await fs.mkdir(args.lockPath)
    if ((await pathExists(args.backupPath)) === true) await restoreProjection(args)
    await writeProjectionOwner(args.lockPath)
    return
  } catch (cause) {
    if (errorCode(cause) !== 'EEXIST') throw cause
  }

  const owner = await readProjectionOwner(args.lockPath)
  if (owner === undefined) {
    const lockStat = await fs.lstat(args.lockPath)
    if (Date.now() - lockStat.mtimeMs < incompleteLockGraceMs) {
      throw new Error('Another Scenario run is acquiring the LiveStore selection lock')
    }
  }
  if (owner !== undefined && processIsAlive(owner.pid) === true) {
    throw new Error(`Another Scenario run is selecting LiveStore (pid ${owner.pid})`)
  }
  await restoreProjection(args)
  await fs.rm(args.lockPath, { recursive: true, force: true })
  await fs.mkdir(args.lockPath)
  await writeProjectionOwner(args.lockPath)
}

const restoreProjection = async (args: { readonly currentCorePath: string; readonly backupPath: string }) => {
  if ((await pathExists(args.backupPath)) === false) return
  const current = await lstatOptional(args.currentCorePath)
  if (current?.isSymbolicLink() === true) await fs.unlink(args.currentCorePath)
  else if (current !== undefined) {
    throw new Error(
      `Cannot restore LiveStore projection because ${args.currentCorePath} is no longer its managed symlink`,
    )
  }
  await fs.rename(args.backupPath, args.currentCorePath)
}

const readProjectionOwner = async (lockPath: string): Promise<{ readonly pid: number } | undefined> => {
  try {
    const input = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { readonly pid?: unknown }
    return typeof input.pid === 'number' && Number.isSafeInteger(input.pid) === true && input.pid > 0
      ? { pid: input.pid }
      : undefined
  } catch {
    return undefined
  }
}

const writeProjectionOwner = (lockPath: string): Promise<void> =>
  fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`, 'utf8')

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return errorCode(cause) === 'EPERM'
  }
}

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const stdout = await gitRaw(cwd, args)
  return stdout.trim()
}

const gitRaw = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

const gitOptional = async (cwd: string, args: ReadonlyArray<string>): Promise<string | undefined> => {
  try {
    return await git(cwd, args)
  } catch {
    return undefined
  }
}

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const input: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (isJsonObject(input) === false) throw new Error(`Expected a JSON object in ${filePath}`)
  return input
}

const isJsonObject = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && Array.isArray(input) === false

const pathExists = async (filePath: string): Promise<boolean> => (await lstatOptional(filePath)) !== undefined

const lstatOptional = async (filePath: string) => {
  try {
    return await fs.lstat(filePath)
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return undefined
    throw cause
  }
}

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { parseCoreSelection, withCoreProjection } from './core-source.ts'

describe('Scenario LiveStore source selection', () => {
  test('removes a local core selector before forwarding Scenario arguments', () => {
    expect(
      parseCoreSelection([
        '--profile',
        'browser',
        '--core-path',
        '../livestore-solution',
        '--scenario',
        'offline-writer-recovery',
      ]),
    ).toEqual({
      selection: { _tag: 'path', path: '../livestore-solution' },
      scenarioArgs: ['--profile', 'browser', '--scenario', 'offline-writer-recovery'],
    })
  })

  test('accepts one Git ref selector', () => {
    expect(parseCoreSelection(['--core-ref', 'solution/rebase', '--profile', 'process'])).toEqual({
      selection: { _tag: 'ref', ref: 'solution/rebase' },
      scenarioArgs: ['--profile', 'process'],
    })
  })

  test('rejects ambiguous selectors', () => {
    expect(() => parseCoreSelection(['--core-ref', 'main', '--core-path', '../livestore'])).toThrow('Use only one')
  })

  test('restores the current materialization after a selected run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-core-source-'))
    const reposPath = path.join(root, 'repos')
    const currentCorePath = path.join(reposPath, 'livestore')
    const selectedCorePath = path.join(root, 'selected-livestore')
    await fs.mkdir(currentCorePath, { recursive: true })
    await fs.mkdir(selectedCorePath)
    await fs.writeFile(path.join(currentCorePath, 'identity'), 'current')
    await fs.writeFile(path.join(selectedCorePath, 'identity'), 'selected')

    try {
      await withCoreProjection({
        currentCorePath,
        selectedCorePath,
        run: async () => {
          expect((await fs.lstat(currentCorePath)).isSymbolicLink()).toBe(true)
          expect(await fs.readFile(path.join(currentCorePath, 'identity'), 'utf8')).toBe('selected')
        },
      })

      expect((await fs.lstat(currentCorePath)).isDirectory()).toBe(true)
      expect(await fs.readFile(path.join(currentCorePath, 'identity'), 'utf8')).toBe('current')
      await expect(fs.access(path.join(reposPath, '.livestore-scenario-lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('restores the current materialization when the run fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-core-source-failure-'))
    const currentCorePath = path.join(root, 'repos', 'livestore')
    const selectedCorePath = path.join(root, 'selected-livestore')
    await fs.mkdir(currentCorePath, { recursive: true })
    await fs.mkdir(selectedCorePath)

    try {
      await expect(
        withCoreProjection({
          currentCorePath,
          selectedCorePath,
          run: () => Promise.reject(new Error('run failed')),
        }),
      ).rejects.toThrow('run failed')
      expect((await fs.lstat(currentCorePath)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a concurrent selector while the first run owns the projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-core-source-concurrency-'))
    const currentCorePath = path.join(root, 'repos', 'livestore')
    const selectedCorePath = path.join(root, 'selected-livestore')
    await fs.mkdir(currentCorePath, { recursive: true })
    await fs.mkdir(selectedCorePath)
    let releaseFirstRun: (() => void) | undefined
    const firstRunEntered = Promise.withResolvers<void>()

    try {
      const firstRun = withCoreProjection({
        currentCorePath,
        selectedCorePath,
        run: () =>
          new Promise<void>((resolve) => {
            releaseFirstRun = resolve
            firstRunEntered.resolve()
          }),
      })
      await firstRunEntered.promise

      await expect(
        withCoreProjection({ currentCorePath, selectedCorePath, run: () => Promise.resolve() }),
      ).rejects.toThrow('Another Scenario run')
      releaseFirstRun?.()
      await firstRun
    } finally {
      releaseFirstRun?.()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('does not reclaim a fresh lock before its owner record is visible', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-core-source-lock-race-'))
    const reposPath = path.join(root, 'repos')
    const currentCorePath = path.join(reposPath, 'livestore')
    const selectedCorePath = path.join(root, 'selected-livestore')
    await fs.mkdir(currentCorePath, { recursive: true })
    await fs.mkdir(selectedCorePath)
    await fs.mkdir(path.join(reposPath, '.livestore-scenario-lock'))

    try {
      await expect(
        withCoreProjection({ currentCorePath, selectedCorePath, run: () => Promise.resolve() }),
      ).rejects.toThrow('is acquiring')
      expect((await fs.lstat(currentCorePath)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('repairs a projection abandoned by a dead launcher', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-core-source-recovery-'))
    const reposPath = path.join(root, 'repos')
    const currentCorePath = path.join(reposPath, 'livestore')
    const backupPath = path.join(reposPath, '.livestore-scenario-backup')
    const abandonedTarget = path.join(root, 'abandoned-target')
    const selectedCorePath = path.join(root, 'next-target')
    const lockPath = path.join(reposPath, '.livestore-scenario-lock')
    await fs.mkdir(reposPath, { recursive: true })
    await fs.mkdir(backupPath)
    await fs.writeFile(path.join(backupPath, 'identity'), 'canonical')
    await fs.mkdir(abandonedTarget)
    await fs.mkdir(selectedCorePath)
    await fs.writeFile(path.join(selectedCorePath, 'identity'), 'next')
    await fs.symlink(abandonedTarget, currentCorePath, 'dir')
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 99_999_999 })}\n`)

    try {
      await withCoreProjection({
        currentCorePath,
        selectedCorePath,
        run: async () => {
          expect(await fs.readFile(path.join(currentCorePath, 'identity'), 'utf8')).toBe('next')
        },
      })
      expect(await fs.readFile(path.join(currentCorePath, 'identity'), 'utf8')).toBe('canonical')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

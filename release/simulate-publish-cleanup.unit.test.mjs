import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanupPackedRun } from './simulate-publish-cleanup.mjs'

test('publish cleanup preserves a future mirrored dev projection', () => {
  const state = {
    generatedVersion: '0.5.0-dev.1',
    lockVersion: '0.5.0-dev.1',
    manifestDependency: 'workspace:^',
  }

  cleanupPackedRun({
    publish: true,
    restoreManifests: () => {
      state.manifestDependency = '0.5.0-dev.1'
    },
    restoreGeneratedProjection: () => {
      state.generatedVersion = '0.5.0-dev.0'
    },
  })

  assert.deepEqual(state, {
    generatedVersion: '0.5.0-dev.1',
    lockVersion: '0.5.0-dev.1',
    manifestDependency: '0.5.0-dev.1',
  })
})

test('non-publishing cleanup retains default projection restoration', () => {
  let generatedVersion = '0.5.0-dev.1'
  let manifestsRestored = false

  cleanupPackedRun({
    publish: false,
    restoreManifests: () => {
      manifestsRestored = true
    },
    restoreGeneratedProjection: () => {
      generatedVersion = '0.5.0-dev.0'
    },
  })

  assert.equal(manifestsRestored, true)
  assert.equal(generatedVersion, '0.5.0-dev.0')
})

import { describe, expect, it } from 'vitest'

import { displaySourceRevision } from './source-revision.ts'

describe('source revision display', () => {
  it('shows a compact commit in lists and the full commit in the open run', () => {
    expect(displaySourceRevision('livestore@0123456789abcdef0123456789abcdef01234567')).toEqual({
      compact: '01234567',
      detail: 'LiveStore source 0123456789abcdef0123456789abcdef01234567',
    })
  })

  it('makes dirty worktree provenance visible without exposing its path', () => {
    expect(displaySourceRevision('livestore@0123456789abcdef0123456789abcdef01234567+dirty.89abcdef01234567')).toEqual({
      compact: '01234567+dirty',
      detail: 'LiveStore source 0123456789abcdef0123456789abcdef01234567 · dirty 89abcdef01234567',
    })
  })

  it('keeps legacy working-tree artifacts readable', () => {
    expect(displaySourceRevision('working-tree')).toEqual({
      compact: 'working tree',
      detail: 'LiveStore source working tree',
    })
  })
})

import { expect, it } from 'vitest'

import { parseBenchmarkOptions } from './benchmark.ts'
it('requires targets and validates counts and profiles', () => {
  expect(() => parseBenchmarkOptions([])).toThrow('baseline')
  for (const args of [
    ['--samples', '0'],
    ['--warmups', '-1'],
    ['--samples', '1.5'],
    ['--profile', 'invalid'],
    ['--oops', '1'],
  ])
    expect(() => parseBenchmarkOptions(['--baseline', 'main', '--candidate', 'topic', ...args])).toThrow()
  expect(
    parseBenchmarkOptions([
      '--baseline',
      'main',
      '--candidate',
      'topic',
      '--scenario',
      'many-writer-convergence',
      '--profile',
      'in-process',
      '--samples',
      '3',
      '--warmups',
      '0',
      '--set',
      'foo=4',
    ]),
  ).toMatchObject({ samples: 3, warmups: 0, profiles: ['in-process'], parameters: ['foo=4'] })
})

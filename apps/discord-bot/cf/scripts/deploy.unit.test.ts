import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const deploy = fileURLToPath(new URL('./deploy.sh', import.meta.url))

const run = (env: Record<string, string>) =>
  spawnSync('bash', [deploy, '--stage', 'staging'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      ALCHEMY_TUI: '',
      ALCHEMY_PLAIN: '',
      ALCHEMY_NO_TUI: '',
      ...env,
    },
  })

describe('cf:deploy approval', () => {
  it('rejects a non-interactive deploy before running preflight or Alchemy', () => {
    const result = run({})
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('cf:deploy requires explicit approval')
    expect(result.stdout).toBe('')
  })

  it('rejects a TUI override when Alchemy is forced into plain mode', () => {
    const result = run({ ALCHEMY_TUI: '1', ALCHEMY_PLAIN: '1' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('cf:deploy requires explicit approval')
  })
})

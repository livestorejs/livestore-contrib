import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Exercise the installed binary, not workspace sources or hoisted workspace dependencies. */
export const smokeCli = (installDir, { bunx = false } = {}) => {
  const packageDir = join(installDir, 'node_modules/@livestore/cli')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  execFileSync('bun', [fileURLToPath(import.meta.url), '--check-cohort', join(packageDir, 'package.json')], {
    stdio: 'inherit',
  })
  // Help loads the complete create command tree without depending on GitHub availability.
  // In particular, it imports NodeChildProcessSpawner, which failed before argument parsing in #112.
  const args = ['create', '--example', 'tutorial-starter', '--help']
  const output = execFileSync(
    bunx === true ? 'bun' : process.execPath,
    bunx === true ? ['x', '--no-install', 'livestore', ...args] : [join(packageDir, manifest.bin.livestore), ...args],
    {
      cwd: installDir,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(installDir, 'bun-cache') },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assert.match(output, /--example/)
  assert.match(output, /create/)

  console.log(`Packed CLI create startup passed via ${bunx === true ? 'bunx' : 'Node'}`)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--check-cohort') {
    assert.ok(process.argv[3], 'Usage: bun release/smoke-cli.mjs --check-cohort <package.json>')
    const { semver } = await import('bun')
    const manifest = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    const effectVersion = manifest.dependencies.effect
    assert.match(effectVersion, /^\d+\.\d+\.\d+$/)
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (name.startsWith('@effect/')) assert.equal(version, effectVersion, `${name} must use the exact Effect cohort`)
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name !== 'effect' && !name.startsWith('@effect/')) continue
      const dependency = manifest.dependencies[name]
      assert.equal(dependency, effectVersion, `${name} peer must be an exact owned runtime dependency`)
      assert.ok(semver.satisfies(dependency, range), `${name}@${dependency} must satisfy its peer range ${range}`)
    }
    console.log(`CLI Effect cohort passed (${effectVersion}): ${process.argv[3]}`)
  } else {
    assert.ok(
      process.argv[2],
      `Usage: node ${dirname(fileURLToPath(import.meta.url))}/smoke-cli.mjs <clean-install-directory>`,
    )
    smokeCli(resolve(process.argv[2]), { bunx: process.argv.includes('--bunx') })
  }
}

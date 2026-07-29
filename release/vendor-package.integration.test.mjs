import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applyVendorPlan, cleanupVendorPlan, planVendorPackage } from './vendor-package.mjs'

const tempDirs = []

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

const makeFixture = ({ effectPeer = '^4.0.0-beta.99', includeLicense = true } = {}) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'livestore-contrib-vendor-test-'))
  tempDirs.push(rootDir)

  const sourceRepoDir = join(rootDir, 'source-repo')
  const sourcePackageDir = join(sourceRepoDir, 'packages/vendor')
  const targetPackageDir = join(rootDir, 'target')
  mkdirSync(join(sourcePackageDir, 'src'), { recursive: true })
  mkdirSync(targetPackageDir, { recursive: true })

  writeJson(join(sourcePackageDir, 'package.json'), {
    name: '@overeng/react-inspector',
    version: '9.0.0',
    license: 'MIT',
    dependencies: { 'is-dom': '1.1.0' },
    peerDependencies: { effect: effectPeer, react: '^19.2.7' },
  })
  writeFileSync(join(sourcePackageDir, 'src/index.tsx'), 'export const Inspector = true\n')
  writeFileSync(join(sourcePackageDir, 'README.md'), '# Inspector\n')
  writeFileSync(
    join(sourcePackageDir, 'UPSTREAM.md'),
    'Upstream: storybookjs/react-inspector\nSee `FORK_CHANGELOG.md` for detailed changes.\n',
  )
  writeFileSync(join(sourcePackageDir, 'FORK_CHANGELOG.md'), '# Fork changes\n')
  if (includeLicense === true) {
    writeFileSync(
      join(sourcePackageDir, 'LICENSE'),
      'Copyright (c) 2017 Xiaoyi Chen\nCopyright (c) 2024-2026 Johannes Schickling\n',
    )
  }

  execFileSync('git', ['init', '--quiet'], { cwd: sourceRepoDir })
  execFileSync('git', ['config', 'user.name', 'schickling-assistant'], { cwd: sourceRepoDir })
  execFileSync('git', ['config', 'user.email', '261620128+schickling-assistant@users.noreply.github.com'], {
    cwd: sourceRepoDir,
  })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/overengineeringstudio/effect-utils.git'], {
    cwd: sourceRepoDir,
  })
  execFileSync('git', ['add', '.'], { cwd: sourceRepoDir })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourceRepoDir })

  const manifest = {
    name: '@livestore/devtools-react',
    dependencies: {
      '@overeng/react-inspector': 'link:../source-repo/packages/vendor',
    },
    peerDependencies: {
      effect: '^4.0.0-beta.99',
      react: '^19.2.3',
    },
    imports: {
      '#vendor/react-inspector': '@overeng/react-inspector',
    },
    $genie: {
      releaseVendors: [
        {
          dependency: '@overeng/react-inspector',
          sourceRepo: 'source-repo',
          sourcePackage: 'packages/vendor',
          target: 'src/vendor/react-inspector',
          import: '#vendor/react-inspector',
          entry: './src/index.tsx',
          files: ['src', 'LICENSE', 'UPSTREAM.md', 'package.json'],
          textReplacements: [
            {
              path: 'UPSTREAM.md',
              from: 'See `FORK_CHANGELOG.md` for detailed changes.',
              to: 'Fork-specific changes are summarized below.',
            },
          ],
        },
      ],
    },
  }

  return { rootDir, sourceRepoDir, sourcePackageDir, targetPackageDir, manifest }
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('release vendoring', () => {
  it('copies attributed source and rewrites the packed manifest to registry-resolvable dependencies', () => {
    const fixture = makeFixture()
    const plan = planVendorPackage({
      rootDir: fixture.rootDir,
      targetPackageDir: fixture.targetPackageDir,
      manifest: fixture.manifest,
    })

    expect(plan.manifest.dependencies).toEqual({ 'is-dom': '1.1.0' })
    expect(plan.manifest.imports).toEqual({
      '#vendor/react-inspector': './src/vendor/react-inspector/src/index.tsx',
    })
    expect(plan.manifest.$genie.releaseVendors).toBeUndefined()
    expect(plan.manifest.$vendored['@overeng/react-inspector']).toMatchObject({
      source: 'https://github.com/overengineeringstudio/effect-utils',
      packagePath: 'packages/vendor',
      version: '9.0.0',
      license: 'MIT',
    })

    applyVendorPlan(plan)

    expect(readFileSync(join(fixture.targetPackageDir, 'src/vendor/react-inspector/LICENSE'), 'utf8')).toContain(
      'Copyright (c) 2017 Xiaoyi Chen',
    )
    const upstream = readFileSync(join(fixture.targetPackageDir, 'src/vendor/react-inspector/UPSTREAM.md'), 'utf8')
    expect(upstream).toContain('storybookjs/react-inspector')
    expect(upstream).toContain('Fork-specific changes are summarized below.')
    expect(upstream).not.toContain('FORK_CHANGELOG.md')

    cleanupVendorPlan(plan)
    expect(existsSync(join(fixture.targetPackageDir, 'src/vendor/react-inspector'))).toBe(false)
  })

  it('refuses a dirty source member', () => {
    const fixture = makeFixture()
    writeFileSync(join(fixture.sourcePackageDir, 'src/index.tsx'), 'export const Inspector = false\n')

    expect(() =>
      planVendorPackage({
        rootDir: fixture.rootDir,
        targetPackageDir: fixture.targetPackageDir,
        manifest: fixture.manifest,
      }),
    ).toThrow(/source member is dirty/)
  })

  it('refuses a source package without its licence', () => {
    const fixture = makeFixture({ includeLicense: false })

    expect(() =>
      planVendorPackage({
        rootDir: fixture.rootDir,
        targetPackageDir: fixture.targetPackageDir,
        manifest: fixture.manifest,
      }),
    ).toThrow(/required attribution file is missing: LICENSE/)
  })

  it('refuses an incompatible Effect peer without an override path', () => {
    const fixture = makeFixture({ effectPeer: '^3.0.0' })

    expect(() =>
      planVendorPackage({
        rootDir: fixture.rootDir,
        targetPackageDir: fixture.targetPackageDir,
        manifest: fixture.manifest,
      }),
    ).toThrow(/Effect peer conflict/)
  })
})

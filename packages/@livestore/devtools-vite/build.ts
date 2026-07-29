import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CurrentWorkingDirectory, cmd } from '@livestore/utils-dev/node'
import { Effect, Layer } from '@livestore/utils/effect'
import { Cli, PlatformNode } from '@livestore/utils/node'

const workspaceRoot = path.resolve(import.meta.dirname, '../../..')

const sanitizePublicTextFile = (filePath: string) => {
  if (fs.existsSync(filePath) === false) return
  let content = fs.readFileSync(filePath, 'utf8')
  const replacements = [
    workspaceRoot,
    os.homedir(),
    process.env.DEVENV_ROOT,
    process.env.PWD,
    process.env.PNPM_HOME,
    process.env.PNPM_STORE_DIR,
  ].filter((value): value is string => value !== undefined && value.length > 0)

  for (const value of replacements) {
    content = content.split(value).join('<redacted-path>')
  }

  content = content
    .replaceAll(/\/home\/[^"'`\s,;}]+/g, '<redacted-path>')
    .replaceAll(/\/Users\/[^"'`\s,;}]+/g, '<redacted-path>')

  fs.writeFileSync(filePath, content)
}

const sanitizePublicTextFiles = (dir: string) => {
  if (fs.existsSync(dir) === false) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sanitizePublicTextFiles(filePath)
    } else if (/\.(?:js|css|html|json|txt|md|d\.ts)$/.test(entry.name)) {
      sanitizePublicTextFile(filePath)
    }
  }
}

const pluginDeclaration = `import type { Schema } from '@livestore/utils/effect'
import type { Plugin } from 'vite'

export type DevtoolsMode =
  | { readonly _tag: 'node'; readonly url: string }
  | { readonly _tag: 'web' }
  | { readonly _tag: 'browser-extension' }

export interface PluginOptions {
  readonly schemaPath: string | ReadonlyArray<string>
  readonly mode?: DevtoolsMode
  readonly path?: string
  readonly experimental?: {
    readonly continueOnError?: boolean
  }
}

export declare const PluginOptions: Schema.Schema<PluginOptions>
export declare const devtoolsReactSourceFilter: RegExp
export declare const livestoreDevtoolsPlugin: (options: PluginOptions) => Plugin
`

export const build = Cli.Command.make(
  'run',
  {
    devBuild: Cli.Flag.boolean('devBuild').pipe(Cli.Flag.withDefault(false)),
  },
  Effect.fn('@livestore/devtools-vite/build')(function* ({ devBuild: isDevBuild }) {
    const packageDir = `${workspaceRoot}/packages/@livestore/devtools-vite`
    const distDir = `${packageDir}/dist`
    const packageCwd = CurrentWorkingDirectory.fromPath(packageDir)
    const devtoolsReactCwd = CurrentWorkingDirectory.fromPath(`${workspaceRoot}/packages/@livestore/devtools-react`)

    console.log('@livestore/devtools-vite/build')
    console.log({ isDevBuild })

    // devtools-react ships source plus this prebuilt, shadow-root-isolated
    // stylesheet. Both the drop-in plugin and direct embedders consume the same
    // package source; consumers do not need their own Tailwind configuration.
    yield* cmd(`./node_modules/.bin/tailwindcss -i ./src/index.css -o ./dist/index.css`).pipe(
      Effect.provide(devtoolsReactCwd),
    )

    // devtools-react consumes devtools-common at runtime. Build only its
    // remaining public entries; the retired licensing entry stays deleted.
    yield* cmd(
      [
        'bun build',
        '--tsconfig-override ./tsconfig.bun-runtime.json',
        '../devtools-common/src/index.ts',
        '../devtools-common/src/chrome-extension.ts',
        '--outdir ../devtools-common/dist',
        '--target browser',
        '--format esm',
        '--splitting',
        '--sourcemap=none',
      ].join(' '),
    ).pipe(Effect.provide(packageCwd), Effect.withSpan('bun.build.devtools-common'))

    fs.rmSync(distDir, { recursive: true, force: true })
    yield* cmd(
      [
        'bun build',
        '--tsconfig-override ./tsconfig.bun-runtime.json',
        './src/plugin.ts',
        '--outdir ./dist',
        '--target node',
        '--conditions default',
        // Vite is supplied by the consuming application.
        '--external vite',
        // Native module: keep its platform loader intact and resolve it from
        // this package's honest runtime dependency.
        '--external @parcel/watcher',
        `--sourcemap=${isDevBuild ? 'linked' : 'none'}`,
        '--root ./src',
        ...(isDevBuild ? [] : ['--minify']),
      ].join(' '),
    ).pipe(Effect.provide(packageCwd), Effect.withSpan('bun.build'))

    fs.writeFileSync(`${distDir}/plugin.d.ts`, pluginDeclaration)
    sanitizePublicTextFiles(distDir)
  }),
)

if (import.meta.main) {
  Cli.Command.run(build, {
    version: '0.0.0',
  }).pipe(Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer)), PlatformNode.NodeRuntime.runMain)
}

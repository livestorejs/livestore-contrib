import path from 'node:path'

import { Devtools } from '@livestore/common'
import { Effect, Logger, Schema } from '@livestore/utils/effect'
import type { InlineConfig, ViteDevServer } from 'vite'
import { createIdResolver, normalizePath, type Plugin, runnerImport } from 'vite'

import {
  getMountPath,
  normalizeClientImport,
  shouldPassThroughViteRequest,
} from './vite-path.ts'

export const PluginOptions = Schema.Struct({
  /**
   * The path to the schema file. The schema file needs to export the schema as `export const schema`.
   * Path needs to be relative to the Vite `root`.
   *
   * Example:
   * ```ts
   * import { devtoolsVitePlugin } from '@livestore/devtools-vite'
   *
   * devtoolsVitePlugin({
   *   schemaPath: './src/db/schema/index.ts'
   *   // ...
   * })
   *
   * If your app uses multiple schemas, you can provide an array of schema paths.
   * ```ts
   * devtoolsVitePlugin({
   *   schemaPath: ['./src/db/schema/index.ts', './src/db/schema2/index.ts']
   *   // ...
   * })
   * ```
   */
  schemaPath: Schema.Union(Schema.String, Schema.Array(Schema.String)),
  /**
   * Where to serve the devtools UI.
   *
   * @default '/_livestore'
   */
  mode: Schema.optional(Devtools.DevtoolsMode),
  path: Schema.optional(Schema.String),
  experimental: Schema.optional(
    Schema.Struct({
      continueOnError: Schema.optional(Schema.Boolean),
    }),
  ),
})

export type PluginOptions = typeof PluginOptions.Type

const pluginName = '@livestore/devtools-vite'
const emptyModuleId = 'virtual:@livestore/devtools-vite/empty-module'
const resolvedEmptyModuleId = `\0${emptyModuleId}`
const emptyDevtoolsReactDependencies = new Set(['marked', 'react-responsive-carousel'])

type ViteDevServerWithOptimizeDeps = ViteDevServer & {
  optimizeDeps?: {
    run: (options?: { force?: boolean; entries?: ReadonlyArray<string> }) => Promise<void>
  }
}

export const livestoreDevtoolsPlugin = (options: PluginOptions): Plugin => {
  const result = Schema.validateEither(PluginOptions)(options)
  if (result._tag === 'Left') {
    console.error(`[@livestore/devtools-vite] Invalid options: ${result.left}`)

    return {
      name: pluginName,
    }
  }

  return {
    name: pluginName,

    // `vite dev` support
    configureServer: (server) =>
      Effect.gen(function* () {
        const serverWithOptimizeDeps = server as ViteDevServerWithOptimizeDeps
        const continueOnError = options.experimental?.continueOnError === true
        const mountPath = getMountPath({
          path: options.path,
          base: server.config.base,
        })

        // console.debug('[livestore-devtools-vite]', {
        //   'server.config.base': server.config.base,
        //   mountPath,
        //   'server.config.root': server.config.root,
        // })

        const root = server.config.root ?? process.cwd()
        const { schemaImports, schemaResolvedPaths } = buildSchemaImports({
          root,
          schemaPath: options.schemaPath,
        })

        const runtime = yield* Effect.runtime()

        // Compute HTML once and avoid SSR-time imports to prevent Vite 7 runner races.
        // Both entry points resolve from the real devtools-react dependency; Vite
        // compiles that package's published TypeScript source for the drop-in UI.
        let htmlCache: string | undefined
        const computeHtml = () =>
          Effect.gen(function* () {
            const resolveId = createIdResolver(server.config)
            const devtoolsReactResolved = yield* Effect.promise(() =>
              resolveId(server.environments.client, '@livestore/devtools-react'),
            )
            const devtoolsReactCssResolved = yield* Effect.promise(() =>
              resolveId(server.environments.client, '@livestore/devtools-react/index.css'),
            )
            const devtoolsReactImport = normalizeClientImport(devtoolsReactResolved)
            const devtoolsReactCssImport = normalizeClientImport(devtoolsReactCssResolved)
            if (devtoolsReactImport === undefined || devtoolsReactCssImport === undefined) {
              return yield* Effect.fail(
                new Error(
                  'Could not resolve @livestore/devtools-react source and stylesheet from @livestore/devtools-vite',
                ),
              )
            }

            // Determine whether the app provides the web adapter's shared worker
            // in the client environment.
            const sharedWorkerImport = yield* Effect.promise(() =>
              resolveId(
                server.environments.client,
                '@livestore/adapter-web/shared-worker?sharedworker',
              ),
            ).pipe(
              Effect.map((resolved) => normalizeClientImport(resolved)),
              Effect.orElseSucceed(() => undefined),
            )

            const template = makeIndexHtml(
              {
                schemaImports,
                devtoolsReactImport,
                devtoolsReactCssImport,
                mountPath,
                ...(options.mode !== undefined ? { mode: options.mode } : {}),
                sharedWorkerImport,
              },
              undefined,
            )
            return template
          })

        // Prewarm optimizeDeps once on startup; later requests reuse this outcome to decide whether to serve devtools.
        const resolveId = createIdResolver(server.config)
        const devtoolsReactEntry = yield* Effect.promise(() =>
          resolveId(server.environments.client, '@livestore/devtools-react'),
        )
        const optimizeDepsOutcome = yield* prewarmOptimizeDeps({
          server: serverWithOptimizeDeps,
          schemaEntries: schemaResolvedPaths,
          devtoolsEntry: devtoolsReactEntry,
        }).pipe(Effect.either)

        const schemaValidationPromise = scheduleEagerSchemaValidation(server, schemaResolvedPaths)

        server.middlewares.use(mountPath, async (req, res, next) => {
          if (optimizeDepsOutcome._tag === 'Left') {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/plain')
            res.end(`LiveStore DevTools: optimizeDeps failed\n${String(optimizeDepsOutcome.left)}`)
            return
          }
          if (res.writableEnded || req.url === undefined) {
            next()
            return
          }

          // console.log('livestore-devtools-vite:req', url)

          if (shouldPassThroughViteRequest({ rawUrl: req.url, mountPath }) === true) {
            next()
            return
          } else {
            // If eager validation found issues and continueOnError is false, block DevTools route
            if (!continueOnError) {
              const validation = await schemaValidationPromise
              if (!validation.ok) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'text/plain')
                res.end(
                  `LiveStore DevTools: schema validation failed\n${validation.errors.map((e) => ` - ${e}`).join('\n')}`,
                )
                return
              }
            }
            // Serve the devtools index.html (compute/cached on demand)
            if (!htmlCache) {
              try {
                const rawHtml = await computeHtml().pipe(Effect.provide(runtime), Effect.runPromise)
                htmlCache = rawHtml
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'text/plain')
                res.end(`LiveStore DevTools: HTML generation failed\n${String(e)}`)
                return
              }
            }
            res.setHeader('Content-Type', 'text/html')
            res.end(htmlCache)
            return
          }
        })

        // yield* Effect.never
      }).pipe(
        Effect.scoped,
        Effect.tapCauseLogPretty,
        Effect.provide(Logger.prettyWithThread('livestore-devtools-vite')),
        Effect.runPromise,
      ),

    config: async (config, env) => {
      if (config.optimizeDeps === undefined) {
        config.optimizeDeps = {}
      }

      if (config.optimizeDeps.exclude === undefined) {
        config.optimizeDeps.exclude = []
      }

      if (env.command === 'serve') {
        if (config.define === undefined) {
          config.define = {}
        }

        /**
         * Configure CORS for devtools RPC endpoint to allow cross-origin requests
         * from https://livestore.dev to local development server. This ensures
         * OPTIONS preflight requests are handled correctly by Vite's built-in
         * CORS middleware before reaching our custom RPC handler.
         */
        if (config.server === undefined) {
          config.server = {}
        }
        // Only set CORS if not already configured or if it's explicitly disabled
        if (config.server.cors === undefined || config.server.cors === false) {
          config.server.cors = {
            origin: true,
            credentials: true,
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['*'],
          }
        }
        // If cors is already true or an object with configuration, leave it as is

        const mountPath = getMountPath({
          path: options.path,
          base: config.base ?? '/',
        })
        config.define.LIVESTORE_DEVTOOLS_PATH = `'${mountPath}'`
      }

      const mergedOptimizeDepsEntries = mergeOptimizeDepsEntries({
        current: config.optimizeDeps.entries,
        root: config.root ? path.resolve(config.root) : process.cwd(),
        schemaPath: options.schemaPath,
      })
      if (mergedOptimizeDepsEntries !== undefined) {
        config.optimizeDeps.entries = mergedOptimizeDepsEntries
      }

      // Avoid adding transitive dependencies here because Vite may prebundle
      // incompatible duplicate dependency graphs.
      const toAdd = ['@livestore/devtools-vite', '@livestore/wa-sqlite']

      for (const dep of toAdd) {
        if (!config.optimizeDeps.exclude.includes(dep)) {
          config.optimizeDeps.exclude.push(dep)
        }
      }

      return config
    },

    resolveId: (id, importer) => {
      if (
        emptyDevtoolsReactDependencies.has(id) &&
        importer !== undefined &&
        normalizePath(importer).includes('/@livestore/devtools-react/')
      ) {
        return resolvedEmptyModuleId
      }
      if (id === emptyModuleId) return resolvedEmptyModuleId
      return undefined
    },

    load: (id) => (id === resolvedEmptyModuleId ? 'export default {}' : undefined),

    // `vite build` support below
    // TODO maybe bring back at some point
    // config: (config) => {
    //   if (config.build === undefined) {
    //     config.build = {}
    //   }

    //   if (config.build.rollupOptions === undefined) {
    //     config.build.rollupOptions = {}
    //   }

    //   if (config.build.rollupOptions.input === undefined) {
    //     config.build.rollupOptions.input = {
    //       main: path.resolve('./index.html'),
    //     }
    //   }

    //   if (isRecord(config.build.rollupOptions.input)) {
    //     config.build.rollupOptions.input.devtools = 'virtual:_devtools.html'
    //     // config.build.rollupOptions.input.devtools = '_devtools.html'
    //   }

    //   return config
    // },
    // writeBundle: (_) => {
    //   fs.renameSync(path.join(_.dir!, 'virtual:_devtools.html'), path.join(_.dir!, '_devtools.html'))
    // },

    // resolveId: (id) => {
    //   if (id === 'virtual:_devtools.html') {
    //     return id
    //   }
    // },

    // load: (id) => {
    //   if (id === 'virtual:_devtools.html') {
    //     return makeIndexHtml({ schemaPath: options.schemaPath })
    //   }
    // },
  }
}

const makeIndexHtml = (
  {
    schemaImports,
    devtoolsReactImport,
    devtoolsReactCssImport,
    mountPath,
    mode,
    sharedWorkerImport,
  }: {
    schemaImports: ReadonlyArray<string>
    devtoolsReactImport: string
    devtoolsReactCssImport: string
    mountPath: string
    mode?: Devtools.DevtoolsMode
    sharedWorkerImport: string | undefined
  },
  _unused?: undefined,
) => {
  // `sharedWorker` is only needed for @livestore/adapter-web.
  return /*html*/ `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="livestore-devtools" content="true" />
    <link rel="stylesheet" href="${devtoolsReactCssImport}">
    <title>LiveStore Devtools</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@vite/client"></script>
    <script type="module">
${schemaImports.map((schemaPath, index) => `      import { schema as schema${index} } from '${schemaPath}'`).join('\n')}
${sharedWorkerImport ? `      import sharedWorker from '${sharedWorkerImport}'` : '      const sharedWorker = undefined'}
      import { mountDevtools } from '${devtoolsReactImport}'

      mountDevtools({
        schemas: [${schemaImports.map((_schemaPath, index) => `schema${index}`).join(', ')}],
        rootEl: document.getElementById('root'),
        mode: ${mode ? Schema.encodeSync(Schema.parseJson(Devtools.DevtoolsMode))(mode) : undefined},
        sharedWorker,
        mountPath: '${mountPath}',
      })
    </script>
  </body>
</html>
	`
}

const prewarmOptimizeDeps = ({
  server,
  schemaEntries,
  devtoolsEntry,
}: {
  server: ViteDevServerWithOptimizeDeps
  schemaEntries: ReadonlyArray<string>
  devtoolsEntry: string | undefined
}): Effect.Effect<void> => {
  const entries = devtoolsEntry ? [...schemaEntries, devtoolsEntry] : schemaEntries
  if (typeof server.optimizeDeps?.run !== 'function') {
    // No-op when optimizeDeps.run is unavailable (older Vite or custom servers)
    return Effect.void
  }
  // Force a single upfront optimizeDeps pass to prevent re-optimisation during /_livestore requests.
  return Effect.promise(() => server.optimizeDeps!.run({ force: true, entries }))
}

/**
 * Build both HTML import ids and absolute paths for schema modules.
 *
 * The import IDs use `/@fs/...` format to ensure they're correctly routed through Vite's
 * file system middleware, regardless of the DevTools mount path configuration.
 *
 * @example
 * ```
 * schemaPath: './src/livestore/schema.ts', root: '/workspace/example-app'
 *   -> importId: '/@fs/workspace/example-app/src/livestore/schema.ts'
 *
 * schemaPath: '/other/project/schema.ts', root: '/workspace/example-app'
 *   -> importId: '/@fs/other/project/schema.ts'
 * ```
 */
const buildSchemaImports = ({
  schemaPath,
  root,
}: {
  schemaPath: PluginOptions['schemaPath']
  root: string
}): { schemaImports: ReadonlyArray<string>; schemaResolvedPaths: ReadonlyArray<string> } => {
  const schemaPathsInput = Array.isArray(schemaPath) ? schemaPath : [schemaPath]
  const schemaEntries = schemaPathsInput.map((schema) => {
    const absolutePath = path.isAbsolute(schema) ? schema : path.resolve(root, schema)
    return {
      absolutePath,
      importId: `/@fs${normalizePath(absolutePath)}`,
    }
  })
  return {
    schemaImports: schemaEntries.map((entry) => entry.importId),
    schemaResolvedPaths: schemaEntries.map((entry) => entry.absolutePath),
  }
}

const mergeOptimizeDepsEntries = ({
  current,
  root,
  schemaPath,
}: {
  current: InlineConfig['optimizeDeps'] extends infer O
    ? O extends { entries?: any }
      ? O['entries']
      : undefined
    : undefined
  root: string
  schemaPath: PluginOptions['schemaPath']
}): InlineConfig['optimizeDeps'] extends infer O
  ? O extends { entries?: any }
    ? O['entries']
    : undefined
  : undefined => {
  const schemaPathsInput = Array.isArray(schemaPath) ? schemaPath : [schemaPath]
  const schemaEntries = schemaPathsInput.map((schema) =>
    path.isAbsolute(schema) ? schema : path.resolve(root, schema),
  )
  const existingEntries = Array.isArray(current) ? current : current ? [current] : []
  // Preserve user entries and append schema entries if missing.
  const mergedEntries = [...existingEntries]
  for (const entry of schemaEntries) {
    if (!mergedEntries.includes(entry)) {
      mergedEntries.push(entry)
    }
  }
  return mergedEntries.length > 0 ? mergedEntries : current
}

/**
 * Eager (best‑effort) schema validation once the dev server starts listening.
 *
 * Validates, for each provided module path, that importing the module via
 * Vite’s `runnerImport` succeeds and the module exports a named `schema`.
 *
 * Notes
 * - No SSR runner is involved (avoids Vite 7 transport races).
 * - Doesn’t crash the dev server — logs helpful errors only.
 * - Does not validate the runtime shape of `schema`; the app/DevTools handle that.
 */
const scheduleEagerSchemaValidation = (
  server: ViteDevServer,
  schemaPaths: ReadonlyArray<string>,
): Promise<{ ok: boolean; errors: string[] }> => {
  type MaybeHttpServer = { once?: (event: string, listener: () => void) => void }
  const httpServer = (server as unknown as { httpServer?: MaybeHttpServer }).httpServer
  if (!httpServer || typeof httpServer.once !== 'function')
    return Promise.resolve({ ok: true, errors: [] })
  return new Promise((resolve) => {
    if (!httpServer || typeof httpServer.once !== 'function') {
      resolve({ ok: true, errors: [] })
      return
    }
    httpServer.once('listening', () => {
      void (async () => {
        const errors: string[] = []
        for (const schemaPath of schemaPaths) {
          try {
            const inlineConfig: InlineConfig = {
              root: server.config.root,
              configFile: server.config.configFile ?? false,
              mode: server.config.mode,
              logLevel: 'silent',
              resolve: {
                // Pass user's resolve.alias to support Vite path aliases in schema files (issue #938).
                // Only alias is passed - passing the full resolve config breaks Node builtin resolution.
                alias: server.config.resolve.alias,
              },
            }
            const result = await runnerImport<Record<string, unknown>>(schemaPath, inlineConfig)
            const imported = result.module
            if (!(imported && typeof imported === 'object' && 'schema' in imported)) {
              console.error(
                `[@livestore/devtools-vite] Eager import succeeded but \`schema\` export was not found in ${schemaPath}`,
              )
              errors.push(`Missing export \`schema\` in ${schemaPath}`)
            }
          } catch (err) {
            console.error(
              `[@livestore/devtools-vite] Error importing schema file ${schemaPath}`,
              err,
            )
            errors.push(`Import error for ${schemaPath}: ${String(err)}`)
          }
        }
        resolve({ ok: errors.length === 0, errors })
      })()
    })
  })
}

#!/usr/bin/env -S node --experimental-strip-types

import { NodeHttpClient, NodeRuntime } from '@effect/platform-node'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Otlp from 'effect/unstable/observability/Otlp'

import { runCli } from './cli/index.ts'
import { selectControlSocketPath } from './cli/socket-option.ts'
import { defaultControlSocket } from './control/transport.ts'
import { gatewayIntents, loadRuntimeConfig, makeUnixBotControlClient, runRuntime } from './runtime/index.ts'

export { gatewayIntents }

const args = process.argv.slice(2)

export const program =
  args[0] === 'serve'
    ? Effect.gen(function* () {
        const configPath = yield* readConfigPath(args)
        const config = yield* loadRuntimeConfig(configPath).pipe(Effect.orDie)
        return yield* runRuntime(config, configPath).pipe(Effect.orDie)
      }).pipe(Effect.scoped)
    : Effect.gen(function* () {
        const environment = args.includes('production') === true ? 'production' : 'staging'
        const socketOption = selectControlSocketPath({
          args,
          environmentPath: process.env.LIVESTORE_DISCORD_CONTROL_SOCKET,
          defaultPath: defaultControlSocket(environment).path,
        })
        if (socketOption._tag === 'UsageError') {
          process.stderr.write(`CRITICAL usage: ${socketOption.message}\n`)
          process.exitCode = 2
          return
        }
        const client = yield* makeUnixBotControlClient(socketOption.path)
        const code = yield* runCli(args, client, {
          stdout: (line) => process.stdout.write(`${line}\n`),
          stderr: (line) => process.stderr.write(`${line}\n`),
          isTTY: process.stdout.isTTY,
        })
        if (code !== 0) process.exitCode = code
      }).pipe(Effect.scoped)

const readConfigPath = (values: ReadonlyArray<string>) => {
  const index = values.indexOf('--config')
  const configured = index === -1 ? process.env.LIVESTORE_DISCORD_CONFIG : values[index + 1]
  if (configured === undefined || configured.trim().length === 0) {
    return Effect.die('serve requires --config <path> or LIVESTORE_DISCORD_CONFIG')
  }
  return Effect.succeed(configured)
}

const observability =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    ? Layer.empty
    : Otlp.layerJson({
        baseUrl: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        resource: {
          serviceName: 'livestore-discord',
          serviceVersion: process.env.OTEL_SERVICE_VERSION ?? process.env.LIVESTORE_DISCORD_RELEASE_ID ?? 'unknown',
          attributes: {
            environment:
              process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.LIVESTORE_DISCORD_ENVIRONMENT ?? 'unknown',
          },
        },
      }).pipe(Layer.provide(NodeHttpClient.layerUndici))

program.pipe(Effect.provide(Layer.merge(observability, NodeServices.layer)), NodeRuntime.runMain)

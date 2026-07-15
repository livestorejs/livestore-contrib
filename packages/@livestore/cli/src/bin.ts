#!/usr/bin/env node

import { liveStoreVersion } from '@livestore/common'
import { Console, Effect, FetchHttpClient, Layer, References } from '@livestore/utils/effect'
import { Cli, PlatformNode } from '@livestore/utils/node'

import { command } from './cli.ts'

const cli = Cli.Command.run(command, {
  version: liveStoreVersion,
})

const showExperimentalWarning = Console.log('⚠️  Warning: LiveStore CLI is experimental and under active development')

const layer = Layer.mergeAll(
  PlatformNode.NodeServices.layer,
  FetchHttpClient.layer,
  Layer.succeed(References.MinimumLogLevel, 'Info'),
)

Effect.gen(function* () {
  yield* showExperimentalWarning
  return yield* cli
}).pipe(Effect.provide(layer), PlatformNode.NodeRuntime.runMain)

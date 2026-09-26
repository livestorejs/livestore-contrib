#!/usr/bin/env -S node --experimental-strip-types

import { NodeFileSystem } from '@effect/platform-node'
import { Effect, FileSystem, Layer, ManagedRuntime } from 'effect'

import { discordSafeLoggerLayer, safeDiscordFailureMessage } from '../../src/discord/rest-error-redaction.ts'
import { runStagingCli, type StagingCliResult } from './staging-cli.ts'

const fileSystemRuntime = ManagedRuntime.make(Layer.merge(NodeFileSystem.layer, discordSafeLoggerLayer))

let result: StagingCliResult
try {
  result = await runStagingCli({
    args: process.argv.slice(2),
    environment: process.env,
    dependencies: {
      readTextFile: (path) =>
        fileSystemRuntime.runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path)),
        ),
    },
  })
} catch (error) {
  process.stderr.write(`${safeDiscordFailureMessage(error)}\n`)
  process.exitCode = 1
  result = { stdout: [], stderr: [], exitCode: 1 }
}

for (const line of result.stdout) process.stdout.write(`${line}\n`)
for (const line of result.stderr) process.stderr.write(`${line}\n`)
process.exitCode = result.exitCode

await fileSystemRuntime.dispose()

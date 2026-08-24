#!/usr/bin/env -S node --experimental-strip-types

import { NodeFileSystem } from '@effect/platform-node'
import { Effect, FileSystem, ManagedRuntime } from 'effect'

import { runStagingCli } from './staging-cli.ts'

const fileSystemRuntime = ManagedRuntime.make(NodeFileSystem.layer)

const result = await runStagingCli({
  args: process.argv.slice(2),
  environment: process.env,
  dependencies: {
    readTextFile: (path) =>
      fileSystemRuntime.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path)),
      ),
  },
})

for (const line of result.stdout) process.stdout.write(`${line}\n`)
for (const line of result.stderr) process.stderr.write(`${line}\n`)
process.exitCode = result.exitCode

await fileSystemRuntime.dispose()

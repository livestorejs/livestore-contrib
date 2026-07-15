#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runCell } from './runner.mjs'

const argumentsByName = parseArguments(process.argv.slice(2))
const armModulePath = resolve(argumentsByName['arm-module'] ?? new URL('./loro-arm.mjs', import.meta.url).pathname)
const { standaloneArm, embeddedArm } = await import(pathToFileURL(armModulePath))

const document = await runCell({
  standaloneArm,
  embeddedArm,
  config: {
    seed: required(argumentsByName, 'seed'),
    docSizeBytes: positiveInteger(argumentsByName, 'doc-size-bytes'),
    editCount: positiveInteger(argumentsByName, 'edit-count'),
    concurrency: positiveInteger(argumentsByName, 'concurrency'),
  },
  outputPath: resolve(required(argumentsByName, 'output')),
})

process.stdout.write(`${JSON.stringify({
  output: resolve(argumentsByName.output),
  pairedRunId: document.tax.pairedRunId,
  tax: document.tax,
})}\n`)

function parseArguments(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new TypeError(`invalid CLI argument near ${flag ?? '<end>'}`)
    parsed[flag.slice(2)] = value
  }
  return parsed
}

function required(argumentsByName, name) {
  const value = argumentsByName[name]
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`)
  return value
}

function positiveInteger(argumentsByName, name) {
  const value = Number(required(argumentsByName, name))
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`--${name} must be a positive integer`)
  return value
}

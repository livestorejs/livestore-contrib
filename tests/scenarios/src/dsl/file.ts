import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RegisteredApplication } from '../corpus/applications/registry.ts'
import type { ScenarioAst } from '../model.ts'
import { compileScenarioSource } from './compiler.ts'

export interface ScenarioFileCompileOptions {
  readonly applications: ReadonlyArray<RegisteredApplication>
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
  readonly seed?: number
}

export const compileScenarioFileSync = (file: string | URL, options: ScenarioFileCompileOptions): ScenarioAst => {
  const fileName = file instanceof URL ? fileURLToPath(file) : path.resolve(file)
  return compileScenarioSource({ fileName, source: fs.readFileSync(fileName, 'utf8'), ...options })
}

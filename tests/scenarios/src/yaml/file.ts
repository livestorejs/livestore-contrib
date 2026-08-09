import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { RegisteredApplication } from '../corpus/applications/registry.ts'
import type { ScenarioAst } from '../model.ts'
import { compileScenarioYamlSource } from './compiler.ts'
import { composeScenarioHelpers, ScenarioHelperRegistryError, type ScenarioHelperRegistry } from './helpers.ts'

export interface ScenarioFileCompileOptions {
  readonly applications: ReadonlyArray<RegisteredApplication>
  readonly helpers?: ScenarioHelperRegistry
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
  readonly seed?: number
}

export const compileScenarioYamlFileSync = (file: string | URL, options: ScenarioFileCompileOptions): ScenarioAst => {
  const fileName = file instanceof URL ? fileURLToPath(file) : path.resolve(file)
  return compileScenarioYamlSource({ fileName, source: fs.readFileSync(fileName, 'utf8'), ...options })
}

/** Loads an explicit local Scenario and its exact same-name `.helpers.ts` companion when present. */
export const compileScenarioYamlFile = async (
  file: string | URL,
  options: ScenarioFileCompileOptions,
): Promise<ScenarioAst> => {
  const fileName = file instanceof URL ? fileURLToPath(file) : path.resolve(file)
  const companionFile =
    fileName.endsWith('.scenario.yaml') === true
      ? fileName.slice(0, -'.scenario.yaml'.length) + '.helpers.ts'
      : undefined
  let companionHelpers: ScenarioHelperRegistry | undefined
  if (companionFile !== undefined && fs.existsSync(companionFile) === true) {
    let loaded: unknown
    try {
      loaded = await import(pathToFileURL(companionFile).href)
    } catch (cause) {
      throw new ScenarioHelperRegistryError(
        `Failed to load Scenario helper companion ${companionFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    if (isRecord(loaded) === false || isRecord(loaded.default) === false) {
      throw new ScenarioHelperRegistryError(
        `Scenario helper companion ${companionFile} must default-export defineScenarioHelpers({...})`,
      )
    }
    companionHelpers = loaded.default as ScenarioHelperRegistry
  }
  const helpers = composeScenarioHelpers([
    { source: 'shared Scenario helper catalogue', helpers: options.helpers },
    { source: companionFile ?? `${fileName} companion`, helpers: companionHelpers },
  ])
  return compileScenarioYamlFileSync(fileName, { ...options, helpers })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

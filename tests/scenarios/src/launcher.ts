import { spawn } from 'node:child_process'
import path from 'node:path'

import { parseCoreSelection, withCoreSource } from './core-source.ts'

const workspaceRoot = path.resolve(import.meta.dirname, '../../..')

const main = async (): Promise<void> => {
  const parsed = parseCoreSelection(process.argv.slice(2))
  const exitCode = await withCoreSource({
    selection: parsed.selection,
    workspaceRoot,
    run: (core) => {
      console.log(`LiveStore: ${core.label}`)
      console.log(`Core revision: ${core.sourceRevision}`)
      return runScenarioCli(parsed.scenarioArgs, core)
    },
  })
  process.exitCode = exitCode
}

const runScenarioCli = (
  scenarioArgs: ReadonlyArray<string>,
  core: { readonly path: string; readonly sourceRevision: string },
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), path.join(import.meta.dirname, 'cli.ts'), ...scenarioArgs],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          LIVESTORE_SCENARIO_CORE_PATH: core.path,
          LIVESTORE_SCENARIO_SOURCE_REVISION: core.sourceRevision,
        },
        stdio: 'inherit',
      },
    )
    let receivedSignal: NodeJS.Signals | undefined
    const signalHandlers = new Map<NodeJS.Signals, () => void>()
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        receivedSignal = signal
        child.kill(signal)
      }
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    }

    child.once('error', (cause) => {
      removeSignalHandlers()
      reject(cause)
    })
    child.once('exit', (code, signal) => {
      removeSignalHandlers()
      if (receivedSignal === 'SIGINT' || signal === 'SIGINT') resolve(130)
      else if (receivedSignal === 'SIGTERM' || signal === 'SIGTERM') resolve(143)
      else resolve(code ?? 1)
    })
  })

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})

import { defaultRunCommand, makeDfxLiveTransport, type CommandRunner } from './dfx-live-transport.ts'
import { makeCommandHumanHandoffBroker } from './human-handoff.ts'
import type { LiveManifest } from './live-manifest.ts'
import { runLiveStaging } from './live-runner.ts'
import type { MessageSnapshot, RunReceipt, Snowflake } from './model.ts'

export interface RunDfxLiveInput {
  readonly manifest: LiveManifest | undefined
  readonly confirmation: string | undefined
  /** Resolved from manifest.actorBotTokenRef only by an approved op-proxy wrapper. */
  readonly actorBotToken: string | undefined
  readonly cliExecutable?: string
  readonly runCommand?: CommandRunner
  /** Explicit attended broker executable; absence keeps every human lane UNRUN. */
  readonly humanHandoffBrokerExecutable?: string
  readonly createHumanMessage?: (input: {
    readonly channelId: Snowflake
    readonly marker: string
    readonly content: string
  }) => Promise<MessageSnapshot>
  readonly invokeMessageAction?: Parameters<typeof makeDfxLiveTransport>[0]['invokeMessageAction']
  readonly invokeDocs?: Parameters<typeof makeDfxLiveTransport>[0]['invokeDocs']
  readonly deleteHumanResponse?: Parameters<typeof makeDfxLiveTransport>[0]['deleteHumanResponse']
  readonly humanAssisted?: boolean
}

/** Runs configured lanes; absent human-assisted callbacks truthfully produce UNRUN. */
export const runDfxLiveStaging = async (input: RunDfxLiveInput): Promise<RunReceipt> => {
  if (input.manifest === undefined || input.actorBotToken === undefined || input.actorBotToken.trim() === '') {
    return runLiveStaging({
      manifest: input.manifest,
      confirmation: input.confirmation,
      transport: undefined,
      humanAssisted: false,
    })
  }

  const humanBroker =
    input.humanHandoffBrokerExecutable === undefined
      ? undefined
      : makeCommandHumanHandoffBroker({
          executable: input.humanHandoffBrokerExecutable,
          runCommand: input.runCommand ?? defaultRunCommand,
        })
  const createHumanMessage = input.createHumanMessage ?? humanBroker?.createMessage
  const invokeMessageAction = input.invokeMessageAction ?? humanBroker?.invokeMessageAction
  const invokeDocs = input.invokeDocs ?? humanBroker?.invokeDocs
  const deleteHumanResponse = input.deleteHumanResponse ?? humanBroker?.deleteResponse
  const live = makeDfxLiveTransport({
    actorBotToken: input.actorBotToken,
    target: input.manifest.target,
    botControlSocket: input.manifest.botControlSocket,
    ...(input.cliExecutable === undefined ? {} : { cliExecutable: input.cliExecutable }),
    ...(input.runCommand === undefined ? {} : { runCommand: input.runCommand }),
    ...(createHumanMessage === undefined ? {} : { createHumanMessage }),
    ...(invokeMessageAction === undefined ? {} : { invokeMessageAction }),
    ...(invokeDocs === undefined ? {} : { invokeDocs }),
    ...(deleteHumanResponse === undefined ? {} : { deleteHumanResponse }),
    ...(humanBroker?.deleteMessage === undefined ? {} : { deleteHumanMessage: humanBroker.deleteMessage }),
  })
  try {
    return await runLiveStaging({
      manifest: input.manifest,
      confirmation: input.confirmation,
      transport: live.transport,
      humanAssisted: input.humanAssisted === true || input.humanHandoffBrokerExecutable !== undefined,
    })
  } finally {
    await live.dispose()
  }
}

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { decodeDiscordSnowflake, JournalTrigger } from "./model.ts"
import { makeSqliteThreadActionJournal } from "./sqlite.ts"

const WorkerInput = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  JournalTrigger,
])

const program = Effect.gen(function* () {
  const [path, sourceMessageIdRaw, channelIdRaw, trigger] = Schema.decodeUnknownSync(WorkerInput)(process.argv.slice(2))
  const journal = yield* makeSqliteThreadActionJournal({ path })
  const result = yield* journal.claim({
    sourceMessageId: decodeDiscordSnowflake(sourceMessageIdRaw),
    channelId: decodeDiscordSnowflake(channelIdRaw),
    trigger,
    now: Date.now(),
    reconcileBy: Date.now() + 60_000,
  })
  yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ acquired: result.acquired })}\n`))
})

NodeRuntime.runMain(Effect.scoped(program))

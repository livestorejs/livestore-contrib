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
  const [path, sourceMessageIdRaw, channelIdRaw, trigger] = yield* Schema.decodeUnknownEffect(WorkerInput)(process.argv.slice(2))
  const journal = yield* makeSqliteThreadActionJournal({ path })
  const result = yield* journal.claim({
    sourceMessageId: decodeDiscordSnowflake(sourceMessageIdRaw),
    channelId: decodeDiscordSnowflake(channelIdRaw),
    trigger,
    now: Date.now(),
    reconcileBy: Date.now() + 60_000,
  })
  const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ acquired: result.acquired })
  yield* Effect.sync(() => process.stdout.write(`${output}\n`))
})

program.pipe(Effect.scoped, NodeRuntime.runMain)

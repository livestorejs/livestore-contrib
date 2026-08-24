import * as Schema from "effect/Schema"
import { DiscordSnowflake, JournalState, ThreadActionRecord } from "../journal/model.ts"

export const ReconciliationEligibleState = Schema.Literals(["pending", "creating", "unknown_external"])
export type ReconciliationEligibleState = typeof ReconciliationEligibleState.Type

export type ReconciliationSelection =
  | { readonly _tag: "One"; readonly sourceMessageId: DiscordSnowflake }
  | {
      readonly _tag: "All"
      readonly state?: ReconciliationEligibleState
      readonly limit?: number
    }

export type ReconciliationMode =
  | { readonly _tag: "Plan" }
  | { readonly _tag: "Apply"; readonly reason: string }

export interface ReconciliationRequest {
  readonly selection: ReconciliationSelection
  readonly mode: ReconciliationMode
  /** Supplied by the runtime so decisions and receipts are repeatable in tests. */
  readonly now: number
  /** Startup owns every pre-existing pending claim; periodic runs wait for its deadline. */
  readonly pendingPolicy?: "stale-only" | "close-interrupted"
}

export type ThreadObservation =
  | { readonly _tag: "ExactSourceThread"; readonly threadId: DiscordSnowflake }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unrun"; readonly reason: ObservationUnrunReason }

export type ObservationUnrunReason =
  | "source_anchor_not_proven"
  | "discord_read_unavailable"
  | "discord_response_invalid"

export type ReconciliationDisposition =
  | "not_found"
  | "not_eligible"
  | "would_adopt"
  | "adopted"
  | "would_record_absence"
  | "absence_recorded"
  | "would_mark_manual_review"
  | "manual_review"
  | "would_close_interrupted_pending"
  | "interrupted_pending_closed"
  | "unrun"

export interface ReconciliationReceipt {
  readonly receiptId: string
  readonly sourceMessageId: DiscordSnowflake
  readonly beforeState: JournalState | "not_found"
  readonly afterState: JournalState | "not_found"
  readonly disposition: ReconciliationDisposition
  readonly mutated: boolean
  readonly threadId?: DiscordSnowflake
  readonly unrunReason?: ObservationUnrunReason
}

export interface ReconciliationResult {
  readonly receipts: ReadonlyArray<ReconciliationReceipt>
  readonly truncated: boolean
}

export class InvalidReconciliationRequest extends Schema.TaggedError<InvalidReconciliationRequest>()(
  "InvalidReconciliationRequest",
  { message: Schema.String },
) {}

export class ThreadObservationError extends Schema.TaggedError<ThreadObservationError>()(
  "ThreadObservationError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type ReconciliationRecord = typeof ThreadActionRecord.Type

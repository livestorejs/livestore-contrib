//! Port of `packages/@livestore/common/src/sync/syncstate.ts` (`merge` and its helpers).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{Event, SeqNum};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub pending: Vec<Event>,
    pub upstream_head: SeqNum,
    pub local_head: SeqNum,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "_tag", rename_all_fields = "camelCase")]
pub enum Payload {
    #[serde(rename = "upstream-rebase")]
    UpstreamRebase {
        rollback_events: Vec<Event>,
        new_events: Vec<Event>,
    },
    #[serde(rename = "upstream-advance")]
    UpstreamAdvance { new_events: Vec<Event> },
    #[serde(rename = "local-push")]
    LocalPush { new_events: Vec<Event> },
}

impl Payload {
    pub fn new_events(&self) -> &[Event] {
        match self {
            Payload::UpstreamRebase { new_events, .. }
            | Payload::UpstreamAdvance { new_events }
            | Payload::LocalPush { new_events } => new_events,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeContext {
    pub payload: Payload,
    pub sync_state: SyncState,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(
    tag = "_tag",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum MergeResult {
    Advance {
        new_sync_state: SyncState,
        new_events: Vec<Event>,
        /// Events which were previously pending but are now confirmed.
        confirmed_events: Vec<Event>,
        merge_context: MergeContext,
    },
    Rebase {
        new_sync_state: SyncState,
        new_events: Vec<Event>,
        rollback_events: Vec<Event>,
        merge_context: MergeContext,
    },
    Reject {
        expected_minimum_id: SeqNum,
        merge_context: MergeContext,
    },
}

/// Invariant violation; the TS implementation dies (defect) with the same message.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct MergeError(pub String);

pub fn merge(
    sync_state: &SyncState,
    payload: &Payload,
    is_client_only: impl Fn(&Event) -> bool,
    is_equal: impl Fn(&Event, &Event) -> bool,
    ignore_client_only_events: bool,
) -> Result<MergeResult, MergeError> {
    validate_sync_state(sync_state)?;
    validate_payload(payload)?;

    let merge_context = MergeContext {
        payload: payload.clone(),
        sync_state: sync_state.clone(),
    };

    let result = match payload {
        Payload::UpstreamRebase {
            rollback_events,
            new_events,
        } => {
            let new_upstream_head = new_events
                .last()
                .map_or(sync_state.upstream_head, |e| e.seq_num);
            let rebased_pending =
                rebase_events(&sync_state.pending, new_upstream_head, &is_client_only);
            MergeResult::Rebase {
                new_sync_state: SyncState {
                    local_head: rebased_pending
                        .last()
                        .map_or(new_upstream_head, |e| e.seq_num),
                    pending: rebased_pending.clone(),
                    upstream_head: new_upstream_head,
                },
                new_events: concat(new_events, &rebased_pending),
                rollback_events: concat(rollback_events, &sync_state.pending),
                merge_context,
            }
        }

        Payload::UpstreamAdvance { new_events } => {
            if new_events.is_empty() {
                return validate_merge_result(MergeResult::Advance {
                    new_sync_state: sync_state.clone(),
                    new_events: vec![],
                    confirmed_events: vec![],
                    merge_context,
                });
            }

            if new_events
                .windows(2)
                .any(|w| w[0].seq_num.is_greater_than(&w[1].seq_num))
            {
                return Err(MergeError(format!(
                    "Events must be sorted in ascending order by event number. Received: [{}]",
                    seq_list(new_events)
                )));
            }

            let first = &new_events[0].seq_num;
            if sync_state.upstream_head.is_greater_than(first) || sync_state.upstream_head == *first
            {
                return Err(MergeError(format!(
                    "Incoming events must be greater than upstream head. Expected greater than: {}. Received: [{}]",
                    sync_state.upstream_head,
                    seq_list(new_events)
                )));
            }

            let new_upstream_head = new_events.last().unwrap().seq_num;
            let divergent_pending_index = find_divergence_point(
                &sync_state.pending,
                new_events,
                &is_equal,
                &is_client_only,
                ignore_client_only_events,
            );

            match divergent_pending_index {
                None => {
                    let pending_keys: HashSet<(i64, i64)> = sync_state
                        .pending
                        .iter()
                        .map(|e| (e.seq_num.global, e.seq_num.client))
                        .collect();
                    let advanced_events: Vec<Event> = new_events
                        .iter()
                        .filter(|e| !pending_keys.contains(&(e.seq_num.global, e.seq_num.client)))
                        .cloned()
                        .collect();

                    let mut client_index_offset = 0;
                    let split = sync_state
                        .pending
                        .iter()
                        .enumerate()
                        .position(|(index, pending_event)| {
                            if ignore_client_only_events && is_client_only(pending_event) {
                                client_index_offset += 1;
                                return false;
                            }
                            match new_events.get(index - client_index_offset) {
                                None => true,
                                Some(new_event) => !is_equal(pending_event, new_event),
                            }
                        })
                        .unwrap_or(sync_state.pending.len());
                    let (pending_matching, pending_remaining) = sync_state.pending.split_at(split);

                    MergeResult::Advance {
                        new_sync_state: SyncState {
                            pending: pending_remaining.to_vec(),
                            upstream_head: new_upstream_head,
                            local_head: pending_remaining
                                .last()
                                .map_or(sync_state.local_head.max(new_upstream_head), |e| {
                                    e.seq_num
                                }),
                        },
                        new_events: advanced_events,
                        confirmed_events: pending_matching.to_vec(),
                        merge_context,
                    }
                }
                Some(index) => {
                    let divergent_pending = &sync_state.pending[index..];
                    let rebased_pending =
                        rebase_events(divergent_pending, new_upstream_head, &is_client_only);
                    let divergent_new_events_index = find_divergence_point(
                        new_events,
                        &sync_state.pending,
                        &is_equal,
                        &is_client_only,
                        ignore_client_only_events,
                    );
                    // TS calls `slice(-1)` when no divergence is found, keeping only the last event.
                    let start = divergent_new_events_index.unwrap_or(new_events.len() - 1);

                    MergeResult::Rebase {
                        new_sync_state: SyncState {
                            local_head: rebased_pending.last().unwrap().seq_num,
                            pending: rebased_pending.clone(),
                            upstream_head: new_upstream_head,
                        },
                        new_events: concat(&new_events[start..], &rebased_pending),
                        rollback_events: divergent_pending.to_vec(),
                        merge_context,
                    }
                }
            }
        }

        Payload::LocalPush { new_events } => {
            let Some(first) = new_events.first() else {
                return validate_merge_result(MergeResult::Advance {
                    new_sync_state: sync_state.clone(),
                    new_events: vec![],
                    confirmed_events: vec![],
                    merge_context,
                });
            };

            if !first.seq_num.is_greater_than(&sync_state.local_head) {
                return validate_merge_result(MergeResult::Reject {
                    expected_minimum_id: sync_state.local_head.next_pair(true, None).0,
                    merge_context,
                });
            }

            let mut new_pending = sync_state.pending.clone();
            new_pending.extend(
                new_events
                    .iter()
                    .filter(|e| !(ignore_client_only_events && is_client_only(e)))
                    .cloned(),
            );
            MergeResult::Advance {
                new_sync_state: SyncState {
                    local_head: new_pending
                        .last()
                        .map_or(sync_state.local_head.max(sync_state.upstream_head), |e| {
                            e.seq_num
                        }),
                    pending: new_pending,
                    upstream_head: sync_state.upstream_head,
                },
                new_events: new_events.clone(),
                confirmed_events: vec![],
                merge_context,
            }
        }
    };

    validate_merge_result(result)
}

/// Index into `existing` of the first event that differs from the same position in `incoming`.
pub fn find_divergence_point(
    existing: &[Event],
    incoming: &[Event],
    is_equal: &impl Fn(&Event, &Event) -> bool,
    is_client_only: &impl Fn(&Event) -> bool,
    ignore_client_only_events: bool,
) -> Option<usize> {
    if ignore_client_only_events {
        let filtered: Vec<Event> = existing
            .iter()
            .filter(|e| !is_client_only(e))
            .cloned()
            .collect();
        let index = find_divergence_point(&filtered, incoming, is_equal, is_client_only, false)?;
        // Mirrors TS: the filtered index is used to look up the *unfiltered* array.
        let seq_num = existing[index].seq_num;
        return existing.iter().position(|e| e.seq_num == seq_num);
    }

    existing
        .iter()
        .zip(incoming)
        .position(|(existing_event, incoming_event)| !is_equal(existing_event, incoming_event))
}

fn rebase_events(
    events: &[Event],
    base: SeqNum,
    is_client_only: &impl Fn(&Event) -> bool,
) -> Vec<Event> {
    let rebase_generation = base.rebase_generation + 1;
    let mut prev = base;
    events
        .iter()
        .map(|event| {
            let rebased = event.rebase(prev, is_client_only(event), rebase_generation);
            prev = rebased.seq_num;
            rebased
        })
        .collect()
}

fn validate_payload(payload: &Payload) -> Result<(), MergeError> {
    let events = payload.new_events();
    if events
        .windows(2)
        .any(|w| w[0].seq_num.is_greater_than_or_equal(&w[1].seq_num))
    {
        return Err(MergeError(format!(
            "Events must be ordered in monotonically ascending order by eventNum. Received: [{}]",
            seq_list(events)
        )));
    }
    Ok(())
}

fn validate_sync_state(sync_state: &SyncState) -> Result<(), MergeError> {
    for w in sync_state.pending.windows(2) {
        let (event, next) = (&w[0], &w[1]);
        if event.seq_num.is_greater_than_or_equal(&next.seq_num) {
            return Err(MergeError(format!(
                "Events must be ordered in monotonically ascending order by eventNum. Received: [{}]",
                seq_list(&sync_state.pending)
            )));
        }
        if next.seq_num.global > event.seq_num.global {
            if next.seq_num.client != 0 {
                return Err(MergeError(format!(
                    "New global events must point to clientId 0 in the parentSeqNum. Received: ({})",
                    next.seq_num
                )));
            }
        } else if next.parent_seq_num != event.seq_num {
            return Err(MergeError(
                "Events must be linked in a continuous chain via the parentSeqNum".into(),
            ));
        }
    }
    Ok(())
}

fn validate_merge_result(result: MergeResult) -> Result<MergeResult, MergeError> {
    let (new_state, context) = match &result {
        MergeResult::Reject { .. } => return Ok(result),
        MergeResult::Advance {
            new_sync_state,
            merge_context,
            ..
        }
        | MergeResult::Rebase {
            new_sync_state,
            merge_context,
            ..
        } => (new_sync_state, merge_context),
    };
    validate_sync_state(new_state)?;
    if new_state
        .upstream_head
        .is_greater_than(&new_state.local_head)
    {
        return Err(MergeError(
            "Local head must be greater than or equal to upstream head".into(),
        ));
    }
    if !new_state
        .local_head
        .is_greater_than_or_equal(&context.sync_state.local_head)
    {
        return Err(MergeError(
            "New local head must be greater than or equal to the previous local head".into(),
        ));
    }
    if !new_state
        .upstream_head
        .is_greater_than_or_equal(&context.sync_state.upstream_head)
    {
        return Err(MergeError(
            "New upstream head must be greater than or equal to the previous upstream head".into(),
        ));
    }
    Ok(result)
}

fn concat(a: &[Event], b: &[Event]) -> Vec<Event> {
    a.iter().chain(b).cloned().collect()
}

fn seq_list(events: &[Event]) -> String {
    events
        .iter()
        .map(|e| e.seq_num.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

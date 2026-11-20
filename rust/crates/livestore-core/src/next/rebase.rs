use std::collections::HashMap;

use serde_json::Value;

use crate::{Event, SeqNum};

use super::facts::{
    FactValidationResult, Facts, FactsCallback, FactsGroup, apply_fact_groups, facts_intersect,
    get_facts_group_for_event_args, validate_facts,
};
use super::history_dag::HistoryDagNode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictType {
    Overlap,
    MissingRequirement,
}

#[derive(Clone, Debug)]
pub struct RebaseEventWithConflict {
    pub node: HistoryDagNode,
    pub conflict_type: ConflictType,
    pub conflicting_events: Vec<HistoryDagNode>,
}

/// `LiveStoreEvent.Input.Decoded`.
#[derive(Clone, Debug, PartialEq)]
pub struct InputEvent {
    pub name: String,
    pub args: Value,
}

pub type EventFacts = HashMap<String, Option<FactsCallback>>;

pub struct RebaseInput<'a> {
    pub new_remote_events: Vec<RebaseEventWithConflict>,
    pub pending_local_events: Vec<RebaseEventWithConflict>,
    pub validate: &'a dyn Fn(&[InputEvent], &EventFacts) -> FactValidationResult,
}

pub type RebaseFn = dyn Fn(RebaseInput) -> Result<Vec<InputEvent>, String>;

pub fn default_rebase_fn(input: RebaseInput) -> Result<Vec<InputEvent>, String> {
    if input
        .pending_local_events
        .iter()
        .any(|e| e.conflict_type == ConflictType::MissingRequirement)
    {
        return Err("missing-requirement conflicts must be resolved before rebasing".into());
    }
    Ok(input
        .pending_local_events
        .into_iter()
        .map(|e| InputEvent {
            name: e.node.name,
            args: e.node.args,
        })
        .collect())
}

pub fn rebase_events(
    rebase_fn: &RebaseFn,
    pending_local_events: &[HistoryDagNode],
    new_remote_events: &[HistoryDagNode],
    current_facts_snapshot: &Facts,
    client_id: &str,
    session_id: &str,
) -> Result<Vec<Event>, String> {
    let mut initial_snapshot = current_facts_snapshot.clone();
    apply_fact_groups(
        new_remote_events.iter().map(|e| &e.facts_group),
        &mut initial_snapshot,
    );

    let with_conflicts =
        |events: &[HistoryDagNode], others: &[HistoryDagNode]| -> Vec<RebaseEventWithConflict> {
            events
                .iter()
                .map(|e| RebaseEventWithConflict {
                    node: e.clone(),
                    conflict_type: ConflictType::Overlap,
                    conflicting_events: others
                        .iter()
                        .filter(|o| facts_intersect(&o.facts_group.mod_set, &e.facts_group.mod_set))
                        .cloned()
                        .collect(),
                })
                .collect()
        };
    let validate = |events: &[InputEvent], defs: &EventFacts| {
        let groups: Vec<FactsGroup> = events
            .iter()
            .map(|e| get_facts_group_for_event_args(defs[&e.name].as_ref(), &e.args, &Facts::new()))
            .collect();
        validate_facts(&groups.iter().collect::<Vec<_>>(), &initial_snapshot)
    };
    let rebased = rebase_fn(RebaseInput {
        pending_local_events: with_conflicts(pending_local_events, new_remote_events),
        new_remote_events: with_conflicts(new_remote_events, pending_local_events),
        validate: &validate,
    })?;

    let head = new_remote_events
        .last()
        .expect("newRemoteEvents must not be empty")
        .seq_num
        .global;
    Ok(rebased
        .into_iter()
        .enumerate()
        .map(|(i, e)| Event {
            name: e.name,
            args: e.args,
            seq_num: SeqNum::new(head + i as i64 + 1, 0, 0),
            parent_seq_num: SeqNum::new(head + i as i64, 0, 0),
            client_id: client_id.to_owned(),
            session_id: session_id.to_owned(),
        })
        .collect())
}

use std::cell::RefCell;
use std::cmp::Ordering;
use std::sync::Arc;

use serde_json::Value;

use crate::SeqNum;

use super::history_dag::{HistoryDag, HistoryDagNode};

/// `EMPTY_FACT_VALUE` is `None`.
pub type FactValue = Option<Value>;

/// Insertion-ordered fact map, like the JS `Map` used by `EventDefFacts`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts(Vec<(String, FactValue)>);

impl Facts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    pub fn get(&self, key: &str) -> Option<&FactValue> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: impl Into<String>, value: FactValue) {
        let key = key.into();
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    pub fn delete(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &FactValue)> {
        self.0.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
}

impl<K: Into<String>> FromIterator<(K, FactValue)> for Facts {
    fn from_iter<I: IntoIterator<Item = (K, FactValue)>>(iter: I) -> Self {
        let mut facts = Facts::new();
        for (k, v) in iter {
            facts.set(k, v);
        }
        facts
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FactsGroup {
    pub mod_set: Facts,
    pub mod_unset: Facts,
    pub dep_require: Facts,
    pub dep_read: Facts,
}

/// A fact as returned by an event's facts callback: a bare key or `[key, value]`.
pub type FactInput = (String, FactValue);

#[derive(Clone, Debug, Default)]
pub struct FactsCallbackResult {
    pub require: Option<Vec<FactInput>>,
    pub set: Option<Vec<FactInput>>,
    pub unset: Option<Vec<FactInput>>,
}

/// Read access to the current facts that records every read key as a `depRead`.
pub struct FactsReader<'a> {
    facts: &'a Facts,
    reads: RefCell<Facts>,
}

impl FactsReader<'_> {
    pub fn has(&self, key: &str) -> bool {
        self.reads.borrow_mut().set(key, None);
        self.facts.has(key)
    }

    pub fn get(&self, key: &str) -> Option<FactValue> {
        self.reads.borrow_mut().set(key, None);
        self.facts.get(key).cloned()
    }
}

pub type FactsCallback = Arc<dyn Fn(&Value, &FactsReader) -> FactsCallbackResult + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub enum FactValidationResult {
    Success,
    Failure {
        index: usize,
        required_facts: Facts,
        existing: Facts,
        required: Facts,
        current_snapshot: Facts,
    },
}

pub fn facts_snapshot_for_events(events: &[HistoryDagNode], end: SeqNum) -> Facts {
    let mut facts = Facts::new();
    for event in events {
        if compare_event_sequence_numbers(&event.seq_num, &end) == Ordering::Greater {
            return facts;
        }
        apply_fact_group(&event.facts_group, &mut facts);
    }
    facts
}

pub fn facts_snapshot_for_dag(dag: &HistoryDag, end: Option<SeqNum>) -> Facts {
    let mut facts = Facts::new();
    for id in dag.topological_node_ids() {
        let event = dag.get_node_attributes(&id);
        if end.is_some_and(|end| {
            compare_event_sequence_numbers(&event.seq_num, &end) == Ordering::Greater
        }) {
            return facts;
        }
        apply_fact_group(&event.facts_group, &mut facts);
    }
    facts
}

pub fn validate_facts(
    fact_groups: &[&FactsGroup],
    initial_snapshot: &Facts,
) -> FactValidationResult {
    let mut current = initial_snapshot.clone();
    for (index, group) in fact_groups.iter().enumerate() {
        if !is_sub_set_map_by_value(&group.dep_require, &current) {
            let mut existing = Facts::new();
            let mut required = Facts::new();
            for (key, value) in group.dep_require.iter() {
                if current.get(key) != Some(value) {
                    existing.set(key.clone(), current.get(key).cloned().flatten());
                    required.set(key.clone(), value.clone());
                }
            }
            return FactValidationResult::Failure {
                index,
                required_facts: group.dep_require.clone(),
                existing,
                required,
                current_snapshot: current,
            };
        }
        apply_fact_group(group, &mut current);
    }
    FactValidationResult::Success
}

pub fn apply_fact_groups<'a>(
    groups: impl IntoIterator<Item = &'a FactsGroup>,
    snapshot: &mut Facts,
) {
    for group in groups {
        apply_fact_group(group, snapshot);
    }
}

pub fn apply_fact_group(group: &FactsGroup, snapshot: &mut Facts) {
    for (key, value) in group.mod_set.iter() {
        snapshot.set(key.clone(), value.clone());
    }
    for key in group.mod_unset.keys() {
        snapshot.delete(key);
    }
}

/// Whether `a` depends on `b`.
pub fn depends_on(a: &FactsGroup, b: &FactsGroup) -> bool {
    facts_intersect(&a.dep_read, &b.mod_set)
        || facts_intersect(&a.dep_read, &b.mod_unset)
        || facts_intersect(&a.dep_require, &b.mod_set)
        || facts_intersect(&a.dep_require, &b.mod_unset)
}

pub fn replaces_facts(a: &FactsGroup, b: &FactsGroup) -> bool {
    let replaces =
        |x: &Facts, y: &Facts| !x.is_empty() && !y.is_empty() && is_same_map_by_key(x, y);
    let none_or_same =
        |x: &Facts, y: &Facts| x.is_empty() || y.is_empty() || is_same_map_by_key(x, y);
    (replaces(&a.mod_set, &b.mod_set) && none_or_same(&a.mod_unset, &b.mod_unset))
        || (replaces(&a.mod_set, &b.mod_unset) && none_or_same(&a.mod_unset, &b.mod_set))
        || (replaces(&a.mod_unset, &b.mod_set) && none_or_same(&a.mod_set, &b.mod_unset))
        || (replaces(&a.mod_unset, &b.mod_unset) && none_or_same(&a.mod_set, &b.mod_set))
}

pub fn is_same_map_by_key(a: &Facts, b: &Facts) -> bool {
    a.len() == b.len() && a.keys().all(|k| b.has(k))
}

pub fn facts_to_string(facts: &Facts) -> String {
    facts
        .iter()
        .map(|(key, value)| match value {
            None => key.clone(),
            Some(v) => format!("{key}={}", fact_value_to_string(v)),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// JS template-literal rendering of a fact value (strings unquoted).
pub fn fact_value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn facts_intersect(a: &Facts, b: &Facts) -> bool {
    a.keys().any(|k| b.has(k))
}

pub fn get_facts_group_for_event_args(
    callback: Option<&FactsCallback>,
    args: &Value,
    current_facts: &Facts,
) -> FactsGroup {
    let reader = FactsReader {
        facts: current_facts,
        reads: RefCell::new(Facts::new()),
    };
    let res = callback.map(|cb| cb(args, &reader));
    let to_map = |items: Option<&Vec<FactInput>>| {
        items
            .map(|i| i.iter().cloned().collect())
            .unwrap_or_default()
    };
    FactsGroup {
        mod_set: to_map(res.as_ref().and_then(|r| r.set.as_ref())),
        mod_unset: to_map(res.as_ref().and_then(|r| r.unset.as_ref())),
        dep_require: to_map(res.as_ref().and_then(|r| r.require.as_ref())),
        dep_read: reader.reads.into_inner(),
    }
}

pub fn compare_event_sequence_numbers(a: &SeqNum, b: &SeqNum) -> Ordering {
    (a.global, a.client).cmp(&(b.global, b.client))
}

fn is_sub_set_map_by_value(a: &Facts, b: &Facts) -> bool {
    a.iter().all(|(k, v)| b.get(k) == Some(v))
}

use super::facts::replaces_facts;
use super::history_dag::{ConnectionType, HistoryDag, empty_history_dag};

/// `compactEvents`: drops earlier sub-DAGs that a later event's sub-DAG fully replaces.
/// The returned count is always 0, like TS.
pub fn compact_events(input: &HistoryDag) -> (HistoryDag, usize) {
    let mut dag = input.copy();
    let mut ordered = dag.topological_node_ids();
    ordered.reverse();
    ordered.pop();

    for id in ordered {
        if !dag.has_node(&id) {
            continue;
        }
        for sub_dag in make_sub_dags_for_event(&dag, &id) {
            loop {
                let (sub_dags, all_outside) = find_sub_dags_in_history(&dag, &sub_dag, &id);
                for in_history in &sub_dags {
                    if !dag_depends_on_dag(&sub_dag, in_history, &dag) {
                        drop_from_dag(&mut dag, in_history);
                    }
                }
                let retry = all_outside.iter().any(|deps| {
                    deps.iter()
                        .all(|dep| sub_dags.iter().any(|s| s.has_node(dep)))
                });
                if !retry {
                    break;
                }
            }
        }
    }
    (dag, 0)
}

fn make_sub_dags_for_event(input: &HistoryDag, id: &str) -> Vec<HistoryDag> {
    let mut next: Vec<(String, Vec<String>)> = vec![(id.to_owned(), vec![])];
    let mut out: Vec<HistoryDag> = Vec::new();
    while !next.is_empty() {
        let mut sub_dag = out.last().map_or_else(empty_history_dag, HistoryDag::copy);
        for (current, targets) in std::mem::take(&mut next) {
            if !sub_dag.has_node(&current) {
                sub_dag.add_node(&current, input.get_node_attributes(&current).clone());
            }
            for target in &targets {
                sub_dag.add_edge(&current, target, ConnectionType::Facts);
            }
            for dep in input.outbound_edge_entries(&current) {
                if dep.connection == ConnectionType::Facts {
                    match next.iter_mut().find(|(k, _)| *k == dep.target) {
                        Some((_, v)) => v.push(current.clone()),
                        None => next.push((dep.target, vec![current.clone()])),
                    }
                }
            }
        }
        out.push(sub_dag);
    }
    out
}

fn find_sub_dags_in_history(
    input: &HistoryDag,
    target: &HistoryDag,
    up_to_excl: &str,
) -> (Vec<HistoryDag>, Vec<Vec<String>>) {
    let mut sub_dags = Vec::new();
    let mut all_outside = Vec::new();
    for id in input.topological_node_ids() {
        if id == up_to_excl {
            break;
        }
        for sub_dag in make_sub_dags_for_event(input, &id) {
            if sub_dag.size() < target.size() {
                continue;
            }
            let outside = outside_dependencies_for_dag(&sub_dag, input);
            if !outside.is_empty() {
                all_outside.push(outside.clone());
            }
            if outside.is_empty() && dag_replaces_dag(&sub_dag, target) {
                sub_dags.push(sub_dag);
            } else {
                break;
            }
        }
    }
    (sub_dags, all_outside)
}

fn drop_from_dag(dag: &mut HistoryDag, sub_dag: &HistoryDag) {
    for id in sub_dag.nodes() {
        remove_event(dag, &id);
    }
}

fn outside_dependencies_for_dag(sub_dag: &HistoryDag, input: &HistoryDag) -> Vec<String> {
    sub_dag
        .nodes()
        .iter()
        .flat_map(|id| input.outbound_edge_entries(id))
        .filter(|e| e.connection == ConnectionType::Facts && !sub_dag.has_node(&e.target))
        .map(|e| e.target)
        .collect()
}

/// Mirrors TS, which checks the inbound edge's `target` (the node itself) rather than its source.
fn dag_depends_on_dag(a: &HistoryDag, b: &HistoryDag, input: &HistoryDag) -> bool {
    a.nodes().iter().any(|id| {
        input
            .inbound_edge_entries(id)
            .iter()
            .any(|e| e.connection == ConnectionType::Facts && b.has_node(&e.target))
    })
}

fn dag_replaces_dag(a: &HistoryDag, b: &HistoryDag) -> bool {
    a.size() == b.size()
        && a.topological_node_ids()
            .iter()
            .zip(b.topological_node_ids())
            .all(|(x, y)| {
                replaces_facts(
                    &a.get_node_attributes(x).facts_group,
                    &b.get_node_attributes(&y).facts_group,
                )
            })
}

fn remove_event(dag: &mut HistoryDag, id: &str) {
    let event = dag.get_node_attributes(id).clone();
    let parent_id = event.parent_seq_num.to_string();
    for child in dag.outbound_edge_entries(id) {
        if child.connection == ConnectionType::Parent {
            let child_event = dag.get_node_attributes_mut(&child.target);
            child_event.parent_seq_num = event.parent_seq_num;
            let child_id = child_event.seq_num.to_string();
            dag.add_edge(&parent_id, &child_id, ConnectionType::Parent);
        }
    }
    dag.drop_node(id);
}

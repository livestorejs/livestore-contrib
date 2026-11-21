use std::collections::HashMap;
use std::sync::Arc;

use livestore_core::SeqNum;
use livestore_core::next::*;
use serde_json::{Value, json};

#[test]
fn calculator_1_plus_1() {
    assert_eq!(
        compact(&calculator(), &[add(1), add(1)]),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "add", args: { value: 1 }, clientId: "client-id", sessionId: "session-id", facts: "" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "add", args: { value: 1 }, clientId: "client-id", sessionId: "session-id", facts: "" }"#,
        ]
    );
}

#[test]
fn calculator_2_times_2() {
    assert_eq!(
        compact(&calculator(), &[multiply(2), multiply(2)]),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "multiply", args: { value: 2 }, clientId: "client-id", sessionId: "session-id", facts: "?multiplyByZero -multiplyByZero" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "multiply", args: { value: 2 }, clientId: "client-id", sessionId: "session-id", facts: "?multiplyByZero -multiplyByZero" }"#,
        ]
    );
}

#[test]
fn calculator_2_times_2_times_0() {
    assert_eq!(
        compact(&calculator(), &[multiply(2), multiply(2), multiply(0)]),
        [
            r#"{ seqNum: "e3", parentSeqNum: "e0", name: "multiply", args: { value: 0 }, clientId: "client-id", sessionId: "session-id", facts: "+multiplyByZero" }"#,
        ]
    );
}

#[test]
fn calculator_2_times_2_times_0_plus_1() {
    assert_eq!(
        compact(
            &calculator(),
            &[multiply(2), multiply(2), multiply(0), add(1)]
        ),
        [
            r#"{ seqNum: "e3", parentSeqNum: "e0", name: "multiply", args: { value: 0 }, clientId: "client-id", sessionId: "session-id", facts: "+multiplyByZero" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "add", args: { value: 1 }, clientId: "client-id", sessionId: "session-id", facts: "" }"#,
        ]
    );
}

#[test]
fn calculator_1_plus_2_times_0_times_2_plus_1() {
    assert_eq!(
        compact(
            &calculator(),
            &[add(1), multiply(2), multiply(0), multiply(2), add(1)]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "add", args: { value: 1 }, clientId: "client-id", sessionId: "session-id", facts: "" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e1", name: "multiply", args: { value: 0 }, clientId: "client-id", sessionId: "session-id", facts: "+multiplyByZero" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "multiply", args: { value: 2 }, clientId: "client-id", sessionId: "session-id", facts: "?multiplyByZero +multiplyByZero -multiplyByZero" }"#,
            r#"{ seqNum: "e5", parentSeqNum: "e4", name: "add", args: { value: 1 }, clientId: "client-id", sessionId: "session-id", facts: "" }"#,
        ]
    );
}

#[test]
fn todo_completed() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                ev("todoCompleted", json!({"id": "A"})),
                ev("todoCompleted", json!({"id": "A"}))
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e1", name: "todoCompleted", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-completed-A=true" }"#,
        ]
    );
}

#[test]
fn toggle_todo() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                toggle("A"),
                toggle("A"),
                toggle("A")
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "toggleTodo", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ?todo-completed-A +todo-completed-A=true" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e2", name: "toggleTodo", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ?todo-completed-A +todo-completed-A=false" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "toggleTodo", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ?todo-completed-A +todo-completed-A=true" }"#,
        ]
    );
}

#[test]
fn todo_completed_toggle_todo() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                toggle("A"),
                toggle("A"),
                completed("A"),
                completed("A"),
                toggle("A")
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e5", parentSeqNum: "e1", name: "todoCompleted", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-completed-A=true" }"#,
            r#"{ seqNum: "e6", parentSeqNum: "e5", name: "toggleTodo", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ?todo-completed-A +todo-completed-A=false" }"#,
        ]
    );
}

#[test]
fn readonly_set_text_todo() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                set_readonly("A", false),
                set_text("A", "buy soy milk"),
                set_readonly("A", true)
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "setReadonlyTodo", args: { id: "A", readonly: false }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A +todo-is-writeable-A=true" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e2", name: "setTextTodo", args: { id: "A", text: "buy soy milk" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-text-updated-A" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "setReadonlyTodo", args: { id: "A", readonly: true }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A +todo-is-writeable-A=false" }"#,
        ]
    );
}

#[test]
fn readonly_set_text_todo_2() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                set_readonly("A", false),
                completed("A"),
                set_text("A", "buy soy milk"),
                set_readonly("A", true)
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "setReadonlyTodo", args: { id: "A", readonly: false }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A +todo-is-writeable-A=true" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e2", name: "todoCompleted", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-completed-A=true" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "setTextTodo", args: { id: "A", text: "buy soy milk" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-text-updated-A" }"#,
            r#"{ seqNum: "e5", parentSeqNum: "e4", name: "setReadonlyTodo", args: { id: "A", readonly: true }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A +todo-is-writeable-A=false" }"#,
        ]
    );
}

#[test]
fn readonly_set_text_todo_should_fail() {
    let err = try_compact(
        &todo_events(),
        &[
            create_todo("A", "buy milk"),
            set_readonly("A", false),
            set_text("A", "buy soy milk"),
            set_readonly("A", true),
            set_text("A", "buy oat milk"),
        ],
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Event setTextTodo requires facts that have not been set yet.\nRequires: todo-exists-A, todo-is-writeable-A=true\nFacts Snapshot: todo-exists-A, todo-is-writeable-A=false, todo-completed-A=false, todo-text-updated-A"
    );
}

#[test]
fn todo_completeds() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                create_todo("B", "buy bread"),
                create_todo("C", "buy cheese"),
                ev("todoCompleteds", json!({"ids": ["A", "B", "C"]})),
                toggle("A"),
                completed("A"),
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "createTodo", args: { id: "B", text: "buy bread" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-B +todo-is-writeable-B=true +todo-completed-B=false" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e2", name: "createTodo", args: { id: "C", text: "buy cheese" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-C +todo-is-writeable-C=true +todo-completed-C=false" }"#,
            r#"{ seqNum: "e4", parentSeqNum: "e3", name: "todoCompleteds", args: { ids: ["A", "B", "C"] }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ↖todo-exists-B ↖todo-is-writeable-B=true ↖todo-exists-C ↖todo-is-writeable-C=true +todo-completed-A=true +todo-completed-B=true +todo-completed-C=true" }"#,
            r#"{ seqNum: "e6", parentSeqNum: "e4", name: "todoCompleted", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-completed-A=true" }"#,
        ]
    );
}

#[test]
fn todo_completeds_2() {
    assert_eq!(
        compact(
            &todo_events(),
            &[
                create_todo("A", "buy milk"),
                create_todo("B", "buy bread"),
                create_todo("C", "buy cheese"),
                toggle("A"),
                ev("todoCompleteds", json!({"ids": ["A", "B", "C"]})),
                toggle("A"),
                completed("A"),
            ]
        ),
        [
            r#"{ seqNum: "e1", parentSeqNum: "e0", name: "createTodo", args: { id: "A", text: "buy milk" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-A +todo-is-writeable-A=true +todo-completed-A=false" }"#,
            r#"{ seqNum: "e2", parentSeqNum: "e1", name: "createTodo", args: { id: "B", text: "buy bread" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-B +todo-is-writeable-B=true +todo-completed-B=false" }"#,
            r#"{ seqNum: "e3", parentSeqNum: "e2", name: "createTodo", args: { id: "C", text: "buy cheese" }, clientId: "client-id", sessionId: "session-id", facts: "+todo-exists-C +todo-is-writeable-C=true +todo-completed-C=false" }"#,
            r#"{ seqNum: "e5", parentSeqNum: "e3", name: "todoCompleteds", args: { ids: ["A", "B", "C"] }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true ↖todo-exists-B ↖todo-is-writeable-B=true ↖todo-exists-C ↖todo-is-writeable-C=true +todo-completed-A=true +todo-completed-B=true +todo-completed-C=true" }"#,
            r#"{ seqNum: "e7", parentSeqNum: "e5", name: "todoCompleted", args: { id: "A" }, clientId: "client-id", sessionId: "session-id", facts: "↖todo-exists-A ↖todo-is-writeable-A=true +todo-completed-A=true" }"#,
        ]
    );
}

#[test]
fn preserves_parallel_edge_order_and_removes_incident_edges_with_a_node() {
    let mut dag = HistoryDag::create(HistoryDagOptions::default());
    dag.add_node("a", make_node(1));
    dag.add_node("b", make_node(2));
    dag.add_node("c", make_node(3));

    let parent_edge = dag.add_edge("a", "b", ConnectionType::Parent);
    let facts_edge = dag.add_edge("a", "b", ConnectionType::Facts);
    let incoming_edge = dag.add_edge("c", "b", ConnectionType::Facts);

    assert_eq!(dag.edges("a", "b"), [parent_edge, facts_edge]);
    assert_eq!(dag.in_edges("b"), [parent_edge, facts_edge, incoming_edge]);
    assert_eq!(
        dag.inbound_edge_entries("b"),
        [
            entry(parent_edge, "a", "b", ConnectionType::Parent),
            entry(facts_edge, "a", "b", ConnectionType::Facts),
            entry(incoming_edge, "c", "b", ConnectionType::Facts),
        ]
    );
    assert_eq!(
        dag.outbound_edge_entries("a"),
        [
            entry(parent_edge, "a", "b", ConnectionType::Parent),
            entry(facts_edge, "a", "b", ConnectionType::Facts)
        ]
    );
    assert_eq!(dag.source(parent_edge), "a");
    assert_eq!(dag.target(parent_edge), "b");
    assert_eq!(dag.get_edge_attributes(parent_edge), ConnectionType::Parent);

    dag.drop_node("b");

    assert_eq!(dag.edges("a", "b"), Vec::<EdgeIndex>::new());
    assert_eq!(dag.outbound_edge_entries("a"), Vec::<EdgeEntry>::new());
    assert_eq!(dag.outbound_edge_entries("c"), Vec::<EdgeEntry>::new());
}

#[test]
fn keeps_the_adjacency_indexes_consistent_for_self_loops() {
    let mut dag = HistoryDag::create(HistoryDagOptions {
        allow_self_loops: true,
    });
    dag.add_node("a", make_node(1));

    let edge = dag.add_edge("a", "a", ConnectionType::Facts);

    assert_eq!(dag.edges("a", "a"), [edge]);
    assert_eq!(dag.in_edges("a"), [edge]);
    assert_eq!(
        dag.inbound_edge_entries("a"),
        [entry(edge, "a", "a", ConnectionType::Facts)]
    );

    dag.drop_node("a");

    assert_eq!(dag.size(), 0);
    assert_eq!(dag.edges("a", "a"), Vec::<EdgeIndex>::new());
}

#[test]
fn copies_nodes_facts_and_edges_without_sharing_mutable_data() {
    let mut dag = HistoryDag::create(HistoryDagOptions::default());
    let mut node_a = make_node(1);
    node_a.facts_group.mod_set = [("key", Some(json!("value")))].into_iter().collect();
    dag.add_node("a", node_a.clone());
    dag.add_node("b", make_node(2));
    dag.add_edge("a", "b", ConnectionType::Parent);

    let mut copy = dag.copy();
    let copied = copy.get_node_attributes_mut("a");
    assert_eq!(*copied, node_a);
    copied.facts_group.mod_set.set("other", None);
    assert_eq!(
        dag.get_node_attributes("a").facts_group.mod_set,
        node_a.facts_group.mod_set
    );

    let out = copy.outbound_edge_entries("a");
    assert_eq!(out.len(), 1);
    assert_eq!(
        (
            out[0].source.as_str(),
            out[0].target.as_str(),
            out[0].connection
        ),
        ("a", "b", ConnectionType::Parent)
    );
    assert_eq!(
        copy.get_edge_attributes(copy.edges("a", "b")[0]),
        dag.get_edge_attributes(dag.edges("a", "b")[0])
    );
}

struct Def {
    client_only: bool,
    facts: Option<FactsCallback>,
}

type Defs = HashMap<&'static str, Def>;

fn compact(defs: &Defs, events: &[(String, Value)]) -> Vec<String> {
    try_compact(defs, events).unwrap()
}

fn try_compact(defs: &Defs, events: &[(String, Value)]) -> Result<Vec<String>, String> {
    let dag = history_dag_from_nodes(
        &to_event_nodes(events, defs, "client-id", Some("session-id")),
        false,
    )?;
    let (compacted, _) = compact_events(&dag);
    Ok(compacted
        .node_entries()
        .skip(1)
        .map(|(_, n)| print_event(n))
        .collect())
}

fn to_event_nodes(
    events: &[(String, Value)],
    defs: &Defs,
    client_id: &str,
    session_id: Option<&str>,
) -> Vec<HistoryDagNode> {
    let mut acc = vec![root_event_node()];
    let mut current = SeqNum::ROOT;
    for (name, args) in events {
        let def = &defs[name.as_str()];
        let seq_num = current.next_pair(def.client_only, None).0;
        current = seq_num;
        let snapshot = facts_snapshot_for_dag(&history_dag_from_nodes(&acc, true).unwrap(), None);
        acc.push(HistoryDagNode {
            seq_num,
            parent_seq_num: parent_num(seq_num),
            name: name.clone(),
            args: args.clone(),
            facts_group: get_facts_group_for_event_args(def.facts.as_ref(), args, &snapshot),
            meta: None,
            client_id: client_id.into(),
            session_id: session_id.map(Into::into),
        });
    }
    acc
}

fn parent_num(n: SeqNum) -> SeqNum {
    if n.client - 1 < 0 {
        SeqNum::new(n.global - 1, 0, 0)
    } else {
        SeqNum::new(n.global, n.client - 1, 0)
    }
}

fn print_event(n: &HistoryDagNode) -> String {
    format!(
        "{{ seqNum: \"{}\", parentSeqNum: \"{}\", name: \"{}\", args: {}, clientId: \"{}\", sessionId: {}, facts: \"{}\" }}",
        n.seq_num,
        n.parent_seq_num,
        n.name,
        stringify(&n.args),
        n.client_id,
        n.session_id
            .as_ref()
            .map_or("undefined".into(), |s| format!("\"{s}\"")),
        print_facts(&n.facts_group)
    )
}

fn stringify(v: &Value) -> String {
    match v {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stringify).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => {
            format!(
                "{{ {} }}",
                map.iter()
                    .map(|(k, v)| format!("{k}: {}", stringify(v)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        other => other.to_string(),
    }
}

fn print_facts(g: &FactsGroup) -> String {
    [
        (&g.dep_require, "↖"),
        (&g.dep_read, "?"),
        (&g.mod_set, "+"),
        (&g.mod_unset, "-"),
    ]
    .iter()
    .flat_map(|(facts, prefix)| {
        facts.iter().map(move |(k, v)| match v {
            None => format!("{prefix}{k}"),
            Some(v) => format!("{prefix}{k}={}", fact_value_to_string(v)),
        })
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn calculator() -> Defs {
    let multiply = |args: &Value, current: &FactsReader| {
        let zero = args["value"] == json!(0);
        FactsCallbackResult {
            set: Some(if zero || current.has("multiplyByZero") {
                vec![fact("multiplyByZero")]
            } else {
                vec![]
            }),
            unset: Some(if zero {
                vec![]
            } else {
                vec![fact("multiplyByZero")]
            }),
            ..Default::default()
        }
    };
    HashMap::from([
        ("add", def(None)),
        ("multiply", def(Some(Arc::new(multiply)))),
    ])
}

fn todo_events() -> Defs {
    let exists = |id: &str| fact(&format!("todo-exists-{id}"));
    let writeable = |id: &str, w: bool| (format!("todo-is-writeable-{id}"), Some(json!(w)));
    let completed = |id: &str, c: bool| (format!("todo-completed-{id}"), Some(json!(c)));
    let id = |args: &Value| args["id"].as_str().unwrap().to_owned();
    HashMap::from([
        (
            "createTodo",
            def(Some(Arc::new(move |a: &Value, _: &FactsReader| {
                let id = id(a);
                FactsCallbackResult {
                    set: Some(vec![
                        exists(&id),
                        writeable(&id, true),
                        completed(&id, false),
                    ]),
                    ..Default::default()
                }
            }))),
        ),
        (
            "todoCompleted",
            def(Some(Arc::new(move |a: &Value, _: &FactsReader| {
                let id = id(a);
                FactsCallbackResult {
                    require: Some(vec![exists(&id), writeable(&id, true)]),
                    set: Some(vec![completed(&id, true)]),
                    ..Default::default()
                }
            }))),
        ),
        (
            "todoCompleteds",
            def(Some(Arc::new(move |a: &Value, _: &FactsReader| {
                let ids: Vec<String> = a["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect();
                FactsCallbackResult {
                    require: Some(
                        ids.iter()
                            .flat_map(|id| [exists(id), writeable(id, true)])
                            .collect(),
                    ),
                    set: Some(ids.iter().map(|id| completed(id, true)).collect()),
                    ..Default::default()
                }
            }))),
        ),
        (
            "toggleTodo",
            def(Some(Arc::new(move |a: &Value, current: &FactsReader| {
                let id = id(a);
                let is_completed =
                    current.get(&format!("todo-completed-{id}")) == Some(Some(json!(true)));
                FactsCallbackResult {
                    require: Some(vec![exists(&id), writeable(&id, true)]),
                    set: Some(vec![completed(&id, !is_completed)]),
                    ..Default::default()
                }
            }))),
        ),
        (
            "setReadonlyTodo",
            def(Some(Arc::new(move |a: &Value, _: &FactsReader| {
                let id = id(a);
                FactsCallbackResult {
                    require: Some(vec![exists(&id)]),
                    set: Some(vec![writeable(&id, !a["readonly"].as_bool().unwrap())]),
                    ..Default::default()
                }
            }))),
        ),
        (
            "setTextTodo",
            def(Some(Arc::new(move |a: &Value, _: &FactsReader| {
                let id = id(a);
                FactsCallbackResult {
                    require: Some(vec![exists(&id), writeable(&id, true)]),
                    set: Some(vec![fact(&format!("todo-text-updated-{id}"))]),
                    ..Default::default()
                }
            }))),
        ),
    ])
}

fn def(facts: Option<FactsCallback>) -> Def {
    Def {
        client_only: false,
        facts,
    }
}

fn fact(key: &str) -> FactInput {
    (key.to_owned(), None)
}

fn ev(name: &str, args: Value) -> (String, Value) {
    (name.to_owned(), args)
}

fn add(value: i64) -> (String, Value) {
    ev("add", json!({ "value": value }))
}

fn multiply(value: i64) -> (String, Value) {
    ev("multiply", json!({ "value": value }))
}

fn create_todo(id: &str, text: &str) -> (String, Value) {
    ev("createTodo", json!({ "id": id, "text": text }))
}

fn completed(id: &str) -> (String, Value) {
    ev("todoCompleted", json!({ "id": id }))
}

fn toggle(id: &str) -> (String, Value) {
    ev("toggleTodo", json!({ "id": id }))
}

fn set_readonly(id: &str, readonly: bool) -> (String, Value) {
    ev("setReadonlyTodo", json!({ "id": id, "readonly": readonly }))
}

fn set_text(id: &str, text: &str) -> (String, Value) {
    ev("setTextTodo", json!({ "id": id, "text": text }))
}

fn make_node(global: i64) -> HistoryDagNode {
    HistoryDagNode {
        seq_num: SeqNum::new(global, 0, 0),
        parent_seq_num: SeqNum::new(global - 1, 0, 0),
        name: format!("event-{global}"),
        args: json!({}),
        facts_group: FactsGroup::default(),
        meta: None,
        client_id: "client-id".into(),
        session_id: Some("session-id".into()),
    }
}

fn entry(edge: EdgeIndex, source: &str, target: &str, connection: ConnectionType) -> EdgeEntry {
    EdgeEntry {
        edge,
        source: source.into(),
        target: target.into(),
        connection,
    }
}

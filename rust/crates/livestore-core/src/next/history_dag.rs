use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::SeqNum;

use super::facts::{FactValidationResult, Facts, FactsGroup, facts_to_string, validate_facts};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionType {
    Parent,
    Facts,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryDagNode {
    pub seq_num: SeqNum,
    pub parent_seq_num: SeqNum,
    pub name: String,
    pub args: Value,
    pub facts_group: FactsGroup,
    pub meta: Option<Value>,
    pub client_id: String,
    pub session_id: Option<String>,
}

pub type EdgeIndex = usize;

#[derive(Clone, Debug, PartialEq)]
pub struct EdgeEntry {
    pub edge: EdgeIndex,
    pub source: String,
    pub target: String,
    pub connection: ConnectionType,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HistoryDagOptions {
    pub allow_self_loops: bool,
}

struct Edge {
    source: usize,
    target: usize,
    connection: ConnectionType,
}

struct NodeSlot {
    id: String,
    node: HistoryDagNode,
    incoming: Vec<EdgeIndex>,
    outgoing: Vec<EdgeIndex>,
}

/// Mutable DAG keyed by string node ids. Node and edge indices are never reused, and iteration follows
/// insertion order like the Effect graph behind the TS `HistoryDag`.
#[derive(Default)]
pub struct HistoryDag {
    options: HistoryDagOptions,
    nodes: Vec<Option<NodeSlot>>,
    edges: Vec<Option<Edge>>,
    id_to_index: HashMap<String, usize>,
}

impl HistoryDag {
    pub fn create(options: HistoryDagOptions) -> Self {
        Self {
            options,
            ..Default::default()
        }
    }

    pub fn copy(&self) -> HistoryDag {
        let mut clone = HistoryDag::create(self.options);
        for slot in self.nodes.iter().flatten() {
            clone.add_node(&slot.id, slot.node.clone());
        }
        for edge in self.edges.iter().flatten() {
            clone.add_edge(
                &self.id_at(edge.source),
                &self.id_at(edge.target),
                edge.connection,
            );
        }
        clone
    }

    /// Kahn's algorithm with a FIFO queue seeded in node order, like Effect's `Graph.topo`.
    pub fn topological_node_ids(&self) -> Vec<String> {
        let mut in_degree: HashMap<usize, usize> = self
            .live_nodes()
            .map(|(i, s)| (i, s.incoming.len()))
            .collect();
        let mut queue: VecDeque<usize> = self
            .live_nodes()
            .filter(|(_, s)| s.incoming.is_empty())
            .map(|(i, _)| i)
            .collect();
        let mut out = Vec::new();
        while let Some(current) = queue.pop_front() {
            out.push(self.id_at(current));
            for &e in &self.slot(current).outgoing {
                let target = self.edge(e).target;
                let degree = in_degree.get_mut(&target).unwrap();
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
        assert_eq!(
            out.len(),
            self.size(),
            "Cannot perform topological sort on cyclic graph"
        );
        out
    }

    pub fn add_node(&mut self, id: &str, node: HistoryDagNode) {
        assert!(!self.has_node(id), "HistoryDag node {id} already exists");
        self.id_to_index.insert(id.to_owned(), self.nodes.len());
        self.nodes.push(Some(NodeSlot {
            id: id.to_owned(),
            node,
            incoming: vec![],
            outgoing: vec![],
        }));
    }

    pub fn has_node(&self, id: &str) -> bool {
        self.id_to_index.contains_key(id)
    }

    pub fn get_node_attributes(&self, id: &str) -> &HistoryDagNode {
        &self.slot(self.index(id)).node
    }

    pub fn get_node_attributes_mut(&mut self, id: &str) -> &mut HistoryDagNode {
        let index = self.index(id);
        &mut self.nodes[index].as_mut().unwrap().node
    }

    pub fn nodes(&self) -> Vec<String> {
        self.live_nodes().map(|(_, s)| s.id.clone()).collect()
    }

    pub fn node_entries(&self) -> impl Iterator<Item = (&str, &HistoryDagNode)> {
        self.live_nodes().map(|(_, s)| (s.id.as_str(), &s.node))
    }

    pub fn add_edge(
        &mut self,
        source: &str,
        target: &str,
        connection: ConnectionType,
    ) -> EdgeIndex {
        assert!(
            self.options.allow_self_loops || source != target,
            "HistoryDag self-loops are disabled"
        );
        let (s, t) = match (self.id_to_index.get(source), self.id_to_index.get(target)) {
            (Some(&s), Some(&t)) => (s, t),
            _ => panic!("HistoryDag edge references unknown nodes: {source} -> {target}"),
        };
        let e = self.edges.len();
        self.edges.push(Some(Edge {
            source: s,
            target: t,
            connection,
        }));
        self.nodes[s].as_mut().unwrap().outgoing.push(e);
        self.nodes[t].as_mut().unwrap().incoming.push(e);
        e
    }

    pub fn edges(&self, source: &str, target: &str) -> Vec<EdgeIndex> {
        let (Some(&s), Some(&t)) = (self.id_to_index.get(source), self.id_to_index.get(target))
        else {
            return vec![];
        };
        self.slot(s)
            .outgoing
            .iter()
            .copied()
            .filter(|&e| self.edge(e).target == t)
            .collect()
    }

    pub fn in_edges(&self, id: &str) -> Vec<EdgeIndex> {
        self.id_to_index
            .get(id)
            .map_or_else(Vec::new, |&i| self.slot(i).incoming.clone())
    }

    pub fn outbound_edge_entries(&self, id: &str) -> Vec<EdgeEntry> {
        self.id_to_index
            .get(id)
            .map_or_else(Vec::new, |&i| self.entries(&self.slot(i).outgoing))
    }

    pub fn inbound_edge_entries(&self, id: &str) -> Vec<EdgeEntry> {
        self.id_to_index
            .get(id)
            .map_or_else(Vec::new, |&i| self.entries(&self.slot(i).incoming))
    }

    pub fn get_edge_attributes(&self, edge: EdgeIndex) -> ConnectionType {
        self.edge(edge).connection
    }

    pub fn source(&self, edge: EdgeIndex) -> String {
        self.id_at(self.edge(edge).source)
    }

    pub fn target(&self, edge: EdgeIndex) -> String {
        self.id_at(self.edge(edge).target)
    }

    pub fn drop_node(&mut self, id: &str) {
        let Some(index) = self.id_to_index.remove(id) else {
            return;
        };
        let slot = self.nodes[index].take().unwrap();
        for e in slot.outgoing.iter().chain(&slot.incoming) {
            let Some(edge) = self.edges[*e].take() else {
                continue;
            };
            for (n, outgoing) in [(edge.target, false), (edge.source, true)] {
                if let Some(other) = self.nodes[n].as_mut() {
                    let list = if outgoing {
                        &mut other.outgoing
                    } else {
                        &mut other.incoming
                    };
                    list.retain(|x| x != e);
                }
            }
        }
    }

    pub fn size(&self) -> usize {
        self.id_to_index.len()
    }

    fn live_nodes(&self) -> impl Iterator<Item = (usize, &NodeSlot)> {
        self.nodes
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|s| (i, s)))
    }

    fn entries(&self, edges: &[EdgeIndex]) -> Vec<EdgeEntry> {
        edges
            .iter()
            .map(|&e| EdgeEntry {
                edge: e,
                source: self.source(e),
                target: self.target(e),
                connection: self.edge(e).connection,
            })
            .collect()
    }

    fn index(&self, id: &str) -> usize {
        *self
            .id_to_index
            .get(id)
            .unwrap_or_else(|| panic!("HistoryDag node {id} not found"))
    }

    fn slot(&self, index: usize) -> &NodeSlot {
        self.nodes[index]
            .as_ref()
            .expect("HistoryDag node data missing")
    }

    fn edge(&self, e: EdgeIndex) -> &Edge {
        self.edges[e]
            .as_ref()
            .unwrap_or_else(|| panic!("HistoryDag edge {e} not found"))
    }

    fn id_at(&self, index: usize) -> String {
        self.slot(index).id.clone()
    }
}

pub fn empty_history_dag() -> HistoryDag {
    HistoryDag::create(HistoryDagOptions {
        allow_self_loops: false,
    })
}

pub const ROOT_PARENT_NUM: SeqNum = SeqNum {
    global: -1,
    client: 0,
    rebase_generation: 0,
};

pub fn root_event_node() -> HistoryDagNode {
    HistoryDagNode {
        seq_num: SeqNum::ROOT,
        parent_seq_num: ROOT_PARENT_NUM,
        name: "__Root__".into(),
        args: Value::Object(Default::default()),
        facts_group: FactsGroup::default(),
        meta: None,
        client_id: "root".into(),
        session_id: None,
    }
}

/// `historyDagFromNodes`; the error string matches the TS thrown message.
pub fn history_dag_from_nodes(
    nodes: &[HistoryDagNode],
    skip_facts_check: bool,
) -> Result<HistoryDag, String> {
    if !skip_facts_check {
        let groups: Vec<&FactsGroup> = nodes.iter().map(|n| &n.facts_group).collect();
        if let FactValidationResult::Failure {
            index,
            required_facts,
            current_snapshot,
            ..
        } = validate_facts(&groups, &Facts::new())
        {
            return Err(format!(
                "Event {} requires facts that have not been set yet.\nRequires: {}\nFacts Snapshot: {}",
                nodes[index].name,
                facts_to_string(&required_facts),
                facts_to_string(&current_snapshot)
            ));
        }
    }

    let mut dag = empty_history_dag();
    for node in nodes {
        dag.add_node(&node.seq_num.to_string(), node.clone());
    }
    let root_parent = ROOT_PARENT_NUM.to_string();
    for node in nodes {
        if node.parent_seq_num.to_string() != root_parent {
            dag.add_edge(
                &node.parent_seq_num.to_string(),
                &node.seq_num.to_string(),
                ConnectionType::Parent,
            );
        }
    }
    for node in nodes {
        let node_id = node.seq_num.to_string();
        for fact_key in node
            .facts_group
            .dep_require
            .keys()
            .chain(node.facts_group.dep_read.keys())
        {
            let mut current = node_id.clone();
            let mut dep = None;
            while current != root_parent {
                let Some(parent_edge) = dag
                    .in_edges(&current)
                    .into_iter()
                    .find(|&e| dag.get_edge_attributes(e) == ConnectionType::Parent)
                else {
                    break;
                };
                let parent_id = dag.source(parent_edge);
                let parent = dag.get_node_attributes(&parent_id);
                if parent.facts_group.mod_set.has(fact_key)
                    || parent.facts_group.mod_unset.has(fact_key)
                {
                    dep = Some(parent.seq_num.to_string());
                    break;
                }
                current = parent_id;
            }
            if let Some(dep_id) = dep
                && !dag
                    .edges(&dep_id, &node_id)
                    .iter()
                    .any(|&e| dag.get_edge_attributes(e) == ConnectionType::Facts)
            {
                dag.add_edge(&dep_id, &node_id, ConnectionType::Facts);
            }
        }
    }
    Ok(dag)
}

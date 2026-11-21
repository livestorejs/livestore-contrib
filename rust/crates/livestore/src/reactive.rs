//! `reactive.ts`: refs, thunks and effects with automatic dependency tracking, eager dirty marking,
//! lazy recomputation with equality cutoff, deferred effects and debug refresh infos.
//!
//! Nodes live in an arena behind one mutex; user closures always run with the lock released, so a
//! thunk or effect may read other atoms, create nodes or set refs (nested `run_effects`), like in TS.

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

/// Values held by refs and thunks. `PartialEq` is the default `equal` (TS `deepEqual`), `Serialize`
/// renders `previousResult` in snapshots.
pub trait GraphValue: Clone + PartialEq + Serialize + Send + Sync + 'static {}
impl<T: Clone + PartialEq + Serialize + Send + Sync + 'static> GraphValue for T {}

/// `DebugRefreshReason`: `runDeferredEffects`, `makeThunk`, `unknown`, or a caller-defined tag with data.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum RefreshReason {
    #[serde(rename = "runDeferredEffects", rename_all = "camelCase")]
    RunDeferredEffects {
        original_refresh_reasons: Vec<RefreshReason>,
        manual_refresh_reason: Option<Box<RefreshReason>>,
    },
    #[serde(rename = "makeThunk")]
    MakeThunk { label: Option<String> },
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(untagged)]
    Other { tag: String, data: Value },
}

impl RefreshReason {
    #[must_use]
    pub fn tagged(tag: &str) -> Self {
        RefreshReason::Other {
            tag: tag.into(),
            data: Value::Null,
        }
    }

    /// The `livestore.debugRefreshReason` span attribute: the reason's `label` if it has one, else its tag.
    pub fn trace_label(&self) -> Option<&str> {
        match self {
            RefreshReason::MakeThunk { label } => label.as_deref(),
            RefreshReason::Other { tag, data } => {
                Some(data.get("label").and_then(Value::as_str).unwrap_or(tag))
            }
            other => Some(other.tag()),
        }
    }

    #[must_use]
    pub fn tag(&self) -> &str {
        match self {
            RefreshReason::RunDeferredEffects { .. } => "runDeferredEffects",
            RefreshReason::MakeThunk { .. } => "makeThunk",
            RefreshReason::Unknown => "unknown",
            RefreshReason::Other { tag, .. } => tag,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum NodeKind {
    #[serde(rename = "ref")]
    Ref,
    #[serde(rename = "thunk")]
    Thunk,
    #[serde(rename = "effect")]
    Effect,
}

impl fmt::Display for NodeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            NodeKind::Ref => "ref",
            NodeKind::Thunk => "thunk",
            NodeKind::Effect => "effect",
        })
    }
}

/// `SerializedAtom` / `SerializedEffect`. `counter` is `refreshes` (ref), `recomputations` (thunk) or
/// `invocations` (effect). `previous_result` is `None` unless results were requested.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedNode {
    #[serde(rename = "_tag")]
    pub kind: NodeKind,
    pub id: String,
    pub label: Option<String>,
    pub meta: Option<Value>,
    pub is_dirty: bool,
    pub is_destroyed: bool,
    pub counter: u64,
    pub previous_result: Option<String>,
    pub sub: Vec<String>,
    #[serde(rename = "super")]
    pub sup: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub atoms: Vec<SerializedNode>,
    pub effects: Vec<SerializedNode>,
    pub deferred_effects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomDebugInfo {
    pub atom: SerializedNode,
    pub result_changed: bool,
    pub debug_info: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshDebugInfo {
    pub id: String,
    pub reason: RefreshReason,
    pub refreshed_atoms: Vec<AtomDebugInfo>,
    pub skipped_refresh: bool,
    pub duration_ms: f64,
    pub graph_snapshot: GraphSnapshot,
}

/// A custom equality for a node's results (`equal` option).
pub type EqualBy<T> = Arc<dyn Fn(&T, &T) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct RefOptions<T> {
    pub label: Option<String>,
    pub meta: Option<Value>,
    pub equal: Option<EqualBy<T>>,
}

impl<T> Default for RefOptions<T> {
    fn default() -> Self {
        Self {
            label: None,
            meta: None,
            equal: None,
        }
    }
}

impl<T> RefOptions<T> {
    #[must_use]
    pub fn label(label: &str) -> Self {
        Self {
            label: Some(label.into()),
            ..Self::default()
        }
    }
}

pub type ThunkOptions<T> = RefOptions<T>;

#[derive(Clone, Default)]
pub struct SetRefOptions {
    pub skip_refresh: bool,
    pub debug_refresh_reason: Option<RefreshReason>,
}

pub type EffectsWrapper = Arc<dyn Fn(&mut dyn FnMut()) + Send + Sync>;

static GRAPH_IDS: AtomicU64 = AtomicU64::new(0);
const MAX_REFRESH_INFOS: usize = 200;

/// `ReactiveGraph`. Cheap to clone; all clones share the same nodes.
pub struct ReactiveGraph<C = ()> {
    shared: Arc<Shared<C>>,
}

impl<C> Clone for ReactiveGraph<C> {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
        }
    }
}

impl<C: Clone + Send + Sync + 'static> Default for ReactiveGraph<C> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C: Clone + Send + Sync + 'static> ReactiveGraph<C> {
    pub fn new() -> Self {
        let id = format!("graph-{}", GRAPH_IDS.fetch_add(1, Ordering::Relaxed) + 1);
        Self {
            shared: Arc::new(Shared {
                id,
                state: Mutex::new(State::default()),
            }),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.shared.id
    }

    pub fn set_context(&self, context: C) {
        self.shared.lock().context = Some(context);
    }

    #[must_use]
    pub fn context(&self) -> Option<C> {
        self.shared.lock().context.clone()
    }

    /// `context.effectsWrapper` (e.g. a UI framework's batched updates).
    pub fn set_effects_wrapper(&self, wrapper: EffectsWrapper) {
        self.shared.lock().effects_wrapper = Some(wrapper);
    }

    pub fn make_ref<T: GraphValue>(&self, value: T, options: RefOptions<T>) -> Ref<T, C> {
        let mut node = Node::new(NodeKind::Ref, options.label, options.meta);
        node.value = Some(Arc::new(value));
        node.equal = Some(erase_equal(options.equal));
        node.to_json = Some(erase_to_json::<T>());
        let id = self.shared.insert(node);
        Ref {
            graph: self.clone(),
            id,
            _t: PhantomData,
        }
    }

    pub fn make_thunk<T: GraphValue>(
        &self,
        f: impl Fn(&Get<C>) -> T + Send + Sync + 'static,
        options: ThunkOptions<T>,
    ) -> Thunk<T, C> {
        let mut node = Node::new(NodeKind::Thunk, options.label, options.meta);
        node.dirty = true;
        node.equal = Some(erase_equal(options.equal));
        node.to_json = Some(erase_to_json::<T>());
        node.thunk_fn = Some(Arc::new(move |get: &Get<C>| Arc::new(f(get)) as AnyVal));
        let id = self.shared.insert(node);
        Thunk {
            graph: self.clone(),
            id,
            _t: PhantomData,
        }
    }

    pub fn make_effect(
        &self,
        f: impl Fn(&Get<C>) + Send + Sync + 'static,
        label: Option<&str>,
    ) -> Effect<C> {
        let mut node = Node::new(NodeKind::Effect, label.map(Into::into), None);
        node.effect_fn = Some(Arc::new(f));
        let id = self.shared.insert(node);
        Effect {
            graph: self.clone(),
            id,
        }
    }

    pub fn set_ref<T: GraphValue>(&self, r: &Ref<T, C>, value: T, options: SetRefOptions) {
        self.set_refs(vec![(r, value)], options);
    }

    pub fn set_refs<T: GraphValue>(&self, refs: Vec<(&Ref<T, C>, T)>, options: SetRefOptions) {
        let mut effects = Vec::new();
        {
            let mut s = self.shared.lock();
            for (r, value) in refs {
                let node = s.node_mut(r.id);
                node.value = Some(Arc::new(value));
                node.counter += 1;
                s.mark_super_dirty(r.id, &mut effects);
            }
            if options.skip_refresh {
                for effect in &effects {
                    let i = s
                        .deferred
                        .iter()
                        .position(|(e, _)| e == effect)
                        .unwrap_or_else(|| {
                            s.deferred.push((*effect, vec![]));
                            s.deferred.len() - 1
                        });
                    let entry = &mut s.deferred[i].1;
                    if let Some(reason) = &options.debug_refresh_reason
                        && !entry.contains(reason)
                    {
                        entry.push(reason.clone());
                    }
                }
                return;
            }
        }
        self.run_effects(
            &effects,
            &options
                .debug_refresh_reason
                .unwrap_or(RefreshReason::Unknown),
        );
    }

    pub fn run_deferred_effects(&self, manual_refresh_reason: Option<&RefreshReason>) {
        let mut i = 0;
        loop {
            let Some((effect, reasons)) = self.shared.lock().deferred.get(i).cloned() else {
                break;
            };
            let reason = RefreshReason::RunDeferredEffects {
                original_refresh_reasons: reasons,
                manual_refresh_reason: manual_refresh_reason.cloned().map(Box::new),
            };
            self.run_effects(&[effect], &reason);
            i += 1;
        }
    }

    /// Destroys the node and, recursively, everything downstream of it.
    pub fn destroy_node(&self, node: &impl NodeHandle) {
        self.destroy_by_id(node.node_id());
    }

    pub fn destroy(&self) {
        let atoms: Vec<usize> = self.shared.lock().atoms.iter().copied().collect();
        for id in atoms {
            self.destroy_by_id(id);
        }
    }

    pub fn add_edge(&self, sup: &impl NodeHandle, sub: &impl NodeHandle) {
        self.shared.add_edge(sup.node_id(), sub.node_id());
    }

    pub fn remove_edge(&self, sup: &impl NodeHandle, sub: &impl NodeHandle) {
        self.shared.remove_edge(sup.node_id(), sub.node_id());
    }

    /// Ids of the nodes depending on `node` (TS `node.super`).
    pub fn super_of(&self, node: &impl NodeHandle) -> Vec<NodeId> {
        self.shared
            .lock()
            .node(node.node_id())
            .sup
            .iter()
            .map(|id| NodeId(*id))
            .collect()
    }

    pub fn subscribe_to_refresh(
        &self,
        cb: impl Fn() + Send + Sync + 'static,
    ) -> impl FnOnce() + Send + Sync + 'static {
        let mut s = self.shared.lock();
        s.next_callback += 1;
        let key = s.next_callback;
        s.callbacks.push((key, Arc::new(cb)));
        let shared = self.shared.clone();
        move || shared.lock().callbacks.retain(|(k, _)| *k != key)
    }

    #[must_use]
    pub fn snapshot(&self, include_results: bool) -> GraphSnapshot {
        self.shared.lock().snapshot(include_results)
    }

    #[must_use]
    pub fn debug_refresh_infos(&self) -> Vec<RefreshDebugInfo> {
        self.shared.lock().infos.iter().cloned().collect()
    }

    pub fn clear_debug_refresh_infos(&self) {
        self.shared.lock().infos.clear();
    }

    /// `graph.atoms.size`.
    #[must_use]
    pub fn atom_count(&self) -> usize {
        self.shared.lock().atoms.len()
    }

    /// Ids of all live atoms with their labels, in creation order.
    #[must_use]
    pub fn atoms(&self) -> Vec<(NodeId, NodeKind, Option<String>)> {
        let s = self.shared.lock();
        s.atoms
            .iter()
            .map(|id| (NodeId(*id), s.node(*id).kind, s.node(*id).label.clone()))
            .collect()
    }

    fn destroy_by_id(&self, id: usize) {
        let (kind, sup, sub) = {
            let s = self.shared.lock();
            let n = s.node(id);
            (n.kind, n.sup.clone(), n.sub.clone())
        };
        if kind != NodeKind::Effect {
            for sup in sup {
                self.destroy_by_id(sup);
            }
        }
        if kind != NodeKind::Ref {
            for sub in sub {
                self.shared.remove_edge(id, sub);
            }
        }
        let mut s = self.shared.lock();
        let effect_fn = if kind == NodeKind::Effect {
            s.deferred.retain(|(e, _)| *e != id);
            s.effects.remove(&id);
            s.node_mut(id).effect_fn.take()
        } else {
            s.atoms.remove(&id);
            None
        };
        s.node_mut(id).destroyed = true;
        drop(s);
        // Release what the effect captured (e.g. a subscription's span) with the node, not with the graph.
        drop(effect_fn);
    }

    fn run_effects(&self, effects: &[usize], reason: &RefreshReason) {
        let wrapper = self.shared.lock().effects_wrapper.clone();
        let mut run = || {
            let local = Arc::new(Mutex::new(Frame::new()));
            let previous = self.shared.lock().current.replace(local.clone());
            let restore = RestoreFrame {
                shared: &self.shared,
                previous,
            };
            for effect in effects {
                self.shared.do_effect(*effect, Some(reason.clone()));
            }
            drop(restore);
            let refreshed_atoms = std::mem::take(&mut lock(&local).refreshed_atoms);
            let duration_ms = lock(&local).elapsed_ms();
            self.shared
                .push_info(reason.clone(), refreshed_atoms, duration_ms);
            self.shared.run_callbacks();
        };
        match wrapper {
            Some(wrapper) => wrapper(&mut run),
            None => run(),
        }
    }
}

/// Opaque node id (`node-<n>` in snapshots).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeId(usize);

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "node-{}", self.0)
    }
}

pub trait NodeHandle {
    fn node_id(&self) -> usize;
}

impl NodeHandle for NodeId {
    fn node_id(&self) -> usize {
        self.0
    }
}

/// An atom that can be read through [`Get`].
pub trait Atom<T>: NodeHandle {}

pub struct Ref<T, C = ()> {
    graph: ReactiveGraph<C>,
    id: usize,
    _t: PhantomData<fn() -> T>,
}

pub struct Thunk<T, C = ()> {
    graph: ReactiveGraph<C>,
    id: usize,
    _t: PhantomData<fn() -> T>,
}

pub struct Effect<C = ()> {
    graph: ReactiveGraph<C>,
    id: usize,
}

macro_rules! handle_impls {
    ($ty:ident) => {
        impl<T, C> Clone for $ty<T, C> {
            fn clone(&self) -> Self {
                Self {
                    graph: self.graph.clone(),
                    id: self.id,
                    _t: PhantomData,
                }
            }
        }
        impl<T, C> NodeHandle for $ty<T, C> {
            fn node_id(&self) -> usize {
                self.id
            }
        }
        impl<T, C> Atom<T> for $ty<T, C> {}
        impl<T: GraphValue, C: Clone + Send + Sync + 'static> $ty<T, C> {
            /// `computeResult()`.
            pub fn compute_result(&self) -> T {
                self.compute_result_with(None)
            }
            pub fn compute_result_with(&self, reason: Option<RefreshReason>) -> T {
                downcast(&self.graph.shared.compute_result(self.id, reason))
            }
            pub fn id(&self) -> NodeId {
                NodeId(self.id)
            }
            pub fn label(&self) -> Option<String> {
                self.graph.shared.lock().node(self.id).label.clone()
            }
            pub fn is_dirty(&self) -> bool {
                self.graph.shared.lock().node(self.id).dirty
            }
            pub fn is_destroyed(&self) -> bool {
                self.graph.shared.lock().node(self.id).destroyed
            }
        }
    };
}

handle_impls!(Ref);
handle_impls!(Thunk);

impl<T: GraphValue, C: Clone + Send + Sync + 'static> Ref<T, C> {
    #[must_use]
    pub fn refreshes(&self) -> u64 {
        self.graph.shared.lock().node(self.id).counter
    }
}

impl<T: GraphValue, C: Clone + Send + Sync + 'static> Thunk<T, C> {
    #[must_use]
    pub fn recomputations(&self) -> u64 {
        self.graph.shared.lock().node(self.id).counter
    }
}

impl<C> Clone for Effect<C> {
    fn clone(&self) -> Self {
        Self {
            graph: self.graph.clone(),
            id: self.id,
        }
    }
}

impl<C> NodeHandle for Effect<C> {
    fn node_id(&self) -> usize {
        self.id
    }
}

impl<C: Clone + Send + Sync + 'static> Effect<C> {
    /// `doEffect()`.
    pub fn do_effect(&self) {
        self.do_effect_with(None);
    }

    pub fn do_effect_with(&self, reason: Option<RefreshReason>) {
        self.graph.shared.do_effect(self.id, reason);
    }

    #[must_use]
    pub fn id(&self) -> NodeId {
        NodeId(self.id)
    }

    #[must_use]
    pub fn invocations(&self) -> u64 {
        self.graph.shared.lock().node(self.id).counter
    }

    #[must_use]
    pub fn is_destroyed(&self) -> bool {
        self.graph.shared.lock().node(self.id).destroyed
    }
}

/// The getter handed to thunks and effects: reading an atom records a dependency edge.
pub struct Get<'a, C> {
    shared: &'a Shared<C>,
    owner: usize,
    reason: Option<RefreshReason>,
    context: Option<C>,
    debug_info: Mutex<Option<Value>>,
}

impl<C: Clone + Send + Sync + 'static> Get<'_, C> {
    pub fn get<T: GraphValue>(&self, atom: &impl Atom<T>) -> T {
        self.get_with(atom, None)
    }

    pub fn get_with<T: GraphValue>(&self, atom: &impl Atom<T>, reason: Option<RefreshReason>) -> T {
        self.shared.add_edge(self.owner, atom.node_id());
        downcast(
            &self
                .shared
                .compute_node(atom.node_id(), reason.or_else(|| self.reason.clone())),
        )
    }

    /// The graph context (thunks only; always set there).
    ///
    /// # Panics
    ///
    /// Panics when called outside a thunk, where no context is set.
    pub fn context(&self) -> &C {
        self.context
            .as_ref()
            .expect("context is checked before a thunk runs")
    }

    pub fn try_context(&self) -> Option<&C> {
        self.context.as_ref()
    }

    pub fn debug_refresh_reason(&self) -> Option<&RefreshReason> {
        self.reason.as_ref()
    }

    pub fn set_debug_info(&self, info: Value) {
        *lock(&self.debug_info) = Some(info);
    }
}

type AnyVal = Arc<dyn Any + Send + Sync>;
type ThunkFn<C> = Arc<dyn Fn(&Get<C>) -> AnyVal + Send + Sync>;
type EffectFn<C> = Arc<dyn Fn(&Get<C>) + Send + Sync>;
type EqualFn = Arc<dyn Fn(&AnyVal, &AnyVal) -> bool + Send + Sync>;
type ToJsonFn = Arc<dyn Fn(&AnyVal) -> String + Send + Sync>;

struct Node<C> {
    kind: NodeKind,
    label: Option<String>,
    meta: Option<Value>,
    dirty: bool,
    destroyed: bool,
    /// `None` = `NOT_REFRESHED_YET`.
    value: Option<AnyVal>,
    sub: Vec<usize>,
    sup: Vec<usize>,
    counter: u64,
    equal: Option<EqualFn>,
    to_json: Option<ToJsonFn>,
    thunk_fn: Option<ThunkFn<C>>,
    effect_fn: Option<EffectFn<C>>,
}

impl<C> Node<C> {
    fn new(kind: NodeKind, label: Option<String>, meta: Option<Value>) -> Self {
        Node {
            kind,
            label,
            meta,
            dirty: false,
            destroyed: false,
            value: None,
            sub: vec![],
            sup: vec![],
            counter: 0,
            equal: None,
            to_json: None,
            thunk_fn: None,
            effect_fn: None,
        }
    }
}

#[derive(Default)]
struct Frame {
    refreshed_atoms: Vec<AtomDebugInfo>,
    start: Option<Instant>,
}

impl Frame {
    fn new() -> Self {
        Frame {
            refreshed_atoms: vec![],
            start: Some(Instant::now()),
        }
    }

    fn elapsed_ms(&self) -> f64 {
        self.start
            .map(|s| s.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or_default()
    }
}

struct State<C> {
    nodes: BTreeMap<usize, Node<C>>,
    atoms: BTreeSet<usize>,
    effects: BTreeSet<usize>,
    deferred: Vec<(usize, Vec<RefreshReason>)>,
    current: Option<Arc<Mutex<Frame>>>,
    infos: VecDeque<RefreshDebugInfo>,
    callbacks: Vec<(u64, Arc<dyn Fn() + Send + Sync>)>,
    next_callback: u64,
    next_node: usize,
    next_info: u64,
    context: Option<C>,
    effects_wrapper: Option<EffectsWrapper>,
}

impl<C> Default for State<C> {
    fn default() -> Self {
        State {
            nodes: BTreeMap::new(),
            atoms: BTreeSet::new(),
            effects: BTreeSet::new(),
            deferred: vec![],
            current: None,
            infos: VecDeque::new(),
            callbacks: vec![],
            next_callback: 0,
            next_node: 0,
            next_info: 0,
            context: None,
            effects_wrapper: None,
        }
    }
}

impl<C> State<C> {
    fn node(&self, id: usize) -> &Node<C> {
        &self.nodes[&id]
    }

    fn node_mut(&mut self, id: usize) -> &mut Node<C> {
        self.nodes.get_mut(&id).expect("node exists")
    }

    fn mark_super_dirty(&mut self, id: usize, effects: &mut Vec<usize>) {
        for sup in self.node(id).sup.clone() {
            if self.node(sup).kind == NodeKind::Thunk {
                self.node_mut(sup).dirty = true;
                self.mark_super_dirty(sup, effects);
            } else if !effects.contains(&sup) {
                effects.push(sup);
            }
        }
    }

    fn serialize(&self, id: usize, include_result: bool) -> SerializedNode {
        let n = self.node(id);
        let previous_result = include_result.then(|| match (&n.value, &n.to_json) {
            (Some(v), Some(to_json)) => to_json(v),
            _ => "\"SYMBOL_NOT_REFRESHED_YET\"".into(),
        });
        SerializedNode {
            kind: n.kind,
            id: format!("node-{id}"),
            label: n.label.clone(),
            meta: n.meta.clone(),
            is_dirty: n.dirty,
            is_destroyed: n.destroyed,
            counter: n.counter,
            previous_result: if n.kind == NodeKind::Effect {
                None
            } else {
                previous_result
            },
            sub: n.sub.iter().map(|i| format!("node-{i}")).collect(),
            sup: n.sup.iter().map(|i| format!("node-{i}")).collect(),
        }
    }

    fn snapshot(&self, include_results: bool) -> GraphSnapshot {
        GraphSnapshot {
            atoms: self
                .atoms
                .iter()
                .map(|id| self.serialize(*id, include_results))
                .collect(),
            effects: self
                .effects
                .iter()
                .map(|id| self.serialize(*id, false))
                .collect(),
            deferred_effects: self
                .deferred
                .iter()
                .map(|(id, _)| format!("node-{id}"))
                .collect(),
        }
    }
}

struct Shared<C> {
    id: String,
    state: Mutex<State<C>>,
}

impl<C: Clone + Send + Sync + 'static> Shared<C> {
    fn lock(&self) -> MutexGuard<'_, State<C>> {
        lock(&self.state)
    }

    fn insert(&self, node: Node<C>) -> usize {
        let mut s = self.lock();
        s.next_node += 1;
        let id = s.next_node;
        if node.kind == NodeKind::Effect {
            s.effects.insert(id);
        } else {
            s.atoms.insert(id);
        }
        s.nodes.insert(id, node);
        id
    }

    /// TS `compute`.
    fn compute_node(&self, id: usize, reason: Option<RefreshReason>) -> AnyVal {
        let (destroyed, dirty, value, kind, label) = {
            let s = self.lock();
            let n = s.node(id);
            (
                n.destroyed,
                n.dirty,
                n.value.clone(),
                n.kind,
                n.label.clone(),
            )
        };
        assert!(
            !destroyed,
            "This should never happen: LiveStore Error: Attempted to compute destroyed {kind} (node-{id}): {}",
            label.unwrap_or_default()
        );
        if !dirty {
            return value.expect("clean atoms hold a value");
        }
        let result = self.compute_thunk(id, reason);
        let mut s = self.lock();
        let n = s.node_mut(id);
        n.dirty = false;
        n.value = Some(result.clone());
        result
    }

    /// `atom.computeResult()`: unlike `compute`, no destroyed check.
    fn compute_result(&self, id: usize, reason: Option<RefreshReason>) -> AnyVal {
        let (kind, value) = {
            let s = self.lock();
            (s.node(id).kind, s.node(id).value.clone())
        };
        match kind {
            NodeKind::Thunk => self.compute_thunk(id, reason),
            _ => value.expect("refs hold a value"),
        }
    }

    /// `thunk.computeResult`.
    fn compute_thunk(&self, id: usize, reason: Option<RefreshReason>) -> AnyVal {
        let (f, label, context, local) = {
            let mut s = self.lock();
            let n = s.node(id);
            if !n.dirty {
                return n.value.clone().expect("clean thunks hold a value");
            }
            let (f, label) = (
                n.thunk_fn.clone().expect("thunk has a function"),
                n.label.clone(),
            );
            let local = s.current.is_none().then(|| {
                let frame = Arc::new(Mutex::new(Frame::new()));
                s.current = Some(frame.clone());
                frame
            });
            // Like TS, only the forward edges are reset; the getter re-adds them.
            s.node_mut(id).sub.clear();
            (f, label, s.context.clone(), local)
        };
        let Some(context) = context else {
            panic!(
                "LiveStore Error: `context` not set on ReactiveGraph ({})",
                self.id
            );
        };
        let get = Get {
            shared: self,
            owner: id,
            reason: reason.clone(),
            context: Some(context),
            debug_info: Mutex::new(None),
        };
        let result = f(&get);
        let debug_info = lock(&get.debug_info)
            .take()
            .unwrap_or_else(|| json!({ "_tag": "unknown" }));

        let mut s = self.lock();
        let n = s.node(id);
        let result_changed = match (&n.value, &n.equal) {
            (Some(prev), Some(equal)) => !equal(prev, &result),
            _ => true,
        };
        let atom = s.serialize(id, false);
        if let Some(frame) = local.clone().or_else(|| s.current.clone()) {
            lock(&frame).refreshed_atoms.push(AtomDebugInfo {
                atom,
                result_changed,
                debug_info,
            });
        }
        let n = s.node_mut(id);
        n.dirty = false;
        n.value = Some(result.clone());
        n.counter += 1;
        if let Some(local) = local {
            s.current = None;
            drop(s);
            let (refreshed_atoms, duration_ms) = {
                let mut f = lock(&local);
                (std::mem::take(&mut f.refreshed_atoms), f.elapsed_ms())
            };
            self.push_info(
                reason.unwrap_or(RefreshReason::MakeThunk { label }),
                refreshed_atoms,
                duration_ms,
            );
        }
        result
    }

    fn do_effect(&self, id: usize, reason: Option<RefreshReason>) {
        let (f, context) = {
            let mut s = self.lock();
            let context = s.context.clone();
            let n = s.node_mut(id);
            n.counter += 1;
            n.sub.clear();
            (n.effect_fn.clone(), context)
        };
        let Some(f) = f else { return };
        f(&Get {
            shared: self,
            owner: id,
            reason,
            context,
            debug_info: Mutex::new(None),
        });
    }

    fn add_edge(&self, sup: usize, sub: usize) {
        let notify = {
            let mut s = self.lock();
            let n = s.node_mut(sup);
            if !n.sub.contains(&sub) {
                n.sub.push(sub);
            }
            let n = s.node_mut(sub);
            if !n.sup.contains(&sup) {
                n.sup.push(sup);
            }
            s.current.is_none()
        };
        if notify {
            self.run_callbacks();
        }
    }

    fn remove_edge(&self, sup: usize, sub: usize) {
        let notify = {
            let mut s = self.lock();
            s.node_mut(sup).sub.retain(|i| *i != sub);
            let mut effects = vec![];
            s.mark_super_dirty(sub, &mut effects);
            for effect in effects {
                match s.deferred.iter_mut().find(|(e, _)| *e == effect) {
                    Some(entry) => entry.1.clear(),
                    None => s.deferred.push((effect, vec![])),
                }
            }
            s.node_mut(sub).sup.retain(|i| *i != sup);
            s.current.is_none()
        };
        if notify {
            self.run_callbacks();
        }
    }

    fn push_info(
        &self,
        reason: RefreshReason,
        refreshed_atoms: Vec<AtomDebugInfo>,
        duration_ms: f64,
    ) {
        let mut s = self.lock();
        s.next_info += 1;
        let info = RefreshDebugInfo {
            id: format!("refresh-info-{}", s.next_info),
            reason,
            refreshed_atoms,
            skipped_refresh: false,
            duration_ms,
            graph_snapshot: s.snapshot(false),
        };
        if s.infos.len() == MAX_REFRESH_INFOS {
            s.infos.pop_front();
        }
        s.infos.push_back(info);
    }

    fn run_callbacks(&self) {
        let callbacks: Vec<_> = self
            .lock()
            .callbacks
            .iter()
            .map(|(_, cb)| cb.clone())
            .collect();
        for cb in callbacks {
            cb();
        }
    }
}

/// Restores the outer debug frame even when an effect panics (`try/finally` in TS).
struct RestoreFrame<'a, C> {
    shared: &'a Shared<C>,
    previous: Option<Arc<Mutex<Frame>>>,
}

impl<C> Drop for RestoreFrame<'_, C> {
    fn drop(&mut self) {
        lock(&self.shared.state).current = self.previous.take();
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn downcast<T: GraphValue>(v: &AnyVal) -> T {
    v.downcast_ref::<T>()
        .expect("atom read with its own value type")
        .clone()
}

fn erase_equal<T: GraphValue>(equal: Option<EqualBy<T>>) -> EqualFn {
    Arc::new(
        move |a, b| match (a.downcast_ref::<T>(), b.downcast_ref::<T>()) {
            (Some(a), Some(b)) => equal.as_ref().map_or_else(|| a == b, |eq| eq(a, b)),
            _ => false,
        },
    )
}

fn erase_to_json<T: GraphValue>() -> ToJsonFn {
    Arc::new(|v| {
        v.downcast_ref::<T>()
            .and_then(|v| serde_json::to_string(v).ok())
            .unwrap_or_default()
    })
}

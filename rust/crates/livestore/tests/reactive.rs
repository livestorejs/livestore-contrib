//! Port of `packages/@livestore/livestore/src/reactive.test.ts`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

use livestore::reactive::{ReactiveGraph, Ref, RefOptions, RefreshReason, SetRefOptions, Thunk};

struct Trivial {
    graph: ReactiveGraph,
    a: Ref<i64>,
    b: Ref<i64>,
    c: Thunk<i64>,
    d: Ref<i64>,
    e: Thunk<i64>,
    runs_c: Arc<AtomicUsize>,
}

#[expect(
    clippy::many_single_char_names,
    reason = "atom names a..e mirror the TS reactive graph tests"
)]
fn trivial() -> Trivial {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1, RefOptions::label("a"));
    let b = graph.make_ref(2, RefOptions::label("b"));
    let runs_c = Arc::new(AtomicUsize::new(0));
    let c = {
        let (a, b, runs) = (a.clone(), b.clone(), runs_c.clone());
        graph.make_thunk(
            move |get| {
                runs.fetch_add(1, Ordering::SeqCst);
                get.get(&a) + get.get(&b)
            },
            RefOptions::label("c"),
        )
    };
    let d = graph.make_ref(3, RefOptions::label("d"));
    let e = {
        let (c, d) = (c.clone(), d.clone());
        graph.make_thunk(move |get| get.get(&c) + get.get(&d), RefOptions::label("e"))
    };
    assert_eq!(graph.atom_count(), 5);
    Trivial {
        graph,
        a,
        b,
        c,
        d,
        e,
        runs_c,
    }
}

fn runs(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::SeqCst)
}

fn set<T: livestore::reactive::GraphValue>(graph: &ReactiveGraph, r: &Ref<T>, v: T) {
    graph.set_ref(r, v, SetRefOptions::default());
}

fn panic_message(f: impl FnOnce()) -> String {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(ToString::to_string))
        .unwrap_or_default()
}

// a trivial graph

#[test]
fn trivial_has_the_right_initial_values() {
    let t = trivial();
    assert_eq!(t.c.compute_result(), 3);
    assert_eq!(t.e.compute_result(), 6);
}

#[test]
fn trivial_propagates_change_through_the_graph() {
    let t = trivial();
    set(&t.graph, &t.a, 5);
    assert_eq!(t.c.compute_result(), 7);
    assert_eq!(t.e.compute_result(), 10);
}

#[test]
fn does_not_rerun_downstream_computations_eagerly_when_an_upstream_dep_changes() {
    let t = trivial();
    assert_eq!(runs(&t.runs_c), 0);
    set(&t.graph, &t.a, 5);
    assert_eq!(runs(&t.runs_c), 0);
    t.c.compute_result();
    assert_eq!(runs(&t.runs_c), 1);
}

#[test]
fn does_not_rerun_c_when_d_is_edited_and_e_is_rerun() {
    let t = trivial();
    assert_eq!(runs(&t.runs_c), 0);
    assert_eq!(t.e.compute_result(), 6);
    assert_eq!(runs(&t.runs_c), 1);
    set(&t.graph, &t.d, 4);
    assert_eq!(t.e.compute_result(), 7);
    assert_eq!(runs(&t.runs_c), 1);
}

#[test]
fn cuts_off_reactive_propagation_when_a_thunk_evaluates_to_same_result_as_before() {
    let t = trivial();
    let runs_f = Arc::new(AtomicUsize::new(0));
    let f = {
        let (c, d, runs_f) = (t.c.clone(), t.d.clone(), runs_f.clone());
        t.graph.make_thunk(
            move |get| {
                runs_f.fetch_add(1, Ordering::SeqCst);
                get.get(&c) + get.get(&d)
            },
            RefOptions::default(),
        )
    };
    assert_eq!(runs(&runs_f), 0);
    f.compute_result();
    assert_eq!(runs(&runs_f), 1);

    set(&t.graph, &t.a, 1);
    assert_eq!(f.compute_result(), 6);

    set(&t.graph, &t.a, 5);
    assert_eq!(f.compute_result(), 10);

    set(&t.graph, &t.d, 4);
    assert_eq!(f.compute_result(), 11);

    t.graph
        .set_refs(vec![(&t.a, 6), (&t.d, 5)], SetRefOptions::default());
    assert_eq!(f.compute_result(), 13);
}

#[test]
fn only_runs_a_thunk_once_when_two_upstream_refs_are_updated_together() {
    let t = trivial();
    t.graph
        .set_refs(vec![(&t.a, 5), (&t.b, 6)], SetRefOptions::default());
    assert_eq!(runs(&t.runs_c), 0);
    assert_eq!(t.c.compute_result(), 11);
    assert_eq!(runs(&t.runs_c), 1);
}

#[test]
fn effects_do_not_run_on_initial_definition() {
    let t = trivial();
    assert_eq!(runs(&t.runs_c), 0);
    t.c.compute_result();
    assert_eq!(runs(&t.runs_c), 1);

    let effect_runs = Arc::new(AtomicUsize::new(0));
    let effect = {
        let (c, effect_runs) = (t.c.clone(), effect_runs.clone());
        t.graph.make_effect(
            move |get| {
                assert_eq!(get.get(&c), 3);
                effect_runs.fetch_add(1, Ordering::SeqCst);
            },
            None,
        )
    };
    assert_eq!(runs(&effect_runs), 0);
    assert_eq!(runs(&t.runs_c), 1);

    effect.do_effect();
    assert_eq!(runs(&effect_runs), 1);
}

#[test]
fn only_reruns_an_effect_if_the_thunk_value_changed() {
    let t = trivial();
    let effect_runs = Arc::new(AtomicUsize::new(0));
    let a_has_changed = Arc::new(AtomicBool::new(true));
    let effect = {
        let (c, effect_runs, changed) = (t.c.clone(), effect_runs.clone(), a_has_changed.clone());
        t.graph.make_effect(
            move |get| {
                assert_eq!(
                    get.get(&c),
                    if changed.load(Ordering::SeqCst) { 3 } else { 4 }
                );
                effect_runs.fetch_add(1, Ordering::SeqCst);
            },
            None,
        )
    };
    assert_eq!(runs(&effect_runs), 0);
    effect.do_effect();
    assert_eq!(runs(&effect_runs), 1);

    set(&t.graph, &t.a, 1);
    a_has_changed.store(false, Ordering::SeqCst);
    set(&t.graph, &t.a, 2);
}

#[test]
fn defers_effect_execution_until_manual_run() {
    let t = trivial();
    let effect_runs = Arc::new(AtomicUsize::new(0));
    let effect = {
        let (c, effect_runs) = (t.c.clone(), effect_runs.clone());
        t.graph.make_effect(
            move |get| {
                assert_eq!(
                    get.get(&c),
                    if effect_runs.load(Ordering::SeqCst) == 0 {
                        3
                    } else {
                        4
                    }
                );
                effect_runs.fetch_add(1, Ordering::SeqCst);
            },
            None,
        )
    };
    effect.do_effect();
    assert_eq!(runs(&effect_runs), 1);
    assert_eq!(runs(&t.runs_c), 1);

    t.graph.set_ref(
        &t.a,
        2,
        SetRefOptions {
            skip_refresh: true,
            ..Default::default()
        },
    );
    assert_eq!(runs(&effect_runs), 1);
    assert_eq!(runs(&t.runs_c), 1);

    set(&t.graph, &t.d, 0);
    assert_eq!(runs(&effect_runs), 1);
    assert_eq!(runs(&t.runs_c), 1);

    t.graph.run_deferred_effects(None);
    assert_eq!(runs(&effect_runs), 2);
    assert_eq!(runs(&t.runs_c), 2);
}

#[test]
fn does_not_run_deferred_effects_which_have_been_destroyed_already() {
    let t = trivial();
    let make = |counter: Arc<AtomicUsize>| {
        let c = t.c.clone();
        t.graph.make_effect(
            move |get| {
                assert_eq!(
                    get.get(&c),
                    if counter.load(Ordering::SeqCst) == 0 {
                        3
                    } else {
                        4
                    }
                );
                counter.fetch_add(1, Ordering::SeqCst);
            },
            None,
        )
    };
    let (runs1, runs2) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let effect1 = make(runs1.clone());
    let effect2 = make(runs2.clone());
    effect1.do_effect();
    effect2.do_effect();
    assert_eq!((runs(&runs1), runs(&runs2), runs(&t.runs_c)), (1, 1, 1));

    t.graph.set_ref(
        &t.a,
        2,
        SetRefOptions {
            skip_refresh: true,
            ..Default::default()
        },
    );
    assert_eq!((runs(&runs1), runs(&runs2), runs(&t.runs_c)), (1, 1, 1));

    t.graph.destroy_node(&effect1);
    t.graph.run_deferred_effects(None);
    assert_eq!((runs(&runs1), runs(&runs2), runs(&t.runs_c)), (1, 2, 2));
}

#[test]
fn marks_super_node_as_dirty_when_a_sub_node_is_destroyed() {
    let t = trivial();
    t.e.compute_result();
    t.graph.destroy_node(&t.b);
    assert!(t.c.is_dirty());
    assert!(!t.d.is_dirty());
    assert!(t.e.is_dirty());
    assert_eq!(
        panic_message(|| {
            t.c.compute_result();
        }),
        "This should never happen: LiveStore Error: Attempted to compute destroyed ref (node-2): b"
    );
}

// a dynamic graph

struct Dynamic {
    graph: ReactiveGraph,
    a: Ref<i64>,
    b: Ref<i64>,
    c: Ref<String>,
    d: Thunk<i64>,
    e: Ref<i64>,
    f: Thunk<i64>,
    runs_d: Arc<AtomicUsize>,
}

#[expect(
    clippy::many_single_char_names,
    reason = "atom names a..e mirror the TS reactive graph tests"
)]
fn dynamic() -> Dynamic {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1, RefOptions::label("a"));
    let b = graph.make_ref(2, RefOptions::label("b"));
    let c = graph.make_ref("a".to_string(), RefOptions::label("c"));
    let runs_d = Arc::new(AtomicUsize::new(0));
    let d = {
        let (a, b, c, runs) = (a.clone(), b.clone(), c.clone(), runs_d.clone());
        graph.make_thunk(
            move |get| {
                runs.fetch_add(1, Ordering::SeqCst);
                if get.get(&c) == "a" {
                    get.get(&a)
                } else {
                    get.get(&b)
                }
            },
            RefOptions::label("d"),
        )
    };
    let e = graph.make_ref(2, RefOptions::label("e"));
    let f = {
        let (d, e) = (d.clone(), e.clone());
        graph.make_thunk(move |get| get.get(&d) * get.get(&e), RefOptions::label("f"))
    };
    assert_eq!(graph.atom_count(), 6);
    Dynamic {
        graph,
        a,
        b,
        c,
        d,
        e,
        f,
        runs_d,
    }
}

#[test]
fn dynamic_has_the_right_initial_values() {
    let g = dynamic();
    assert_eq!(g.d.compute_result(), 1);
    assert_eq!(g.f.compute_result(), 2);
}

#[test]
fn dynamically_adjusts_d_when_a_b_or_c_changes() {
    let g = dynamic();
    assert_eq!(runs(&g.runs_d), 0);
    assert_eq!(g.d.compute_result(), 1);
    assert_eq!(g.f.compute_result(), 2);
    assert_eq!(runs(&g.runs_d), 1);
    set(&g.graph, &g.c, "b".to_string());
    assert_eq!(g.d.compute_result(), 2);
    assert_eq!(g.f.compute_result(), 4);
    assert_eq!(runs(&g.runs_d), 2);
    set(&g.graph, &g.e, 3);
    assert_eq!(g.f.compute_result(), 6);
    assert_eq!(runs(&g.runs_d), 2);
}

#[test]
fn runs_d_only_when_a_changes_not_b() {
    let g = dynamic();
    g.runs_d.store(0, Ordering::SeqCst);
    g.d.compute_result();
    assert_eq!(runs(&g.runs_d), 1);
    set(&g.graph, &g.a, 3);
    assert_eq!(g.d.compute_result(), 3);
    assert_eq!(runs(&g.runs_d), 2);
    set(&g.graph, &g.b, 4);
    assert_eq!(g.d.compute_result(), 3);
    assert_eq!(runs(&g.runs_d), 2);
}

// a diamond shaped graph

struct Diamond {
    graph: ReactiveGraph,
    a: Ref<i64>,
    b: Thunk<i64>,
    c: Thunk<i64>,
    d: Thunk<i64>,
    runs_d: Arc<AtomicUsize>,
}

fn diamond() -> Diamond {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1, RefOptions::default());
    let b = {
        let a = a.clone();
        graph.make_thunk(move |get| get.get(&a) + 1, RefOptions::default())
    };
    let c = {
        let a = a.clone();
        graph.make_thunk(move |get| get.get(&a) + 1, RefOptions::default())
    };
    let runs_d = Arc::new(AtomicUsize::new(0));
    let d = {
        let (b, c, runs) = (b.clone(), c.clone(), runs_d.clone());
        graph.make_thunk(
            move |get| {
                runs.fetch_add(1, Ordering::SeqCst);
                get.get(&b) + get.get(&c)
            },
            RefOptions::default(),
        )
    };
    assert_eq!(graph.atom_count(), 4);
    Diamond {
        graph,
        a,
        b,
        c,
        d,
        runs_d,
    }
}

#[test]
fn diamond_has_the_right_initial_values() {
    let g = diamond();
    assert_eq!(g.b.compute_result(), 2);
    assert_eq!(g.c.compute_result(), 2);
    assert_eq!(g.d.compute_result(), 4);
}

#[test]
fn diamond_propagates_change_through_the_graph() {
    let g = diamond();
    set(&g.graph, &g.a, 5);
    assert_eq!(g.b.compute_result(), 6);
    assert_eq!(g.c.compute_result(), 6);
    assert_eq!(g.d.compute_result(), 12);
}

#[test]
fn only_runs_d_once_when_a_changes() {
    let g = diamond();
    assert_eq!(runs(&g.runs_d), 0);
    g.d.compute_result();
    assert_eq!(runs(&g.runs_d), 1);
    set(&g.graph, &g.a, 5);
    g.d.compute_result();
    g.d.compute_result();
    assert_eq!(runs(&g.runs_d), 2);
}

// a trivial graph with undefined

#[test]
#[expect(
    clippy::many_single_char_names,
    reason = "atom names a..e mirror the TS reactive graph tests"
)]
fn trivial_with_undefined_has_the_right_initial_values() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1i64, RefOptions::default());
    let b = graph.make_ref(None::<i64>, RefOptions::default());
    let c = {
        graph.make_thunk(
            move |get| get.get(&a) + get.get(&b).unwrap_or(0),
            RefOptions::default(),
        )
    };
    let d = graph.make_ref(3i64, RefOptions::default());
    let e = {
        let c = c.clone();
        graph.make_thunk(move |get| get.get(&c) + get.get(&d), RefOptions::default())
    };
    assert_eq!(graph.atom_count(), 5);
    assert_eq!(c.compute_result(), 1);
    assert_eq!(e.compute_result(), 4);
}

// error handling

#[test]
fn throws_an_error_when_no_context_is_set() {
    let graph: ReactiveGraph = ReactiveGraph::new();
    let a = graph.make_ref(1i64, RefOptions::default());
    let b = graph.make_thunk(move |get| get.get(&a) + 1, RefOptions::default());
    assert_eq!(
        panic_message(|| {
            b.compute_result();
        }),
        format!(
            "LiveStore Error: `context` not set on ReactiveGraph ({})",
            graph.id()
        )
    );
}

// bug fix: currentDebugRefresh race condition

#[test]
fn keeps_the_debug_refresh_context_when_nested_effect_runs_are_triggered() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let trigger_ref = graph.make_ref(0i64, RefOptions::label("trigger"));
    let response_ref = graph.make_ref(0i64, RefOptions::label("response"));
    let trigger_thunk = {
        let r = trigger_ref.clone();
        graph.make_thunk(move |get| get.get(&r), RefOptions::label("triggerThunk"))
    };
    let later_thunk = {
        let r = trigger_ref.clone();
        graph.make_thunk(move |get| get.get(&r) + 1, RefOptions::label("laterThunk"))
    };
    let response_thunk = {
        let r = response_ref.clone();
        graph.make_thunk(move |get| get.get(&r), RefOptions::label("responseThunk"))
    };
    let nested_effect = graph.make_effect(
        move |get| {
            get.get(&response_thunk);
        },
        None,
    );
    let observed_later = Arc::new(AtomicI64::new(-1));
    let outer_effect = {
        let (graph2, observed) = (graph.clone(), observed_later.clone());
        graph.make_effect(
            move |get| {
                let current = get.get(&trigger_thunk);
                if current != 0 {
                    graph2.set_ref(
                        &response_ref,
                        current,
                        SetRefOptions {
                            debug_refresh_reason: Some(RefreshReason::tagged("nested")),
                            ..Default::default()
                        },
                    );
                }
                observed.store(get.get(&later_thunk), Ordering::SeqCst);
            },
            None,
        )
    };
    nested_effect.do_effect();
    outer_effect.do_effect();
    graph.clear_debug_refresh_infos();

    graph.set_ref(
        &trigger_ref,
        1,
        SetRefOptions {
            debug_refresh_reason: Some(RefreshReason::tagged("outer")),
            ..Default::default()
        },
    );
    assert_eq!(observed_later.load(Ordering::SeqCst), 2);

    let infos = graph.debug_refresh_infos();
    let outer = infos
        .iter()
        .find(|i| i.reason.tag() == "outer")
        .expect("outer refresh recorded");
    let labels: Vec<_> = outer
        .refreshed_atoms
        .iter()
        .filter_map(|a| a.atom.label.clone())
        .collect();
    assert!(labels.contains(&"triggerThunk".to_string()));
    assert!(labels.contains(&"laterThunk".to_string()));
    assert_eq!(
        infos
            .iter()
            .filter(|i| i.reason.tag() == "makeThunk")
            .count(),
        0
    );
}

#[test]
fn handles_nested_run_effects_from_effect_calling_set_ref() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1i64, RefOptions::default());
    let b = graph.make_ref(2i64, RefOptions::default());
    {
        let (graph2, a, b) = (graph.clone(), a.clone(), b.clone());
        graph
            .make_effect(
                move |get| {
                    get.get(&a);
                    graph2.set_ref(&b, 3, SetRefOptions::default());
                },
                None,
            )
            .do_effect();
    }
    {
        graph
            .make_effect(
                move |get| {
                    get.get(&b);
                },
                None,
            )
            .do_effect();
    }
    set(&graph, &a, 2);
}

#[test]
fn handles_thunk_calling_set_ref_directly() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1i64, RefOptions::default());
    let b = graph.make_ref(2i64, RefOptions::default());
    {
        let b = b.clone();
        graph
            .make_effect(
                move |get| {
                    get.get(&b);
                },
                None,
            )
            .do_effect();
    }
    let thunk = {
        let graph2 = graph.clone();
        graph.make_thunk(
            move |get| {
                let val = get.get(&a);
                graph2.set_ref(&b, val * 2, SetRefOptions::default());
                val + get.get(&b)
            },
            RefOptions::default(),
        )
    };
    thunk.compute_result();
    assert_eq!(thunk.compute_result(), 3);
}

#[test]
fn handles_nested_thunk_computations() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1i64, RefOptions::default());
    let outer = {
        let graph2 = graph.clone();
        graph.make_thunk(
            move |get| {
                let val = get.get(&a);
                let a2 = a.clone();
                let inner = graph2.make_thunk(move |get| get.get(&a2) * 2, RefOptions::default());
                val + inner.compute_result()
            },
            RefOptions::default(),
        )
    };
    outer.compute_result();
    assert_eq!(outer.compute_result(), 3);
}

// bug fix: node corruption protection

#[test]
fn handles_node_destruction_during_effect_execution() {
    let graph = ReactiveGraph::new();
    graph.set_context(());
    let a = graph.make_ref(1i64, RefOptions::default());
    let thunk1 = graph.make_thunk(move |get| get.get(&a) * 2, RefOptions::default());
    let thunk2 = {
        let t1 = thunk1.clone();
        graph.make_thunk(move |get| get.get(&t1), RefOptions::default())
    };
    let first_run = Arc::new(AtomicBool::new(true));
    let effect = {
        let graph2 = graph.clone();
        graph.make_effect(
            move |get| {
                if first_run.swap(false, Ordering::SeqCst) {
                    graph2.destroy_node(&thunk1);
                }
                get.get(&thunk2);
            },
            None,
        )
    };
    assert!(
        panic_message(|| effect.do_effect())
            .contains("LiveStore Error: Attempted to compute destroyed")
    );
}

//! Port of `tests/package-common/src/client-session/ClientSessionReconciliation.test.ts`.

mod common;

use std::sync::{Arc, LazyLock, Mutex};

use common::harness::{Deferred, never};
use common::session::{self, TODO_COMPLETED, TODOS, TodoId};
use common::{journal_count, state_head, to_i64};
use futures::{FutureExt, StreamExt};
use livestore::session::{LeaderThreadProxy, MaterializerHash, PullFn, PushFn, ensuring};
use livestore::{
    EventInput, Exit, InMemoryAdapter, LeaderPushFailure, PULL_CHUNK_SIZE, PullItem, Store,
    StoreOptions, SubscribeOptions, create_store,
};
use livestore_core::{Event, Payload, SeqNum, SyncState};
use livestore_schema::{Column, EventDef, Schema, SqlStatement, SqlValue, Table};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

/// Batches are sized in whole pull steps so they keep their meaning if the chunk size changes.
const STEP: usize = PULL_CHUNK_SIZE;

#[tokio::test]
async fn rolls_back_the_whole_local_batch_before_installing_state_or_scheduling_propagation() {
    let propagated = Arc::new(Mutex::new(Vec::<Event>::new()));
    let h = StoreHarness::new(recording_push(propagated.clone()), session::schema()).await;
    let processor = h.store.sync_processor();
    let before = processor.sync_state();
    let exit = processor.commit(vec![
        todo("duplicate", "first"),
        todo("duplicate", "second"),
    ]);
    assert!(exit.is_err());
    assert_eq!(h.store.query(&*TODOS), json!([]));
    assert_eq!(state_head(&h.store), before.local_head);
    assert_eq!(journal_count(&h.store), 0);
    assert_eq!(processor.sync_state(), before);
    processor.shutdown(Ok(())).await.unwrap();
    assert!(propagated.lock().unwrap().is_empty());
}

#[tokio::test]
async fn aborts_remaining_pull_steps_when_the_active_push_fails_after_a_coherent_prefix() {
    let (started, fail_push) = (Deferred::<()>::new(), Deferred::<()>::new());
    let push = {
        let (started, fail_push) = (started.clone(), fail_push.clone());
        livestore::session::push_fn(move |_| {
            let (started, fail_push) = (started.clone(), fail_push.clone());
            async move {
                started.done();
                fail_push.wait().await;
                Err(LeaderPushFailure::Defect(livestore::Defect::msg(
                    "fatal push during reconciliation",
                )))
            }
        })
    };
    let h = StoreHarness::new(push, session::schema()).await;
    h.store.commit([todo("local", "local")]).unwrap();
    started.wait().await;
    let local = h.store.sync_processor().sync_state().pending[0].clone();
    let observed = Arc::new(Mutex::new(Vec::<usize>::new()));
    let subscription = {
        let (observed, fail_push) = (observed.clone(), fail_push.clone());
        h.store.subscribe(
            &*TODOS,
            move |rows| {
                let n = common::len(&rows);
                observed.lock().unwrap().push(n);
                if n == STEP {
                    fail_push.done();
                }
            },
            &SubscribeOptions::default(),
        )
    };
    // Confirm the in-flight local event so the pull can advance without cancelling that push first.
    let batch: Vec<Event> = std::iter::once(local)
        .chain((0..2 * STEP - 1).map(|i| remote_created(to_i64(i) + 2)))
        .collect();
    let _ = h.deliver(batch, DeliverOptions::default());
    assert!(h.failed.wait().await.is_err());
    assert_eq!(*observed.lock().unwrap(), [1, STEP]);
    assert_eq!(state_head(&h.store).global, to_i64(STEP));
    assert_eq!(common::len(&h.store.query(&*TODOS)), STEP);
    assert_eq!(journal_count(&h.store), to_i64(STEP));
    assert_eq!(
        h.store.sync_processor().sync_state().local_head,
        state_head(&h.store)
    );
    subscription.unsubscribe();
}

#[tokio::test]
async fn preserves_rows_and_durable_head_during_cancellation_same_row_false() {
    preserves_rows_and_durable_head_during_cancellation(false).await;
}

#[tokio::test]
async fn preserves_rows_and_durable_head_during_cancellation_same_row_true() {
    preserves_rows_and_durable_head_during_cancellation(true).await;
}

async fn preserves_rows_and_durable_head_during_cancellation(update_same_row: bool) {
    let (started, cancelling, release) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let propagated = Arc::new(Mutex::new(Vec::<Event>::new()));
    let first = Arc::new(Mutex::new(true));
    let push = {
        let (started, cancelling, release, propagated) = (
            started.clone(),
            cancelling.clone(),
            release.clone(),
            propagated.clone(),
        );
        livestore::session::push_fn(move |batch| {
            let is_first = std::mem::replace(&mut *first.lock().unwrap(), false);
            let (started, cancelling, release, propagated) = (
                started.clone(),
                cancelling.clone(),
                release.clone(),
                propagated.clone(),
            );
            async move {
                if !is_first {
                    propagated.lock().unwrap().extend(batch);
                    return Ok(());
                }
                started.done();
                let cleanup = async move {
                    cancelling.done();
                    release.wait().await;
                };
                ensuring(never::<Result<(), LeaderPushFailure>>(), cleanup).await
            }
        })
    };
    let h = StoreHarness::new(push, session::schema()).await;
    h.store.commit([todo("local", "local")]).unwrap();
    started.wait().await;
    let completed = h.deliver(vec![remote_created(1)], DeliverOptions::default());
    cancelling.wait().await;
    // Cancellation is not permission to advertise an unapplied new head.
    assert_eq!(
        state_head(&h.store),
        h.store.sync_processor().sync_state().local_head
    );
    let concurrent = if update_same_row {
        EventInput::from(TODO_COMPLETED.make(TodoId { id: "local".into() }))
    } else {
        todo("concurrent", "concurrent")
    };
    h.store.commit([concurrent]).unwrap();
    release.done();
    completed.wait().await;
    assert_eq!(
        state_head(&h.store),
        h.store.sync_processor().sync_state().local_head
    );
    let rows = h.store.query(&*TODOS);
    let local = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "local")
        .unwrap()
        .clone();
    assert_eq!(local["completed"], json!(update_same_row));
    assert_eq!(common::len(&rows), if update_same_row { 2 } else { 3 });
    h.store.sync_processor().shutdown(Ok(())).await.unwrap();
    let globals: Vec<i64> = propagated
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.seq_num.global)
        .collect();
    assert_eq!(globals, [2, 3], "same row: {update_same_row}");
}

#[tokio::test]
async fn yields_with_coherent_rows_journal_and_heads_and_replays_a_concurrent_noncommutative_update()
 {
    let first_prefix = Deferred::<()>::new();
    let propagated = Arc::new(Mutex::new(Vec::<Event>::new()));
    let h = StoreHarness::new(recording_push(propagated.clone()), counter_schema()).await;
    let store = h.store.clone();
    let total = 4 * to_i64(STEP);
    // A task scheduled between pull steps commits against the applied prefix.
    let input = tokio::spawn({
        let (first_prefix, store) = (first_prefix.clone(), store.clone());
        async move {
            first_prefix.wait().await;
            let before = store.sync_processor().sync_state();
            assert!(before.upstream_head.global > 0);
            assert!(before.upstream_head.global < total);
            store.commit([multiply(2)]).unwrap();
            assert_eq!(
                counter_value(&store),
                replay_counter(&store.sync_processor().sync_state())
            );
        }
    });
    let seen = Arc::new(Mutex::new(Vec::<(i64, usize)>::new()));
    let subscriber_committed = Arc::new(Mutex::new(false));
    let subscription = {
        let (store, seen, propagated, first_prefix) = (
            store.clone(),
            seen.clone(),
            propagated.clone(),
            first_prefix.clone(),
        );
        store.clone().subscribe(
            &*COUNTER,
            move |rows| {
                if common::len(&rows) == 0 {
                    return;
                }
                let state = store.sync_processor().sync_state();
                assert_eq!(state_head(&store), state.local_head);
                assert_eq!(rows[0]["value"].as_i64().unwrap(), replay_counter(&state));
                seen.lock()
                    .unwrap()
                    .push((state.upstream_head.global, propagated.lock().unwrap().len()));
                if state.upstream_head.global < total {
                    assert!(journal_count(&store) > 0);
                }
                // The owner is released before callbacks, so a subscriber can commit against the durable prefix.
                if !std::mem::replace(&mut *subscriber_committed.lock().unwrap(), true) {
                    store
                        .commit([EventInput {
                            name: "increment".into(),
                            args: json!({}),
                        }])
                        .unwrap();
                }
                first_prefix.done();
            },
            &SubscribeOptions::default(),
        )
    };
    h.deliver(counter_batch(total), DeliverOptions::default())
        .wait()
        .await;
    input.await.unwrap();
    let seen = seen.lock().unwrap().clone();
    assert!(seen.iter().any(|(head, _)| *head > 0 && *head < total));
    // Nothing propagates while the pull is still rebasing the local edits.
    assert!(seen.iter().all(|(_, p)| *p == 0));
    assert_eq!(counter_value(&store), (total + 1) * 2);
    assert_eq!(journal_count(&store), 2);
    store.sync_processor().shutdown(Ok(())).await.unwrap();
    // Only the final encodings reach the leader.
    let names: Vec<(String, i64)> = propagated
        .lock()
        .unwrap()
        .iter()
        .map(|e| (e.name.clone(), e.seq_num.global))
        .collect();
    assert_eq!(
        names,
        [
            ("increment".to_string(), total + 1),
            ("multiply".to_string(), total + 2)
        ]
    );
    subscription.unsubscribe();
}

#[tokio::test]
async fn rolls_back_a_failed_step_keeping_only_complete_prefixes_failure_at() {
    for failing_event in [2, STEP + 2] {
        let h = StoreHarness::new(
            livestore::session::push_fn(|_| async { Ok(()) }),
            session::schema(),
        )
        .await;
        let mut batch: Vec<Event> = (0..2 * STEP)
            .map(|i| remote_created(to_i64(i) + 1))
            .collect();
        batch[failing_event - 1].args = batch[failing_event - 2].args.clone();
        let published = Arc::new(Mutex::new(Vec::<usize>::new()));
        let subscription = {
            let published = published.clone();
            h.store.subscribe(
                &*TODOS,
                move |rows| published.lock().unwrap().push(common::len(&rows)),
                &SubscribeOptions::default(),
            )
        };
        let _ = h.deliver(batch, DeliverOptions::default());
        assert!(h.failed.wait().await.is_err());
        let prefix = if failing_event == 2 { 0 } else { STEP };
        assert_eq!(common::len(&h.store.query(&*TODOS)), prefix);
        assert_eq!(state_head(&h.store).global, to_i64(prefix));
        assert_eq!(
            state_head(&h.store),
            h.store.sync_processor().sync_state().local_head
        );
        assert_eq!(journal_count(&h.store), to_i64(prefix));
        let expected: Vec<usize> = if prefix == 0 { vec![0] } else { vec![0, STEP] };
        assert_eq!(
            *published.lock().unwrap(),
            expected,
            "failure at {failing_event}"
        );
        subscription.unsubscribe();
    }
}

#[tokio::test]
async fn rejects_local_commits_before_materialization_while_failure_cleanup_is_awaiting_cancellation()
 {
    let (started, cancelling, release) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let push = {
        let (started, cancelling, release) = (started.clone(), cancelling.clone(), release.clone());
        livestore::session::push_fn(move |_| {
            let (started, cancelling, release) =
                (started.clone(), cancelling.clone(), release.clone());
            async move {
                started.done();
                let cleanup = async move {
                    cancelling.done();
                    release.wait().await;
                };
                ensuring(never::<Result<(), LeaderPushFailure>>(), cleanup).await
            }
        })
    };
    let h = StoreHarness::new(push, session::schema()).await;
    h.store.commit([todo("local", "local")]).unwrap();
    started.wait().await;
    let state = h.store.sync_processor().sync_state();
    // Confirmation doesn't require cancellation, but the following duplicate INSERT fails materialization.
    let mut duplicate = remote_created(2);
    duplicate.args = json!({ "id": "local", "text": "duplicate" });
    let _ = h.deliver(
        vec![state.pending[0].clone(), duplicate],
        DeliverOptions::default(),
    );
    cancelling.wait().await;
    // The store may already mark itself disposed while reporting the defect; inspect SQLite directly. The
    // guarantee is that the rejected admission did not materialize anything.
    let _ = h.store.commit([todo("too-late", "too-late")]);
    assert_eq!(
        h.store
            .client_session()
            .sqlite_db
            .select("SELECT * FROM todos", &[])
            .unwrap()
            .len(),
        1
    );
    assert_eq!(state_head(&h.store), state.local_head);
    assert_eq!(journal_count(&h.store), 1);
    release.done();
}

#[tokio::test]
async fn refreshes_tables_changed_only_by_rollback_and_applies_an_explicit_rebase_across_steps() {
    let h = StoreHarness::new(
        livestore::session::push_fn(|_| async { Ok(()) }),
        session::schema(),
    )
    .await;
    let old: Vec<Event> = (0..2 * STEP)
        .map(|i| remote_created(to_i64(i) + 1))
        .collect();
    h.deliver(
        old.clone(),
        DeliverOptions {
            global_head: Some(SeqNum::ROOT),
            ..Default::default()
        },
    )
    .wait()
    .await;
    let counts = Arc::new(Mutex::new(Vec::<usize>::new()));
    let subscription = {
        let counts = counts.clone();
        h.store.subscribe(
            &*TODOS,
            move |rows| counts.lock().unwrap().push(common::len(&rows)),
            &SubscribeOptions::default(),
        )
    };
    // Unknown replacement events still advance durable history but don't touch the todos table.
    let replacement: Vec<Event> = (0..3 * to_i64(STEP))
        .map(|i| Event {
            name: "future-event".into(),
            seq_num: SeqNum::new(i + 1, 0, 1),
            parent_seq_num: SeqNum::new(i, 0, 1),
            ..remote_created(i + 1)
        })
        .collect();
    let n = replacement.len();
    h.deliver(
        replacement,
        DeliverOptions {
            rollback_events: Some(old.clone()),
            ..Default::default()
        },
    )
    .wait()
    .await;
    assert_eq!(*counts.lock().unwrap(), [old.len(), 0]);
    assert_eq!(h.store.query(&*TODOS), json!([]));
    assert_eq!(state_head(&h.store).global, to_i64(n));
    assert_eq!(journal_count(&h.store), 0);
    subscription.unsubscribe();
}

#[tokio::test]
async fn does_not_attach_a_future_leader_hash_to_intermediate_pending_replay() {
    let first = Arc::new(Mutex::new(true));
    let push = livestore::session::push_fn(move |_| {
        let is_first = std::mem::replace(&mut *first.lock().unwrap(), false);
        async move { if is_first { never().await } else { Ok(()) } }
    });
    let h = StoreHarness::new(push, session::schema()).await;
    h.store.commit([todo("local", "local")]).unwrap();
    let mut batch: Vec<Event> = (0..2 * STEP)
        .map(|i| remote_created(to_i64(i) + 1))
        .collect();
    // After the first prefix, the pending local event is rebased to e(STEP+1)r1. This unrelated future event has
    // that same key.
    let key = SeqNum::new(to_i64(STEP) + 1, 0, 1);
    batch[STEP].name = "future-event".into();
    batch[STEP].seq_num = key;
    let len = batch.len();
    h.deliver(
        batch,
        DeliverOptions {
            materializer_hashes: vec![MaterializerHash {
                event_num: key,
                hash: Some(99),
            }],
            ..Default::default()
        },
    )
    .wait()
    .await;
    assert_eq!(common::len(&h.store.query(&*TODOS)), len);
    assert_eq!(state_head(&h.store).global, to_i64(len) + 1);
    assert_eq!(journal_count(&h.store), 1);
}

#[tokio::test]
async fn confirms_a_pending_event_acknowledged_by_a_later_prefix_instead_of_duplicating_it() {
    let h = StoreHarness::new(
        livestore::session::push_fn(|_| async { Ok(()) }),
        session::schema(),
    )
    .await;
    h.store.commit([todo("local", "local")]).unwrap();
    let pending = h.store.sync_processor().sync_state().pending[0].clone();
    let mut batch: Vec<Event> = (0..2 * STEP)
        .map(|i| remote_created(to_i64(i) + 1))
        .collect();
    batch[STEP] = Event {
        seq_num: batch[STEP].seq_num,
        parent_seq_num: batch[STEP].parent_seq_num,
        ..pending
    };
    let len = batch.len();
    h.deliver(batch, DeliverOptions::default()).wait().await;
    assert_eq!(
        h.store.sync_processor().sync_state().pending,
        [] as [Event; 0]
    );
    assert_eq!(common::len(&h.store.query(&*TODOS)), len);
    assert_eq!(state_head(&h.store).global, to_i64(len));
    assert_eq!(journal_count(&h.store), 0);
}

/// Real Store/SQLite, with only the transport controlled. The next pull demand is the completion signal,
/// because a concurrent local commit can publish sync state while the preceding pull is still running.
struct StoreHarness {
    store: Store,
    pulls: mpsc::UnboundedSender<(PullItem, Deferred<()>)>,
    failed: Deferred<Exit>,
}

#[derive(Default)]
struct DeliverOptions {
    global_head: Option<SeqNum>,
    rollback_events: Option<Vec<Event>>,
    materializer_hashes: Vec<MaterializerHash>,
}

impl StoreHarness {
    async fn new(push: PushFn, schema: Arc<Schema>) -> Self {
        let failed = Deferred::<Exit>::new();
        let (tx, rx) = mpsc::unbounded_channel::<(PullItem, Deferred<()>)>();
        let state = Arc::new(tokio::sync::Mutex::new((rx, None::<Deferred<()>>)));
        let pull: PullFn = Arc::new(move |_| {
            futures::stream::unfold(state.clone(), |state| async move {
                let next = {
                    let mut guard = state.lock().await;
                    if let Some(previous) = guard.1.take() {
                        previous.done();
                    }
                    let (item, completed) = guard.0.recv().await?;
                    guard.1 = Some(completed);
                    item
                };
                Some((Ok(next), state))
            })
            .boxed()
        });
        let adapter = InMemoryAdapter {
            leader_thread_proxy: Some(Arc::new(move |proxy: LeaderThreadProxy| {
                LeaderThreadProxy {
                    push: push.clone(),
                    pull: pull.clone(),
                    ..proxy
                }
            })),
            // Keep the DB available after a processor failure so tests can inspect the rolled-back transaction.
            client_session: Some({
                let failed = failed.clone();
                Arc::new(move |session| livestore::ClientSession {
                    shutdown: {
                        let failed = failed.clone();
                        Arc::new(move |exit| {
                            failed.succeed(exit);
                            async {}.boxed()
                        })
                    },
                    ..session
                })
            }),
            ..InMemoryAdapter::default()
        };
        let store = create_store(StoreOptions::new(schema, adapter.build(), "reconciliation"))
            .await
            .expect("store boots");
        Self {
            store,
            pulls: tx,
            failed,
        }
    }

    /// Offers one pull item; the returned cell completes when the processor demands the next one.
    fn deliver(&self, new_events: Vec<Event>, options: DeliverOptions) -> Deferred<()> {
        let completed = Deferred::new();
        let global_head = options
            .global_head
            .or_else(|| new_events.last().map(|e| e.seq_num))
            .unwrap_or(SeqNum::ROOT);
        let payload = match options.rollback_events {
            None => Payload::UpstreamAdvance { new_events },
            Some(rollback_events) => Payload::UpstreamRebase {
                rollback_events,
                new_events,
            },
        };
        let item = PullItem {
            payload,
            global_head,
            materializer_hashes: options.materializer_hashes,
        };
        self.pulls
            .send((item, completed.clone()))
            .expect("pull loop alive");
        completed
    }
}

fn todo(id: &str, text: &str) -> EventInput {
    EventInput {
        name: "todoCreated".into(),
        args: json!({ "id": id, "text": text }),
    }
}

fn remote_created(global: i64) -> Event {
    session::encoded(
        "todoCreated",
        json!({ "id": format!("remote-{global}"), "text": "remote" }),
        SeqNum::new(global, 0, 0),
        SeqNum::new(global - 1, 0, 0),
        "remote",
        "remote",
    )
}

fn recording_push(propagated: Arc<Mutex<Vec<Event>>>) -> PushFn {
    livestore::session::push_fn(move |batch| {
        propagated.lock().unwrap().extend(batch);
        async { Ok(()) }
    })
}

static COUNTER: LazyLock<Table> = LazyLock::new(|| {
    Table::new("counter")
        .column(Column::integer("id").primary_key())
        .column(Column::integer("value"))
});

#[derive(Serialize, Deserialize)]
struct Increment {}

#[derive(Serialize, Deserialize)]
struct Multiply {
    factor: i64,
}

static INCREMENT: LazyLock<EventDef<Increment>> = LazyLock::new(|| EventDef::synced("increment"));
static MULTIPLY: LazyLock<EventDef<Multiply>> = LazyLock::new(|| EventDef::synced("multiply"));

fn counter_schema() -> Arc<Schema> {
    Schema::builder()
        .table(COUNTER.clone())
        .event(&INCREMENT, |_, _| {
            Ok(SqlStatement {
                sql: "INSERT INTO counter (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1".into(),
                binds: vec![],
            })
        })
        .event(&MULTIPLY, |a, _| Ok(SqlStatement { sql: "UPDATE counter SET value = value * ?".into(), binds: vec![SqlValue::Integer(a.factor)] }))
        .build()
}

fn multiply(factor: i64) -> EventInput {
    EventInput {
        name: "multiply".into(),
        args: json!({ "factor": factor }),
    }
}

fn counter_value(store: &Store) -> i64 {
    store.query(&*COUNTER)[0]["value"]
        .as_i64()
        .expect("counter row")
}

/// Counter value implied by one increment per upstream event, then the pending updates in order.
fn replay_counter(state: &SyncState) -> i64 {
    state
        .pending
        .iter()
        .fold(state.upstream_head.global, |value, e| {
            if e.name == "multiply" {
                value * e.args["factor"].as_i64().unwrap()
            } else {
                value + 1
            }
        })
}

fn counter_batch(count: i64) -> Vec<Event> {
    (0..count)
        .map(|i| Event {
            name: "increment".into(),
            args: json!({}),
            ..remote_created(i + 1)
        })
        .collect()
}

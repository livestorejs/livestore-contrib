//! Port of `tests/package-common/src/client-session/ClientSessionSyncProcessor.test.ts`.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::harness::*;
use common::session::{
    self, TODO_CREATED, TODO_DELETED_NON_PURE, TODOS, TodoCreated, TodoId, encoded,
    todo_created_args,
};
use common::{state_head, to_i64};
use futures::{FutureExt, StreamExt};
use livestore::processor::{MaterializeOutput, RebaseBarrierPoint};
use livestore::session::{LeaderThreadProxy, MaterializerHash, PullFn};
use livestore::{
    Defect, InMemoryAdapter, LeaderPushFailure, MaterializeCause, PULL_CHUNK_SIZE, PullItem,
    StoreError, StoreOptions, create_store,
};
use livestore_core::{Event, SeqNum};
use livestore_sqlite::LeaderDb;
use livestore_sync::testing::{ClientIdentity, EventFactory};
use livestore_sync::{InitialSyncOptions, RejectedPushError, SyncOptions};
use serde_json::json;
use tokio::sync::mpsc;

#[tokio::test]
async fn recovers_a_rejection_received_between_prefixes_that_confirm_the_same_pending_batch() {
    let (started, reject_now) = (Deferred::<()>::new(), Deferred::<()>::new());
    let (pull_tx, pull) = pull_from_queue();
    let accepted = Arc::new(Mutex::new(Vec::<Event>::new()));
    // One pushed batch spanning two pull steps, so a rejection can arrive between them.
    let batch_size = 2 * PULL_CHUNK_SIZE;
    let first = Arc::new(Mutex::new(true));
    let mut options = HarnessOptions::new({
        let (started, reject_now, accepted) =
            (started.clone(), reject_now.clone(), accepted.clone());
        push(move |batch| {
            let is_first = std::mem::replace(&mut *first.lock().unwrap(), false);
            let (started, reject_now, accepted) =
                (started.clone(), reject_now.clone(), accepted.clone());
            async move {
                if !is_first {
                    accepted.lock().unwrap().extend(batch);
                    return Ok(());
                }
                started.done();
                reject_now.wait().await;
                Err(LeaderPushFailure::Rejected(leader_ahead_at_root()))
            }
        })
    });
    options.leader_push_batch_size = batch_size;
    options.pull = pull;
    let h = Harness::new(options);
    let ids: Vec<String> = (0..batch_size).map(|i| format!("local-{i}")).collect();
    let batch = h
        .push_ids(&ids.iter().map(String::as_str).collect::<Vec<_>>())
        .unwrap();
    started.wait().await;
    let mut changes = h.processor.sync_state_changes();
    let observer = tokio::spawn({
        let reject_now = reject_now.clone();
        async move {
            while let Some(state) = changes.next().await {
                if state.upstream_head.global < to_i64(PULL_CHUNK_SIZE) {
                    continue;
                }
                if state.upstream_head.global == to_i64(PULL_CHUNK_SIZE) {
                    reject_now.done();
                }
                if state.upstream_head.global == to_i64(batch_size) {
                    break;
                }
            }
        }
    });
    pull_tx.send(advance(batch)).unwrap();
    observer.await.unwrap();
    h.processor.await_rejection().await;
    // Wait until the next step has confirmed the rest and finalization has released the rejection fence.
    yield_now().await;
    h.push_ids(&["after"]).unwrap();
    assert!(h.close(Ok(())).await.is_ok());
    assert_eq!(ids_of(&accepted), ["after"]);
}

#[tokio::test]
async fn sizes_rebasing_pull_steps_by_the_pending_events_they_replay() {
    let (pull_tx, pull) = pull_from_queue();
    let materialized = Arc::new(AtomicUsize::new(0));
    let mut options = HarnessOptions::new(push(|_| async { Ok(()) }));
    options.pull = pull;
    options.materialize_event = {
        let materialized = materialized.clone();
        Arc::new(move |_, _| {
            materialized.fetch_add(1, Ordering::SeqCst);
            Ok(MaterializeOutput::default())
        })
    };
    let h = Harness::new(options);
    let pending_count = 3 * PULL_CHUNK_SIZE;
    let ids: Vec<String> = (0..pending_count).map(|i| format!("local-{i}")).collect();
    h.push_ids(&ids.iter().map(String::as_str).collect::<Vec<_>>())
        .unwrap();
    let remote_count = 2 * pending_count;
    let remote: Vec<Event> = (0..remote_count)
        .map(|i| remote_event(&format!("remote-{i}"), "remote", to_i64(i) + 1))
        .collect();
    materialized.store(0, Ordering::SeqCst);
    let mut changes = h.processor.sync_state_changes();
    pull_tx.send(advance(remote)).unwrap();
    wait_for_state(&mut changes, |s| {
        s.upstream_head.global == to_i64(remote_count)
    })
    .await;
    // Two steps of `pending_count` incoming events, each replaying the pending events once. Steps of
    // PULL_CHUNK_SIZE would replay them six times.
    assert_eq!(
        materialized.load(Ordering::SeqCst),
        remote_count + 2 * pending_count
    );
    assert!(h.close(Ok(())).await.is_ok());
}

#[tokio::test]
async fn from_scratch() {
    let ctx = TestContext::new();
    let store = ctx.make_store(ctx.adapter(), None).await;
    store.commit([session::todo_created("1", "t1")]).unwrap();
    let sync_state = store.sync_processor().sync_state();
    assert_eq!(state_head(&store), sync_state.local_head);
    ctx.mock.take_pushed(1).await;
}

#[tokio::test]
async fn does_not_send_a_later_pending_event_before_its_rejected_prefix_is_reconciled() {
    let shutdown_deferred = livestore::make_shutdown_deferred();
    let (pull_tx, pull) = pull_from_queue();
    let (first_push_rejected, later_push_accepted) = (Deferred::<()>::new(), Deferred::<()>::new());
    let pushed_ids = Arc::new(Mutex::new(Vec::<String>::new()));
    let push_count = Arc::new(AtomicUsize::new(0));
    let push_fn = {
        let (first_push_rejected, later_push_accepted, pushed_ids) = (
            first_push_rejected.clone(),
            later_push_accepted.clone(),
            pushed_ids.clone(),
        );
        push(move |batch: Vec<Event>| {
            let n = push_count.fetch_add(1, Ordering::SeqCst) + 1;
            pushed_ids.lock().unwrap().extend(ids(&batch));
            let (first_push_rejected, later_push_accepted) =
                (first_push_rejected.clone(), later_push_accepted.clone());
            async move {
                if n == 1 {
                    first_push_rejected.done();
                    return Err(LeaderPushFailure::Rejected(
                        RejectedPushError::LeaderAhead {
                            minimum_expected_num: SeqNum::ROOT,
                            provided_num: batch[0].seq_num,
                            session_id: batch[0].session_id.clone(),
                        },
                    ));
                }
                later_push_accepted.done();
                Ok(())
            }
        })
    };
    let adapter = InMemoryAdapter {
        client_id: "client-2".into(),
        session_id: "session-2".into(),
        leader_thread_proxy: Some(scripted_proxy(pull, push_fn)),
        ..InMemoryAdapter::default()
    };
    let mut options = StoreOptions::new(
        session::schema(),
        adapter.build(),
        "sf-03-overlapping-advance",
    );
    options.shutdown_deferred = Some(shutdown_deferred.clone());
    let store = create_store(options).await.unwrap();
    let processor = store.sync_processor().clone();

    store
        .commit([session::todo_created("older-pending", "older")])
        .unwrap();
    first_push_rejected.wait().await;
    processor.await_rejection().await;

    let rejected_prefix = processor.sync_state().pending[0].clone();
    store
        .commit([session::todo_created("later-pending", "later")])
        .unwrap();

    // The old worker loop drained `later-pending` here. Its leader delivery then appeared before
    // `older-pending`, producing merge materialization `[B, A', B']` and the SF-03 UNIQUE failure.
    yield_now().await;
    assert!(!later_push_accepted.is_done());

    let mut changes = processor.sync_state_changes();
    let target = rejected_prefix.seq_num;
    let recovered = tokio::spawn(async move {
        tokio::select! {
            () = wait_for_state(&mut changes, |s| s.upstream_head == target && s.pending.len() == 1) => {}
            _ = livestore::await_shutdown(&shutdown_deferred) => {}
        }
    });
    pull_tx.send(advance(vec![rejected_prefix])).unwrap();
    recovered.await.unwrap();
    later_push_accepted.wait().await;

    let mut rows = common::ids(&store.query(&*TODOS));
    rows.sort();
    assert_eq!(rows, ["later-pending", "older-pending"]);
    assert_eq!(
        *pushed_ids.lock().unwrap(),
        ["older-pending", "later-pending"]
    );
}

#[tokio::test]
async fn rolls_back_materialized_state_when_persisting_the_state_head_fails() {
    let ctx = TestContext::new();
    let store = ctx.make_store(ctx.adapter(), None).await;
    let db = store.sqlite_db_wrapper();
    db.execute(&format!(
        "DROP TABLE {}",
        livestore_schema::system_tables::STATE_HEAD_TABLE
    ))
    .unwrap();

    let exit = store
        .sync_processor()
        .commit(vec![todo_created_input("rolled-back")]);

    assert!(exit.is_err());
    assert_eq!(
        db.select(&TODOS.query().as_sql().unwrap().query, &[])
            .unwrap(),
        [] as [serde_json::Map<String, serde_json::Value>; 0]
    );
}

#[tokio::test]
async fn commits_during_boot() {
    let ctx = TestContext::new();
    let delayed_pull: livestore::adapter::ProxyOverride = Arc::new(|proxy: LeaderThreadProxy| {
        let inner = proxy.pull.clone();
        LeaderThreadProxy {
            pull: Arc::new(move |cursor| {
                let inner = inner.clone();
                futures::stream::once(tokio::time::sleep(Duration::from_secs(1)))
                    .flat_map(move |()| inner(cursor))
                    .boxed()
            }),
            ..proxy
        }
    });
    let adapter = InMemoryAdapter {
        leader_thread_proxy: Some(delayed_pull),
        ..ctx.adapter()
    };
    let boot: livestore::store::BootFn =
        Arc::new(|store| store.commit([session::todo_created("0", "t0")]).unwrap());
    let store = ctx.make_store(adapter, Some(boot)).await;

    ctx.mock.take_pushed(1).await;

    // Make sure pending events are processed
    let mut changes = store.sync_processor().sync_state_changes();
    wait_for_state(&mut changes, |s| s.pending.is_empty()).await;
}

#[tokio::test]
async fn sync_backend_is_ahead() {
    let ctx = TestContext::new();
    let mut factory = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "static-session-id",
    ));
    let store = ctx.make_store(ctx.adapter(), None).await;
    store.commit([session::todo_created("2", "t2")]).unwrap();
    ctx.mock
        .advance(vec![
            factory.next("todoCreated", todo_created_args("1", "t1")),
        ])
        .await;
    ctx.mock.take_pushed(1).await;
}

#[tokio::test]
async fn race_condition_between_client_session_and_sync_backend() {
    let ctx = TestContext::new();
    let mut factory = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "static-session-id",
    ));
    let store = ctx.make_store(ctx.adapter(), None).await;
    for i in 0..5 {
        let (mock, event) = (
            ctx.mock.clone(),
            factory.next(
                "todoCreated",
                todo_created_args(&format!("backend_{i}"), ""),
            ),
        );
        tokio::spawn(async move { mock.advance(vec![event]).await });
    }
    for i in 0..5 {
        store
            .commit([session::todo_created(&format!("local_{i}"), "")])
            .unwrap();
    }
    ctx.mock.take_pushed(5).await;
}

#[tokio::test]
async fn client_document_pending_events_confirm_after_upstream_advance() {
    let ctx = TestContext::new();
    let mut backend = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "static-session-id",
    ));
    let store = ctx.make_store(ctx.adapter(), None).await;
    store
        .commit([session::app_config().set(json!({ "theme": "dark" }), Some("session-a"))])
        .unwrap();

    let processor = store.sync_processor();
    let initial = processor.sync_state();
    assert_ne!(initial.pending, [] as [Event; 0]);
    assert!(initial.pending[0].seq_num.client > 0);
    assert_eq!(initial.pending[0].name, "app_configSet");

    let mut changes = processor.sync_state_changes();
    ctx.mock
        .advance(vec![
            backend.next("todoCreated", todo_created_args("backend_rebase", "")),
        ])
        .await;
    tokio::time::timeout(
        Duration::from_secs(2),
        wait_for_state(&mut changes, |s| {
            s.pending.is_empty() && s.local_head == s.upstream_head
        }),
    )
    .await
    .expect("confirmed within 2 seconds");

    let fin = processor.sync_state();
    assert_eq!(fin.pending, [] as [Event; 0]);
    assert_eq!(fin.local_head, fin.upstream_head);
}

#[tokio::test]
async fn should_fail_for_event_that_is_not_larger_than_expected_upstream() {
    let shutdown_deferred = livestore::make_shutdown_deferred();
    let (pull_tx, pull) = pull_from_queue();
    let adapter = InMemoryAdapter {
        leader_thread_proxy: Some(scripted_proxy(pull, push(|_| async { Ok(()) }))),
        ..InMemoryAdapter::default()
    };
    let mut options = StoreOptions::new(session::schema(), adapter.build(), "not-larger");
    options.shutdown_deferred = Some(shutdown_deferred.clone());
    let _store = create_store(options).await.unwrap();

    let event = encoded(
        "todoCreated",
        todo_created_args("id_0", ""),
        SeqNum::new(1, 0, 0),
        SeqNum::ROOT,
        "other-client",
        "static-session-id",
    );
    for _ in 0..2 {
        pull_tx.send(advance(vec![event.clone()])).unwrap();
    }

    // Merge invariant violations are defects (not typed errors).
    let exit = livestore::await_shutdown(&shutdown_deferred).await;
    assert_eq!(
        defect_of(&exit).message(),
        "Incoming events must be greater than upstream head. Expected greater than: e1. Received: [e1]"
    );
}

// Scenario: the client reboots with persisted pending changes and pulls conflicting ones from the backend while
// booting; the rebased changes must reach the session.
#[tokio::test]
async fn client_should_push_pending_persisted_events_on_start() {
    let ctx = TestContext::new();
    let mut factory = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "other-client-session1",
    ));
    ctx.mock
        .advance(vec![
            factory.next("todoCreated", todo_created_args("backend_0", "t2")),
        ])
        .await;

    let make_leader_db: livestore::adapter::LeaderDbFactory = Arc::new(|schema| {
        let db = LeaderDb::open_in_memory(schema).unwrap();
        let event = encoded(
            "todoCreated",
            todo_created_args("client_0", "t1"),
            SeqNum::new(1, 0, 0),
            SeqNum::ROOT,
            "client",
            "client-session1",
        );
        db.persist_local(&[event]).unwrap();
        db
    });
    let adapter = InMemoryAdapter {
        sync: Some(SyncOptions {
            backend: Some(ctx.mock.constructor()),
            initial_sync: InitialSyncOptions::Blocking {
                timeout: Duration::from_secs(5),
            },
            ..SyncOptions::default()
        }),
        make_leader_db: Some(make_leader_db),
        ..InMemoryAdapter::default()
    };
    let mut options =
        StoreOptions::new(session::schema(), adapter.build(), "push-pending-on-start");
    options.shutdown_deferred = Some(ctx.shutdown_deferred.clone());
    let store = create_store(options).await.unwrap();
    let mut changes = store.sync_processor().sync_state_changes();

    // Wait for the sync backend to receive the pushed event
    ctx.mock.take_pushed(1).await;
    // Wait for the completed e2 transition, rather than assuming backend receipt means the session rebased.
    if store.sync_processor().sync_state().local_head.global != 2 {
        wait_for_state(&mut changes, |s| s.local_head.global == 2).await;
    }

    let res = store.query(
        &TODOS
            .query()
            .order_by("text", livestore_schema::query_builder::Direction::Asc),
    );
    assert_eq!(
        res,
        json!([
            { "id": "client_0", "text": "t1", "completed": false, "deletedAt": null },
            { "id": "backend_0", "text": "t2", "completed": false, "deletedAt": null },
        ])
    );
    assert_eq!(
        state_head(&store),
        store.sync_processor().sync_state().local_head
    );
}

#[tokio::test]
async fn drains_in_flight_and_queued_leader_pushes_serially_on_shutdown() {
    let (first_push_started, release_first_push) = (Deferred::<()>::new(), Deferred::<()>::new());
    let persisted = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
    let active = Arc::new(Mutex::new((true, 0usize, 0usize))); // (is first, active, max active)
    let h = Harness::new(HarnessOptions::new({
        let (first_push_started, release_first_push, persisted, active) = (
            first_push_started.clone(),
            release_first_push.clone(),
            persisted.clone(),
            active.clone(),
        );
        push(move |batch| {
            let (first_push_started, release_first_push, persisted, active) = (
                first_push_started.clone(),
                release_first_push.clone(),
                persisted.clone(),
                active.clone(),
            );
            async move {
                let is_first = {
                    let mut a = active.lock().unwrap();
                    a.1 += 1;
                    a.2 = a.2.max(a.1);
                    std::mem::replace(&mut a.0, false)
                };
                if is_first {
                    first_push_started.done();
                    release_first_push.wait().await;
                }
                persisted.lock().unwrap().push(ids(&batch));
                active.lock().unwrap().1 -= 1;
                Ok(())
            }
        })
    }));

    h.push_ids(&["first"]).unwrap();
    first_push_started.wait().await;
    h.push_ids(&["second"]).unwrap();
    h.push_ids(&["third"]).unwrap();

    let processor = h.processor.clone();
    let close = tokio::spawn(async move { processor.shutdown(Ok(())).await });
    h.processor.await_drain_started().await;
    release_first_push.done();
    close.await.unwrap().unwrap();

    let post_shutdown = h.push_ids(&["post-shutdown"]);

    assert_eq!(active.lock().unwrap().2, 1, "maxActivePushCount");
    assert_eq!(
        *persisted.lock().unwrap(),
        [vec!["first"], vec!["second"], vec!["third"]]
    );
    assert!(post_shutdown.is_err());
}

#[tokio::test]
async fn publishes_local_pending_state_before_the_leader_worker_observes_the_batch() {
    let observed = Deferred::<bool>::new();
    let processor_ref: Arc<Mutex<Option<livestore::ClientSessionSyncProcessor>>> = Arc::default();
    let h = Harness::new(HarnessOptions::new({
        let (observed, processor_ref) = (observed.clone(), processor_ref.clone());
        push(move |batch: Vec<Event>| {
            let processor = processor_ref
                .lock()
                .unwrap()
                .clone()
                .expect("Processor not initialized");
            let pending = processor.sync_state().pending;
            observed.succeed(batch.iter().all(|e| {
                pending
                    .iter()
                    .any(|p| livestore_core::is_equal_encoded(p, e))
            }));
            async { Ok(()) }
        })
    }));
    *processor_ref.lock().unwrap() = Some(h.processor.clone());

    h.push_ids(&["local"]).unwrap();

    assert!(observed.wait().await);
    h.close(Ok(())).await.unwrap();
}

#[tokio::test]
async fn preserves_event_order_and_batch_bounds_through_graceful_shutdown() {
    // 50 generated cases like the TS property test: batch size 1..=5, up to 6 groups of 1..=4 events.
    let mut seed: u64 = 0x5eed;
    let mut next = |n: u64| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % n
    };
    for _ in 0..50 {
        let batch_size = usize::try_from(next(5)).expect("small modulus") + 1;
        let groups: Vec<usize> = (0..next(7))
            .map(|_| usize::try_from(next(4)).expect("small modulus") + 1)
            .collect();
        let persisted = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let mut options = HarnessOptions::new({
            let persisted = persisted.clone();
            push(move |batch| {
                persisted.lock().unwrap().push(ids(&batch));
                async { Ok(()) }
            })
        });
        options.leader_push_batch_size = batch_size;
        let h = Harness::new(options);

        let mut expected: Vec<String> = vec![];
        for size in &groups {
            let group: Vec<String> = (0..*size)
                .map(|i| format!("event-{}", expected.len() + i))
                .collect();
            expected.extend(group.clone());
            h.push_ids(&group.iter().map(String::as_str).collect::<Vec<_>>())
                .unwrap();
        }
        h.close(Ok(())).await.unwrap();

        let batches = persisted.lock().unwrap().clone();
        assert_eq!(
            batches.concat(),
            expected,
            "batch size {batch_size}, groups {groups:?}"
        );
        assert!(
            batches
                .iter()
                .all(|b| !b.is_empty() && b.len() <= batch_size)
        );
    }
}

// F1 no-loss oracle: a push admitted while a rebase waits for the in-flight push to stop must remain
// pending, be published, and eventually reach the leader.
#[tokio::test]
async fn does_not_lose_a_push_admitted_while_a_rebase_cancels_the_in_flight_push() {
    let (pull_tx, pull) = pull_from_queue();
    let first_push_started = Deferred::<()>::new();
    let persisted = Arc::new(Mutex::new(Vec::<String>::new()));
    let barrier = RebaseBarrier::new();
    let mut options = HarnessOptions::new(blocking_first_push(
        first_push_started.clone(),
        persisted.clone(),
    ));
    options.pull = pull;
    options.rebase_barriers.insert(
        RebaseBarrierPoint::BeforeLeaderPushFiberInterrupt,
        barrier.effect(),
    );
    let h = Harness::new(options);
    let mut changes = h.processor.sync_state_changes();

    h.push_ids(&["local"]).unwrap();
    first_push_started.wait().await;

    // Force the rebase and let it park before it interrupts the in-flight push.
    pull_tx.send(conflicting_upstream()).unwrap();
    barrier.reached.wait().await;

    // Concurrently admit a new push while the rebase is parked (models a synchronous `store.commit()`).
    h.push_ids(&["concurrent"]).unwrap();

    // Discard both synchronous admission notifications. The next change must be the completed pull publication.
    changes.next().await.unwrap();
    changes.next().await.unwrap();
    let published = tokio::spawn(async move { changes.next().await });

    // Resume the rebase: it must re-read the live pending suffix and preserve 'concurrent'.
    barrier.release.done();
    let published = published.await.unwrap().expect("a published state");
    assert!(ids(&published.pending).contains(&"concurrent".to_string()));

    // Draining via orderly shutdown flushes every queued event to the leader.
    h.close(Ok(())).await.unwrap();

    assert_eq!(h.processor.debug_info().rebase_count, 1);
    let persisted = persisted.lock().unwrap();
    assert!(persisted.contains(&"concurrent".to_string()));
    assert!(persisted.contains(&"local".to_string()));
}

// Shutdown enters the same mailbox as pull reconciliation. Even when requested at an async rebase barrier, it must
// run after that pull turn and flush the complete rebased suffix.
#[tokio::test]
async fn does_not_lose_the_rebased_pending_event_when_shutdown_interleaves_at_barrier_point() {
    for point in [
        RebaseBarrierPoint::BeforeLeaderPushFiberInterrupt,
        RebaseBarrierPoint::BeforeLeaderPushFiberRun,
    ] {
        let (pull_tx, pull) = pull_from_queue();
        let first_push_started = Deferred::<()>::new();
        let persisted = Arc::new(Mutex::new(Vec::<String>::new()));
        let barrier = RebaseBarrier::new();
        let mut options = HarnessOptions::new(blocking_first_push(
            first_push_started.clone(),
            persisted.clone(),
        ));
        options.pull = pull;
        options.rebase_barriers.insert(point, barrier.effect());
        let h = Harness::new(options);

        h.push_ids(&["local"]).unwrap();
        first_push_started.wait().await;

        pull_tx.send(conflicting_upstream()).unwrap();
        barrier.reached.wait().await;

        // Shutdown is queued behind the active pull turn, so it cannot drain until the rebase has rebuilt propagation.
        let processor = h.processor.clone();
        let close = tokio::spawn(async move { processor.shutdown(Ok(())).await });
        barrier.release.done();
        close.await.unwrap().unwrap();

        assert_eq!(h.processor.debug_info().rebase_count, 1, "{point:?}");
        assert_eq!(*persisted.lock().unwrap(), ["local"], "{point:?}");
    }
}

// A push being cancelled for a rebase is superseded by that rebase. Its late rejection must not leave a fence that
// blocks the rebuilt propagation.
#[tokio::test]
async fn ignores_a_rejection_that_arrives_while_a_rebase_cancels_the_push() {
    let (pull_tx, pull) = pull_from_queue();
    let (first_push_started, reject_first_push, first_push_rejected) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let persisted = Arc::new(Mutex::new(Vec::<String>::new()));
    let push_count = Arc::new(AtomicUsize::new(0));
    let barrier = RebaseBarrier::new();
    let mut options = HarnessOptions::new({
        let (started, reject, rejected, persisted) = (
            first_push_started.clone(),
            reject_first_push.clone(),
            first_push_rejected.clone(),
            persisted.clone(),
        );
        push(move |batch: Vec<Event>| {
            let n = push_count.fetch_add(1, Ordering::SeqCst) + 1;
            let (started, reject, rejected, persisted) = (
                started.clone(),
                reject.clone(),
                rejected.clone(),
                persisted.clone(),
            );
            async move {
                if n != 1 {
                    persisted.lock().unwrap().extend(ids(&batch));
                    return Ok(());
                }
                let _ensuring = OnDrop::new(move || rejected.done());
                started.done();
                reject.wait().await;
                Err(LeaderPushFailure::Rejected(leader_ahead_at_root()))
            }
        })
    });
    options.pull = pull;
    options.rebase_barriers.insert(
        RebaseBarrierPoint::BeforeLeaderPushFiberInterrupt,
        barrier.effect(),
    );
    let h = Harness::new(options);

    h.push_ids(&["local"]).unwrap();
    first_push_started.wait().await;
    pull_tx.send(conflicting_upstream()).unwrap();
    barrier.reached.wait().await;

    // The owner has already marked the push as cancelling, so this rejection belongs to a superseded operation.
    reject_first_push.done();
    first_push_rejected.wait().await;
    barrier.release.done();

    h.close(Ok(())).await.unwrap();
    assert_eq!(h.processor.debug_info().rebase_count, 1);
    assert_eq!(*persisted.lock().unwrap(), ["local"]);
}

#[tokio::test]
async fn interrupts_a_hung_leader_push_during_failed_shutdown() {
    let (first_push_started, first_push_interrupted) =
        (Deferred::<()>::new(), Deferred::<()>::new());
    let shutdown_calls = Arc::new(AtomicUsize::new(0));
    let mut options = HarnessOptions::new({
        let (started, interrupted) = (first_push_started.clone(), first_push_interrupted.clone());
        push(move |_| {
            let (started, interrupted) = (started.clone(), interrupted.clone());
            async move {
                let _on_interrupt = OnDrop::new(move || interrupted.done());
                started.done();
                never::<Result<(), LeaderPushFailure>>().await
            }
        })
    });
    options.shutdown = {
        let calls = shutdown_calls.clone();
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async {}.boxed()
        })
    };
    let h = Harness::new(options);

    h.push_ids(&["blocked"]).unwrap();
    first_push_started.wait().await;

    let _ = h
        .close(Err(StoreError::Unknown("test shutdown failure".into())))
        .await;

    assert!(first_push_interrupted.is_done());
    assert_eq!(shutdown_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn does_not_report_a_successful_drain_when_the_leader_rejects_during_shutdown() {
    let (push_started, reject_push) = (Deferred::<()>::new(), Deferred::<()>::new());
    let h = Harness::new(HarnessOptions::new(rejecting_push(
        push_started.clone(),
        reject_push.clone(),
    )));

    h.push_ids(&["rejected"]).unwrap();
    push_started.wait().await;

    let processor = h.processor.clone();
    let close = tokio::spawn(async move { processor.shutdown(Ok(())).await });
    h.processor.await_drain_started().await;
    reject_push.done();

    assert!(close.await.unwrap().is_err());
}

#[tokio::test]
async fn fails_the_drain_when_pull_stops_before_a_leader_rejection_can_recover() {
    let (pull_stopped, push_started, reject_push) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let mut options =
        HarnessOptions::new(rejecting_push(push_started.clone(), reject_push.clone()));
    options.pull = {
        let pull_stopped = pull_stopped.clone();
        Arc::new(move |_| {
            let stopped = pull_stopped.clone();
            let ensuring = OnDrop::new(move || stopped.done());
            futures::stream::pending::<Result<PullItem, Defect>>()
                .map(move |item| {
                    let _ = &ensuring;
                    item
                })
                .boxed()
        })
    };
    let h = Harness::new(options);

    h.push_ids(&["rejected-after-pull"]).unwrap();
    push_started.wait().await;

    let processor = h.processor.clone();
    let close = tokio::spawn(async move { processor.shutdown(Ok(())).await });
    pull_stopped.wait().await;
    reject_push.done();

    assert!(close.await.unwrap().is_err());
}

#[tokio::test]
async fn does_not_treat_an_unrelated_pull_advance_as_recovery_from_a_rejected_push() {
    let (pull_tx, pull) = pull_from_queue();
    let push_returned = Deferred::<()>::new();
    let mut options = HarnessOptions::new({
        let returned = push_returned.clone();
        push(move |_| {
            let returned = returned.clone();
            async move {
                returned.done();
                Err(LeaderPushFailure::Rejected(leader_ahead_at_root()))
            }
        })
    });
    options.pull = pull;
    let h = Harness::new(options);
    let mut changes = h.processor.sync_state_changes();

    h.push_ids(&["still-pending"]).unwrap();
    // Drain the local-push notification so the next observed change belongs to the explicit upstream payload.
    changes.next().await.unwrap();
    push_returned.wait().await;
    h.processor.await_rejection().await;

    pull_tx.send(advance(vec![])).unwrap();
    changes.next().await.unwrap();

    let close = h.close(Ok(())).await;

    assert!(close.is_err());
    assert_eq!(ids(&h.processor.sync_state().pending), ["still-pending"]);
}

#[tokio::test]
async fn does_not_leave_a_fence_behind_when_pull_recovers_an_in_flight_push_before_it_rejects() {
    let (pull_tx, pull) = pull_from_queue();
    let (first_push_started, release_first_push, later_push_accepted) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let push_count = Arc::new(AtomicUsize::new(0));
    let mut options = HarnessOptions::new({
        let (started, release, accepted) = (
            first_push_started.clone(),
            release_first_push.clone(),
            later_push_accepted.clone(),
        );
        push(move |_| {
            let n = push_count.fetch_add(1, Ordering::SeqCst) + 1;
            let (started, release, accepted) = (started.clone(), release.clone(), accepted.clone());
            async move {
                if n != 1 {
                    accepted.done();
                    return Ok(());
                }
                started.done();
                release.wait().await;
                Err(LeaderPushFailure::Rejected(leader_ahead_at_root()))
            }
        })
    });
    options.pull = pull;
    let h = Harness::new(options);

    let in_flight = h.push_ids(&["in-flight"]).unwrap().remove(0);
    first_push_started.wait().await;

    let mut changes = h.processor.sync_state_changes();
    let recovered =
        tokio::spawn(async move { wait_for_state(&mut changes, |s| s.pending.is_empty()).await });
    pull_tx.send(advance(vec![in_flight])).unwrap();
    recovered.await.unwrap();

    release_first_push.done();
    h.processor.await_rejection().await;
    h.push_ids(&["after-late-rejection"]).unwrap();
    later_push_accepted.wait().await;

    assert!(h.close(Ok(())).await.is_ok());
}

#[tokio::test]
async fn reseeds_the_complete_pending_suffix_when_a_rebase_recovers_a_rejection() {
    let (pull_tx, pull) = pull_from_queue();
    let (first_push_rejected, rebased_suffix_accepted) =
        (Deferred::<()>::new(), Deferred::<()>::new());
    let accepted = Arc::new(Mutex::new(Vec::<String>::new()));
    let push_count = Arc::new(AtomicUsize::new(0));
    let mut options = HarnessOptions::new({
        let (rejected, suffix_accepted, accepted) = (
            first_push_rejected.clone(),
            rebased_suffix_accepted.clone(),
            accepted.clone(),
        );
        push(move |batch: Vec<Event>| {
            let n = push_count.fetch_add(1, Ordering::SeqCst) + 1;
            let (rejected, suffix_accepted, accepted) =
                (rejected.clone(), suffix_accepted.clone(), accepted.clone());
            async move {
                if n == 1 {
                    rejected.done();
                    return Err(LeaderPushFailure::Rejected(leader_ahead_at_root()));
                }
                let count = {
                    let mut a = accepted.lock().unwrap();
                    a.extend(ids(&batch));
                    a.len()
                };
                if count >= 2 {
                    suffix_accepted.done();
                }
                Ok(())
            }
        })
    });
    options.pull = pull;
    let h = Harness::new(options);

    h.push_ids(&["rejected-prefix"]).unwrap();
    first_push_rejected.wait().await;
    h.processor.await_rejection().await;
    h.push_ids(&["newer-pending"]).unwrap();
    yield_now().await;
    assert!(accepted.lock().unwrap().is_empty());

    pull_tx.send(conflicting_upstream()).unwrap();
    rebased_suffix_accepted.wait().await;

    assert!(h.close(Ok(())).await.is_ok());
    assert_eq!(
        *accepted.lock().unwrap(),
        ["rejected-prefix", "newer-pending"]
    );
}

#[tokio::test]
async fn fences_newer_admitted_events_until_the_rejected_prefix_is_recovered() {
    let (pull_tx, pull) = pull_from_queue();
    let (second_push_accepted, first_push_rejected) =
        (Deferred::<()>::new(), Deferred::<()>::new());
    let push_count = Arc::new(AtomicUsize::new(0));
    let mut options = HarnessOptions::new({
        let (accepted, rejected) = (second_push_accepted.clone(), first_push_rejected.clone());
        push(move |_| {
            let n = push_count.fetch_add(1, Ordering::SeqCst) + 1;
            let (accepted, rejected) = (accepted.clone(), rejected.clone());
            async move {
                if n == 1 {
                    rejected.done();
                    return Err(LeaderPushFailure::Rejected(leader_ahead_at_root()));
                }
                accepted.done();
                Ok(())
            }
        })
    });
    options.pull = pull;
    let h = Harness::new(options);
    let mut changes = h.processor.sync_state_changes();

    let rejected_event = h.push_ids(&["rejected-prefix"]).unwrap().remove(0);
    first_push_rejected.wait().await;
    h.processor.await_rejection().await;
    h.push_ids(&["newer-admitted"]).unwrap();
    yield_now().await;
    assert!(!second_push_accepted.is_done());
    // Drain both local notifications so the next one proves the upstream confirmation was processed.
    changes.next().await.unwrap();
    changes.next().await.unwrap();

    pull_tx.send(advance(vec![rejected_event])).unwrap();
    changes.next().await.unwrap();
    second_push_accepted.wait().await;

    let close = h.close(Ok(())).await;

    assert!(close.is_ok());
    assert_eq!(ids(&h.processor.sync_state().pending), ["newer-admitted"]);
}

#[tokio::test]
async fn propagates_a_fatal_leader_push_from_the_graceful_drain() {
    let (push_started, fail_push) = (Deferred::<()>::new(), Deferred::<()>::new());
    let failure = Defect::msg("leader push crashed");
    let h = Harness::new(HarnessOptions::new({
        let (started, fail, failure) = (push_started.clone(), fail_push.clone(), failure.clone());
        push(move |_| {
            let (started, fail, failure) = (started.clone(), fail.clone(), failure.clone());
            async move {
                started.done();
                fail.wait().await;
                Err(LeaderPushFailure::Defect(failure))
            }
        })
    }));

    h.push_ids(&["fatal"]).unwrap();
    push_started.wait().await;

    let processor = h.processor.clone();
    let close = tokio::spawn(async move { processor.shutdown(Ok(())).await });
    h.processor.await_drain_started().await;
    fail_push.done();
    let exit = close.await.unwrap();

    assert!(
        defect_of(&exit).ptr_eq(&failure),
        "expected graceful drain to fail with the push defect"
    );
}

#[tokio::test]
async fn store_shutdown_timeout_stops_waiting_without_cancelling_teardown() {
    let ctx = TestContext::new();
    let (push_started, release_push, push_completed, push_interrupted) = (
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
        Deferred::<()>::new(),
    );
    let push_fn = {
        let (started, release, completed, interrupted) = (
            push_started.clone(),
            release_push.clone(),
            push_completed.clone(),
            push_interrupted.clone(),
        );
        push(move |_| {
            let (started, release, completed, interrupted) = (
                started.clone(),
                release.clone(),
                completed.clone(),
                interrupted.clone(),
            );
            async move {
                let on_interrupt = OnDrop::new(move || interrupted.done());
                started.done();
                release.wait().await;
                completed.done();
                on_interrupt.disarm();
                Ok(())
            }
        })
    };
    let store = ctx
        .make_store(
            InMemoryAdapter {
                leader_thread_proxy: Some(with_push(push_fn)),
                ..ctx.adapter()
            },
            None,
        )
        .await;

    store
        .commit([session::todo_created("blocked", "blocked")])
        .unwrap();
    push_started.wait().await;

    // The store's soft bound is one second.
    store.shutdown(None).await;

    assert!(!push_completed.is_done());
    assert!(!push_interrupted.is_done());

    release_push.done();
    push_completed.wait().await;
}

/// Regression guard for livestorejs/livestore#744: pushes after a rebase carry the rebase generation into both
/// the child and parent sequence numbers.
#[tokio::test]
async fn rebased_pushes_carry_rebase_generation_forward() {
    let base_head = SeqNum::new(10, 0, 4);
    let recorded = Arc::new(Mutex::new(Vec::<Event>::new()));
    let mut options = HarnessOptions::new(push(|_| async { Ok(()) }));
    options.leader_head = base_head;
    options.leader_push_batch_size = 10;
    options.materialize_event = {
        let recorded = recorded.clone();
        Arc::new(move |event, _| {
            recorded.lock().unwrap().push(event.clone());
            Ok(MaterializeOutput::default())
        })
    };
    let h = Harness::new(options);
    h.processor
        .commit(vec![todo_created_input("post-rebase")])
        .unwrap();

    let recorded = recorded.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].seq_num, SeqNum::new(11, 0, 4));
    assert_eq!(
        recorded[0].seq_num.rebase_generation,
        base_head.rebase_generation
    );
    assert_eq!(
        recorded[0].parent_seq_num.rebase_generation,
        base_head.rebase_generation
    );
}

// A non-pure materializer (`todoDeletedNonPure`) yields different statements on the leader and in the session. The
// leader publishes its hash beside the pulled event, and the session must fail when its own hash differs.
#[tokio::test]
async fn should_fail_gracefully_if_materializer_is_side_effecting() {
    let ctx = TestContext::new();
    let published = Arc::new(Mutex::new(Vec::<MaterializerHash>::new()));
    let tap: livestore::adapter::ProxyOverride = {
        let published = published.clone();
        Arc::new(move |proxy: LeaderThreadProxy| {
            let (inner, published) = (proxy.pull.clone(), published.clone());
            let pull: PullFn = Arc::new(move |cursor| {
                let published = published.clone();
                inner(cursor)
                    .inspect(move |item| {
                        if let Ok(item) = item {
                            published
                                .lock()
                                .unwrap()
                                .extend(item.materializer_hashes.clone());
                        }
                    })
                    .boxed()
            });
            LeaderThreadProxy { pull, ..proxy }
        })
    };
    let _store = ctx
        .make_store(
            InMemoryAdapter {
                leader_thread_proxy: Some(tap),
                ..ctx.adapter()
            },
            None,
        )
        .await;
    let mut other = EventFactory::new(ClientIdentity::with_session(
        "other-client",
        "other-session",
    ));

    ctx.mock
        .advance(vec![other.next("todoDeletedNonPure", json!({ "id": "1" }))])
        .await;

    let error = ctx.shutdown_exit().await.expect_err("failed shutdown");
    assert_eq!(error.tag(), "MaterializeError");
    let published = published.lock().unwrap();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].event_num.global, 1);
    assert!(published[0].hash.is_some());
}

// A confirmed local event is not re-materialized, so the session compares the hash it recorded at commit time with
// the hash the leader publishes when it confirms the event.
#[tokio::test]
async fn should_fail_when_the_leader_confirms_a_local_event_with_a_different_materializer_hash() {
    let ctx = TestContext::new();
    let store = ctx.make_store(ctx.adapter(), None).await;

    store
        .commit([EventInput::from(
            TODO_DELETED_NON_PURE.make(TodoId { id: "1".into() }),
        )])
        .unwrap();

    let error = ctx.shutdown_exit().await.expect_err("failed shutdown");
    assert_eq!(
        error,
        StoreError::Materialize(MaterializeCause::MaterializerHashMismatch {
            event_name: "todoDeletedNonPure".into()
        })
    );
}

// Materializer hashes are leader publication metadata rather than mutable event fields.
#[tokio::test]
async fn should_fail_gracefully_if_client_session_side_materializer_hash_mismatch_is_detected() {
    let ctx = TestContext::new();
    let (pull_tx, pull_rx) = mpsc::unbounded_channel::<Event>();
    let rx = Arc::new(tokio::sync::Mutex::new(pull_rx));
    let pull: PullFn = Arc::new(move |_| {
        let rx = rx.clone();
        futures::stream::unfold(rx, |rx| async move {
            let event = rx.lock().await.recv().await?;
            let item = PullItem {
                materializer_hashes: vec![MaterializerHash {
                    event_num: event.seq_num,
                    hash: Some(99),
                }],
                ..PullItem::new(advance(vec![event]))
            };
            Some((Ok(item), rx))
        })
        .boxed()
    });
    let _store = ctx
        .make_store(
            InMemoryAdapter {
                leader_thread_proxy: Some(scripted_proxy(pull, push(|_| async { Ok(()) }))),
                ..ctx.adapter()
            },
            None,
        )
        .await;

    // An event from the leader with a hash that won't match the client-side materializer's computed hash.
    let from_leader = encoded(
        "todoCreated",
        todo_created_args("test-id", "from-leader"),
        SeqNum::new(0, 1, 0),
        SeqNum::ROOT,
        "this-client",
        "static-session-id",
    );
    pull_tx.send(from_leader).unwrap();

    let error = ctx.shutdown_exit().await.expect_err("failed shutdown");
    assert_eq!(error.tag(), "MaterializeError");
}

#[tokio::test]
async fn unknown_upstream_events_still_invoke_materialize_event() {
    let (pull_tx, pull) = pull_from_queue();
    let materialized = Arc::new(Mutex::new(Vec::<Event>::new()));
    let mut options = HarnessOptions::new(push(|_| async { Ok(()) }));
    options.pull = pull;
    options.leader_push_batch_size = 10;
    options.materialize_event = {
        let materialized = materialized.clone();
        Arc::new(move |event, _| {
            materialized.lock().unwrap().push(event.clone());
            Ok(MaterializeOutput::default())
        })
    };
    let h = Harness::new(options);
    let unknown = encoded(
        "unknown_event_test",
        json!({ "foo": "bar" }),
        SeqNum::new(1, 0, 0),
        SeqNum::ROOT,
        "remote-client",
        "remote-session",
    );

    let mut changes = h.processor.sync_state_changes();
    let processed =
        tokio::spawn(
            async move { wait_for_state(&mut changes, |s| s.local_head.global == 1).await },
        );
    pull_tx.send(advance(vec![unknown])).unwrap();
    processed.await.unwrap();
    h.close(Ok(())).await.unwrap();

    let materialized = materialized.lock().unwrap();
    assert_eq!(materialized.len(), 1);
    assert_eq!(materialized[0].name, "unknown_event_test");
}

// Closing the scope a store was created in is an orderly shutdown: an event committed right before the close must
// reach the leader (and be acknowledged) before the close returns, instead of being dropped with the scope.
#[tokio::test]
async fn drains_a_commit_made_right_before_its_scope_closes() {
    let acknowledged = Arc::new(Mutex::new(Vec::<String>::new()));
    let push_fn = {
        let acknowledged = acknowledged.clone();
        push(move |batch: Vec<Event>| {
            let acknowledged = acknowledged.clone();
            // A slow leader makes the close observably wait for the acknowledgement.
            async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                acknowledged.lock().unwrap().extend(ids(&batch));
                Ok(())
            }
        })
    };
    let never_pull: PullFn = Arc::new(|_| futures::stream::pending().boxed());
    let adapter = InMemoryAdapter {
        leader_thread_proxy: Some(scripted_proxy(never_pull, push_fn)),
        ..InMemoryAdapter::default()
    };
    let store = create_store(StoreOptions::new(
        session::schema(),
        adapter.build(),
        "drain-on-scope-close",
    ))
    .await
    .unwrap();

    store
        .commit([session::todo_created("last-commit", "last")])
        .unwrap();
    assert!(acknowledged.lock().unwrap().is_empty());

    store.close().await;

    assert_eq!(*acknowledged.lock().unwrap(), ["last-commit"]);
}

#[tokio::test]
async fn push_fiber_triggers_shutdown_on_non_rejected_push_error() {
    let ctx = TestContext::new();
    let push_error = Defect::msg("unexpected transport failure");
    let push_fn = {
        let push_error = push_error.clone();
        push(move |_| {
            let e = push_error.clone();
            async move { Err(LeaderPushFailure::Defect(e)) }
        })
    };
    let store = ctx
        .make_store(
            InMemoryAdapter {
                leader_thread_proxy: Some(with_push(push_fn)),
                ..ctx.adapter()
            },
            None,
        )
        .await;

    store
        .commit([session::todo_created("trigger", "boom")])
        .unwrap();

    let exit = ctx.shutdown_exit().await;
    assert_eq!(defect_of(&exit).message(), "unexpected transport failure");
}

use livestore::EventInput;

fn todo_created_input(id: &str) -> EventInput {
    TODO_CREATED
        .make(TodoCreated {
            id: id.into(),
            text: id.into(),
            completed: Some(false),
        })
        .into()
}

fn ids_of(events: &Arc<Mutex<Vec<Event>>>) -> Vec<String> {
    ids(&events.lock().unwrap())
}

/// First push blocks forever (until interrupted); later pushes record their ids.
fn blocking_first_push(
    first_push_started: Deferred<()>,
    persisted: Arc<Mutex<Vec<String>>>,
) -> livestore::session::PushFn {
    let count = Arc::new(AtomicUsize::new(0));
    push(move |batch: Vec<Event>| {
        let n = count.fetch_add(1, Ordering::SeqCst) + 1;
        let (started, persisted) = (first_push_started.clone(), persisted.clone());
        async move {
            if n == 1 {
                started.done();
                return never().await;
            }
            persisted.lock().unwrap().extend(ids(&batch));
            Ok(())
        }
    })
}

fn rejecting_push(
    push_started: Deferred<()>,
    reject_push: Deferred<()>,
) -> livestore::session::PushFn {
    push(move |_| {
        let (started, reject) = (push_started.clone(), reject_push.clone());
        async move {
            started.done();
            reject.wait().await;
            Err(LeaderPushFailure::Rejected(leader_ahead_at_root()))
        }
    })
}

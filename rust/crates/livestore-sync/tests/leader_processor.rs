#![allow(clippy::result_large_err)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use common::{TodoFactory, backend_factory, factory, fixture_schema};
use futures::{StreamExt, stream};
use livestore_core::{Event, Payload, SeqNum, SyncState};
use livestore_sync::testing::{
    ClientIdentity, EventFactory, MockSyncBackend, MockSyncBackendOptions, PushFailure, Sequence,
};
use livestore_sync::*;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

const T: Duration = Duration::from_secs(5);

#[tokio::test]
async fn pushes_events_pending_across_a_restart_exactly_once_when_the_first_page_rebases_them() {
    let dir = std::env::temp_dir().join(format!("ls-boot-race-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: false,
        ..Default::default()
    });
    let boot = || {
        Leader::builder(fixture_schema())
            .store_id("boot-race")
            .client_id("local")
            .storage(Storage::Files {
                state: dir.join("state.db"),
                eventlog: dir.join("eventlog.db"),
            })
            .sync(SyncOptions {
                backend: Some(mock.constructor()),
                live_pull: Some(true),
                ..Default::default()
            })
            .boot()
    };
    let mut local = factory("local", "session");
    let mut remote = factory("remote", "session");
    let ids = ["local-1", "local-2", "local-3"];

    let leader = boot().await.unwrap();
    leader
        .push(ids.iter().map(|id| local.todo(id, "local")).collect())
        .await
        .unwrap();
    leader.shutdown().await;
    drop(leader);

    mock.advance(vec![remote.todo_global("remote-1", "remote")])
        .await;
    mock.connect();
    let pushed = tokio::spawn({
        let mock = mock.clone();
        async move { mock.take_pushed(ids.len()).await }
    });

    let leader = boot().await.unwrap();
    let mut state = leader.sync_state();
    tokio::time::timeout(
        Duration::from_secs(10),
        state.wait_for(|s| {
            s.pending.is_empty() && s.upstream_head.global == i64::try_from(ids.len()).unwrap() + 1
        }),
    )
    .await
    .unwrap()
    .unwrap();
    leader.shutdown().await;

    let pushed = tokio::time::timeout(T, pushed).await.unwrap().unwrap();
    let pushed: Vec<(Value, i64)> = pushed
        .iter()
        .map(|e| (e.args["id"].clone(), e.seq_num))
        .collect::<Vec<_>>();
    assert_eq!(
        pushed,
        ids.iter()
            .enumerate()
            .map(|(i, id)| (json!(id), i64::try_from(i).unwrap() + 2))
            .collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(start_paused = true)]
async fn waits_for_connectivity_and_immediately_resumes_pulls_after_an_outage() {
    outage_recovery(true).await;
}

#[tokio::test(start_paused = true)]
async fn uses_bounded_fallback_probes_when_connection_state_is_stale() {
    outage_recovery(false).await;
}

#[tokio::test(start_paused = true)]
async fn wakes_a_stale_true_fallback_on_a_later_disconnect_and_reconnect() {
    let flaky = FlakyPull::default();
    let (waits_tx, mut waits) = mpsc::unbounded_channel();
    let testing = Testing {
        backend_pull_reconnect: Some(Arc::new(|fallback| {
            (fallback / 20).min(Duration::from_millis(400))
        })),
        backend_pull_reconnect_wait: Some(hook(move |w: ReconnectWait| {
            let tx = waits_tx.clone();
            async move { _ = tx.send(w) }
        })),
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync: live(),
        testing,
        wrap: Some(flaky.wrap(false)),
        ..Default::default()
    })
    .await;

    flaky.unavailable.store(true, Ordering::SeqCst);
    flaky.disconnect();
    let mut wait = waits.recv().await.unwrap();
    for attempt in 1..5 {
        assert!(wait.is_connected);
        assert_eq!(flaky.attempts.load(Ordering::SeqCst), attempt);
        wait = waits.recv().await.unwrap();
    }
    assert_eq!(flaky.attempts.load(Ordering::SeqCst), 5);
    assert!(wait.is_connected);
    assert_eq!(wait.fallback, Duration::from_millis(400));

    ctx.mock.disconnect();
    tokio::task::yield_now().await;
    ctx.mock
        .advance(vec![
            ctx.factory().todo_global("after-stale-true", "Recovered"),
        ])
        .await;
    flaky.unavailable.store(false, Ordering::SeqCst);
    flaky.recovered.store(true, Ordering::SeqCst);
    let connected_at = tokio::time::Instant::now();
    ctx.mock.connect();
    let mut state = ctx.leader.sync_state();
    tokio::time::timeout(
        Duration::from_millis(200),
        state.wait_for(|s| s.local_head.global == 1),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(connected_at.elapsed() <= Duration::from_millis(200));
    assert_eq!(ctx.ids(), ["after-stale-true"]);
}

#[tokio::test(start_paused = true)]
async fn resets_offline_backoff_after_a_healthy_fallback_pull() {
    let flaky = FlakyPull::default();
    let (waits_tx, mut waits) = mpsc::unbounded_channel();
    let testing = Testing {
        backend_pull_reconnect: Some(Arc::new(|fallback| {
            (fallback / 20).min(Duration::from_millis(400))
        })),
        backend_pull_reconnect_wait: Some(hook(move |w: ReconnectWait| {
            let tx = waits_tx.clone();
            async move { _ = tx.send(w) }
        })),
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync: live(),
        testing,
        wrap: Some(flaky.wrap(true)),
        ..Default::default()
    })
    .await;

    flaky.unavailable.store(true, Ordering::SeqCst);
    flaky.disconnect();
    for _ in 0..3 {
        assert!(waits.recv().await.unwrap().is_connected);
    }
    flaky.next_disconnect();
    ctx.mock
        .advance(vec![
            ctx.factory().todo_global("fallback-recovery", "Recovered"),
        ])
        .await;
    flaky.unavailable.store(false, Ordering::SeqCst);
    ctx.wait_state(|s| s.local_head.global == 1).await;
    flaky.unavailable.store(true, Ordering::SeqCst);
    flaky.disconnect();
    let next_wait = waits.recv().await.unwrap();
    assert!(next_wait.is_connected);
    assert!(
        next_wait.fallback >= Duration::from_millis(40)
            && next_wait.fallback <= Duration::from_millis(60)
    );
}

#[tokio::test]
async fn sync() {
    let ctx = Ctx::start(Opts::default()).await;
    let mut f = ctx.factory();
    ctx.push(vec![f.todo("1", "t1"), f.todo("2", "t2")])
        .await
        .unwrap();
    ctx.wait_state(|s| s.local_head.global == 2).await;
    assert_eq!(
        ctx.todos(),
        [
            json!({"id": "1", "text": "t1", "completed": 0, "deletedAt": null}),
            json!({"id": "2", "text": "t2", "completed": 0, "deletedAt": null})
        ]
    );
    assert_eq!(
        ctx.state_head(),
        ctx.leader.sync_state().borrow().local_head
    );
    tokio::time::timeout(T, ctx.mock.take_pushed(2))
        .await
        .unwrap();
}

#[tokio::test]
async fn publishes_leader_materializer_hashes_beside_pending_local_events() {
    let ctx = Ctx::start(Opts::default()).await;
    ctx.mock.disconnect();
    ctx.push(vec![ctx.factory().todo("local", "local")])
        .await
        .unwrap();
    let item = ctx.queue.lock().await.recv().await.unwrap();
    let Payload::UpstreamAdvance { new_events } = &item.payload else {
        panic!("{:?}", item.payload)
    };
    let retained = ctx.leader.sync_state().borrow().pending[0].clone();
    assert_eq!(retained, new_events[0]);
    assert_eq!(item.materializer_hashes.len(), 1);
    assert_eq!(item.materializer_hashes[0].event_num, retained.seq_num);
    assert!(item.materializer_hashes[0].hash.is_some());
}

#[tokio::test]
async fn applies_local_pushes_after_a_paginated_non_live_pull_ends_complete() {
    applies_local_pushes_after_pull_end(PullEnd::Complete).await;
}

#[tokio::test]
async fn applies_local_pushes_after_a_paginated_non_live_pull_ends_fail() {
    applies_local_pushes_after_pull_end(PullEnd::Fail).await;
}

#[tokio::test]
async fn applies_local_pushes_after_a_paginated_non_live_pull_ends_interrupt() {
    applies_local_pushes_after_pull_end(PullEnd::Interrupt).await;
}

#[tokio::test]
async fn releases_a_blocking_initial_sync_when_the_pull_fails_after_its_last_page() {
    let started_at = std::time::Instant::now();
    let (failed_tx, failed_rx) = watch::channel(false);
    let mock = MockSyncBackend::new(MockSyncBackendOptions::default());
    seed_paginated_backend_todos(&mock).await;
    let testing = Testing {
        upstream_batch_received: Some(hook(move |_| {
            let mut failed = failed_rx.clone();
            async move {
                let _ = failed.wait_for(|f| *f).await;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })),
        ..Default::default()
    };
    let failed_tx = Arc::new(failed_tx);
    let wrap = end_pull_after_first_page(move || {
        failed_tx.send_replace(true);
        Some(UnknownError::new("Simulated pull failure after the last page").into())
    });
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error: OnSyncError::Ignore,
        initial_sync: InitialSyncOptions::Blocking {
            timeout: Duration::from_secs(10),
        },
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        testing,
        mock: Some(mock),
        wrap: Some(wrap),
        ..Default::default()
    })
    .await;
    assert!(started_at.elapsed() < Duration::from_secs(5));
    let mut ids = ctx.ids();
    ids.sort();
    assert_eq!(ids, ["backend-1", "backend-2", "backend-3"]);
}

#[tokio::test]
async fn provider_push_defects_re_enter_the_machine_and_retry() {
    let should_defect = Arc::new(AtomicBool::new(true));
    let wrap: Wrap = Arc::new(move |inner| {
        let should_defect = should_defect.clone();
        BackendOverride::new(inner).push(move |inner, batch| {
            let defect = should_defect.swap(false, Ordering::SeqCst);
            let push = inner.push(batch);
            Box::pin(async move {
                assert!(!defect, "Simulated provider push defect");
                push.await
            })
        })
    });
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error: OnSyncError::Ignore,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        wrap: Some(wrap),
        ..Default::default()
    })
    .await;
    ctx.push(vec![ctx.factory().todo("push-after-defect", "retried")])
        .await
        .unwrap();
    let pushed = tokio::time::timeout(Duration::from_secs(4), ctx.mock.take_pushed(1))
        .await
        .unwrap();
    assert_eq!(pushed[0].args["id"], "push-after-defect");
}

#[tokio::test]
async fn provider_push_defects_follow_the_configured_shutdown_path() {
    let wrap: Wrap = Arc::new(|inner| {
        BackendOverride::new(inner)
            .push(|_, _| Box::pin(async { panic!("Simulated provider push defect") }))
    });
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error: OnSyncError::Shutdown,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        wrap: Some(wrap),
        ..Default::default()
    })
    .await;
    ctx.push(vec![ctx.factory().todo("push-defect", "defect")])
        .await
        .unwrap();
    assert_eq!(
        ctx.shutdown_cause(Duration::from_secs(3)).await.tag(),
        "UnknownError"
    );
}

#[tokio::test]
async fn provider_pull_defects_follow_the_configured_shutdown_path() {
    let wrap: Wrap = Arc::new(|inner| {
        BackendOverride::new(inner).pull(|_, _, _| {
            stream::once(async { panic!("Simulated provider pull defect") }).boxed()
        })
    });
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error: OnSyncError::Shutdown,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        wrap: Some(wrap),
        ..Default::default()
    })
    .await;
    assert_eq!(
        ctx.shutdown_cause(Duration::from_secs(3)).await.tag(),
        "UnknownError"
    );
}

#[tokio::test]
async fn local_push_old_gen_items_fail_promptly_with_stale_rebase_generation_error() {
    let ctx = Ctx::start(Opts::default()).await;
    let before = ctx.leader.sync_state().borrow().local_head;
    let stale_seq = SeqNum::new(before.global + 1, 0, before.rebase_generation - 1);
    let stale_parent = SeqNum {
        rebase_generation: before.rebase_generation - 1,
        ..before
    };
    let event = Event {
        seq_num: stale_seq,
        parent_seq_num: stale_parent,
        ..ctx.factory().todo("local-old-gen", "y")
    };
    let err = ctx.push(vec![event]).await.unwrap_err();
    let LeaderPushError::Rejected(err) = err else {
        panic!("{err:?}")
    };
    assert_eq!(err.tag(), "StaleRebaseGenerationError");
    let RejectedPushError::StaleRebaseGeneration {
        current_rebase_generation,
        provided_rebase_generation,
        ..
    } = err
    else {
        panic!()
    };
    assert_eq!(current_rebase_generation, before.rebase_generation);
    assert_eq!(provided_rebase_generation, stale_seq.rebase_generation);
}

#[tokio::test]
async fn invalid_push() {
    let ctx = Ctx::start(Opts::default()).await;
    ctx.mock.disconnect();
    ctx.mock
        .advance(vec![backend_factory().todo_global("1", "t1")])
        .await;
    ctx.push(vec![ctx.factory().todo("2", "t2")]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        ctx.todos(),
        [json!({"id": "2", "text": "t2", "completed": 0, "deletedAt": null})]
    );

    ctx.mock.connect();
    tokio::time::timeout(T, ctx.mock.take_pushed(1))
        .await
        .unwrap();
    assert_eq!(
        ctx.todos(),
        [
            json!({"id": "1", "text": "t1", "completed": 0, "deletedAt": null}),
            json!({"id": "2", "text": "t2", "completed": 0, "deletedAt": null})
        ]
    );
    let (state_head, local_head) = (
        ctx.state_head(),
        ctx.leader.sync_state().borrow().local_head,
    );
    assert_eq!(
        (state_head.global, state_head.client),
        (local_head.global, local_head.client)
    );
    let items = ctx.drain_queue().await;
    assert_eq!(tag(&items[0].payload), "upstream-advance");
    assert_eq!(tag(&items[1].payload), "upstream-rebase");
}

#[tokio::test]
async fn confirms_a_pending_event_that_was_rebased_before_the_backend_accepted_it() {
    let sync = SyncOptions {
        on_sync_error: OnSyncError::Shutdown,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        ..Default::default()
    })
    .await;
    ctx.mock.disconnect();
    ctx.mock
        .advance(vec![backend_factory().todo_global("remote", "remote")])
        .await;
    ctx.push(vec![ctx.factory().todo("local", "local")])
        .await
        .unwrap();

    ctx.mock.connect();
    let mut state = ctx.leader.sync_state();
    tokio::time::timeout(
        Duration::from_secs(3),
        state.wait_for(|s| s.upstream_head.global == 2 && s.pending.is_empty()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(ctx.leader.shutdown_cause().borrow().is_none());

    let head = ctx.state_head();
    assert_eq!((head.global, head.client), (2, 0));
    assert_eq!(head.rebase_generation, 1);
    let eventlog: Vec<(i64, i64, String)> = {
        let db = ctx.leader.db().lock().unwrap();
        let mut stmt = db.eventlog_conn().prepare("SELECT seqNumGlobal, seqNumRebaseGeneration, name FROM eventlog ORDER BY seqNumGlobal").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(
        eventlog,
        [(1, 0, "todoCreated".into()), (2, 1, "todoCreated".into())]
    );
    let mut ids = ctx.ids();
    ids.sort();
    assert_eq!(ids, ["local", "remote"]);
    assert_eq!(
        ctx.leader
            .query("SELECT * FROM __livestore_materialization_journal")
            .unwrap(),
        Vec::<livestore_sqlite::Row>::new()
    );
}

#[tokio::test]
async fn many_local_pushes() {
    let ctx = Ctx::start(Opts::default()).await;
    let mut f = ctx.factory();
    let number_of_pushes = 100;
    let events: Vec<Event> = (0..number_of_pushes)
        .map(|i| f.todo(&format!("local-push-{i}"), &format!("local-push-{i}")))
        .collect();
    futures::future::try_join_all(events.into_iter().map(|e| ctx.push(vec![e])))
        .await
        .unwrap();
    ctx.wait_state(|s| s.local_head.global == number_of_pushes)
        .await;
    assert_eq!(ctx.ids().len(), usize::try_from(number_of_pushes).unwrap());
    assert!(
        ctx.drain_queue()
            .await
            .iter()
            .all(|i| tag(&i.payload) == "upstream-advance")
    );
}

#[tokio::test]
async fn handles_duplicate_local_push_events() {
    let testing = Testing::default()
        .with_local_push_processing(tokio::time::sleep(Duration::from_millis(10)));
    let params = Params {
        local_push_batch_size: 2,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        params,
        testing,
        ..Default::default()
    })
    .await;
    let mut f = ctx.factory();
    for i in 0..10 {
        let event = f.todo(&format!("session_1_{i}"), "");
        for _ in 0..2 {
            if ctx.push(vec![event.clone()]).await.is_err() {
                break;
            }
        }
    }
    tokio::time::timeout(T, ctx.mock.take_pushed(10))
        .await
        .unwrap();
}

#[tokio::test]
async fn leader_push_api_rejects_stale_batch_from_secondary_session() {
    let ctx = Ctx::start(Opts::default()).await;
    let mut a = EventFactory::starting_at(
        ClientIdentity::with_session("client-shared", "session-A"),
        1,
        Sequence::Root,
    );
    let mut b = EventFactory::starting_at(
        ClientIdentity::with_session("client-shared", "session-B"),
        2,
        Sequence::At(1),
    );
    ctx.push(
        (1..=6)
            .map(|i| a.todo(&format!("A-{i}"), &format!("A-{i}")))
            .collect(),
    )
    .await
    .unwrap();

    let stale = b.todo("B-stale", "B-stale");
    b.advance_to(7, Sequence::At(6));
    let follow_up = [
        b.todo("B-follow-7", "B-follow-7"),
        b.todo("B-follow-8", "B-follow-8"),
    ];
    let err = tokio::time::timeout(T, ctx.push([vec![stale], follow_up.to_vec()].concat()))
        .await
        .unwrap()
        .unwrap_err();
    let LeaderPushError::Rejected(err) = err else {
        panic!("{err:?}")
    };
    assert_eq!(err.tag(), "LeaderAheadError");
    let RejectedPushError::LeaderAhead {
        minimum_expected_num,
        provided_num,
        ..
    } = err
    else {
        panic!()
    };
    assert_eq!(
        (minimum_expected_num.to_string(), provided_num.to_string()),
        ("e6".into(), "e2".into())
    );
}

#[tokio::test]
async fn leader_push_api_rejects_a_batch_that_skips_its_pending_prefix() {
    let ctx = Ctx::start(Opts::default()).await;
    let mut f = EventFactory::starting_at(
        ClientIdentity::with_session("client-skipped-prefix", "session-skipped-prefix"),
        2,
        Sequence::At(1),
    );
    let err = ctx
        .push(vec![f.todo("after-missing-prefix", "after-missing-prefix")])
        .await
        .unwrap_err();
    let LeaderPushError::Rejected(err) = err else {
        panic!("{err:?}")
    };
    assert_eq!(err.tag(), "NonContiguousBatchError");
    let RejectedPushError::NonContiguousBatch {
        expected_seq_num,
        provided_seq_num,
        violation_index,
        ..
    } = err
    else {
        panic!()
    };
    assert_eq!(
        (
            expected_seq_num.to_string(),
            provided_seq_num.to_string(),
            violation_index
        ),
        ("e1".into(), "e2".into(), 0)
    );
}

#[tokio::test]
async fn releases_rejected_queue_reservations_before_admitting_a_rebased_session_retry() {
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (allow_tx, allow_rx) = oneshot::channel::<()>();
    let (admitted_tx, mut admitted_rx) = mpsc::unbounded_channel::<()>();
    let testing = Testing {
        local_push_admitted: Some(hook(move |_| {
            let tx = admitted_tx.clone();
            async move { _ = tx.send(()) }
        })),
        ..Default::default()
    }
    .with_local_push_processing(async move {
        let _ = started_tx.send(());
        let _ = allow_rx.await;
    });
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: true,
        ..Default::default()
    });
    let ctx = Ctx::start(Opts {
        testing,
        mock: Some(mock),
        ..Default::default()
    })
    .await;
    let mut queued = EventFactory::starting_at(
        ClientIdentity::with_session("shared-client", "queued-session"),
        1,
        Sequence::Root,
    );
    let mut backend = EventFactory::starting_at(
        ClientIdentity::with_session("remote-client", "remote-session"),
        1,
        Sequence::Root,
    );

    started_rx.await.unwrap();
    let leader = ctx.leader.clone();
    let events: Vec<Event> = (0..6)
        .map(|i| queued.todo(&format!("queued-{i}"), &format!("queued-{i}")))
        .collect();
    let queued_push = tokio::spawn(async move { leader.push(events).await });
    admitted_rx.recv().await.unwrap();

    ctx.mock
        .advance(vec![backend.todo_global("remote-1", "remote-1")])
        .await;
    ctx.wait_state(|s| s.upstream_head.global == 1).await;

    allow_tx.send(()).unwrap();
    assert!(queued_push.await.unwrap().is_err());

    let retry_base: Event = backend.todo("retry-2", "retry-2");
    let (seq_num, parent_seq_num) = "e1r1".parse::<SeqNum>().unwrap().next_pair(false, Some(1));
    let retry = Event {
        seq_num,
        parent_seq_num,
        client_id: "shared-client".into(),
        session_id: "retry-session".into(),
        ..retry_base
    };
    ctx.push(vec![retry]).await.unwrap();
    tokio::time::timeout(T, ctx.mock.take_pushed(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn simulate_server_ahead_error_push_error() {
    let ctx = Ctx::start(Opts::default()).await;
    ctx.mock.fail_next_pushes(
        1,
        Some(Arc::new(|_| {
            ServerAheadError {
                minimum_expected_num: 2,
                provided_num: 1,
            }
            .into()
        })),
    );
    ctx.push(vec![ctx.factory().todo("stall", "stall")])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    ctx.mock
        .advance(vec![backend_factory().todo_global("1", "t1")])
        .await;
    tokio::time::timeout(T, ctx.mock.take_pushed(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn accepts_rebased_client_events_when_generation_increases() {
    let ctx = Ctx::start(Opts::default()).await;
    let before = ctx.leader.sync_state().borrow().local_head;
    let (seq_num, parent_seq_num) = before.next_pair(true, Some(before.rebase_generation + 1));
    let event = Event {
        name: "app_configSet".into(),
        args: json!({"id": "session-a", "value": {"theme": "dark"}}),
        seq_num,
        parent_seq_num,
        client_id: ctx.leader.client_id().into(),
        session_id: "session-a".into(),
    };
    ctx.push(vec![event]).await.unwrap();
    let mut state = ctx.leader.sync_state();
    let pending = tokio::time::timeout(
        Duration::from_secs(1),
        state.wait_for(|s| s.pending.iter().any(|e| e.name == "app_configSet")),
    )
    .await;
    assert!(
        pending
            .unwrap()
            .unwrap()
            .pending
            .iter()
            .any(|e| e.name == "app_configSet")
    );
}

#[tokio::test(start_paused = true)]
async fn recovers_from_backend_push_errors_without_live_pull() {
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error: OnSyncError::Ignore,
        ..Default::default()
    };
    let params = Params {
        backend_push_batch_size: 2,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        params,
        ..Default::default()
    })
    .await;
    ctx.mock.fail_next_pushes(2, None);
    let mut f = ctx.factory();
    ctx.push(vec![
        f.todo("p1", "a"),
        f.todo("p2", "b"),
        f.todo("p3", "c"),
        f.todo("p4", "d"),
    ])
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(7), ctx.mock.take_pushed(4))
        .await
        .unwrap();
    assert_eq!(ctx.ids().len(), 4);
}

#[tokio::test]
async fn shutdowns_on_backend_id_mismatch_error_push() {
    let ctx = Ctx::start(Opts {
        sync: mismatch_sync(OnBackendIdMismatch::Shutdown),
        ..Default::default()
    })
    .await;
    ctx.mock.fail_next_pushes(1, Some(mismatch("a", "b")));
    ctx.push(vec![ctx.factory().todo("mismatch", "x")])
        .await
        .unwrap();
    assert_eq!(
        ctx.shutdown_cause(Duration::from_secs(3)).await.tag(),
        "BackendIdMismatchError"
    );
}

#[tokio::test]
async fn clears_databases_on_backend_id_mismatch_error_push_with_reset() {
    let ctx = Ctx::start(Opts {
        sync: mismatch_sync(OnBackendIdMismatch::Reset),
        ..Default::default()
    })
    .await;
    let mut f = ctx.factory();
    ctx.push(vec![f.todo("1", "t1")]).await.unwrap();
    ctx.wait_state(|s| s.local_head.global == 1).await;
    tokio::time::timeout(Duration::from_secs(3), ctx.mock.take_pushed(1))
        .await
        .unwrap();
    assert!(ctx.eventlog_count("eventlog") > 0);

    ctx.mock
        .fail_next_pushes(1, Some(mismatch("new-id", "old-id")));
    ctx.push(vec![f.todo("2", "t2")]).await.unwrap();
    let cause = ctx.shutdown_cause(Duration::from_secs(3)).await;
    assert_eq!(cause.tag(), "IntentionalShutdownCause");
    assert_eq!(
        cause,
        ShutdownCause::IntentionalShutdownCause(IntentionalShutdownReason::BackendIdMismatch)
    );
    assert_eq!(ctx.eventlog_count("eventlog"), 0);
    assert_eq!(ctx.eventlog_count("__livestore_sync_status"), 0);
}

#[tokio::test]
async fn shutdowns_without_clearing_on_backend_id_mismatch_error_push_with_shutdown() {
    let ctx = Ctx::start(Opts {
        sync: mismatch_sync(OnBackendIdMismatch::Shutdown),
        ..Default::default()
    })
    .await;
    let mut f = ctx.factory();
    ctx.push(vec![f.todo("1", "t1")]).await.unwrap();
    ctx.wait_state(|s| s.local_head.global == 1).await;
    assert!(ctx.eventlog_count("eventlog") > 0);

    ctx.mock
        .fail_next_pushes(1, Some(mismatch("new-id", "old-id")));
    ctx.push(vec![f.todo("2", "t2")]).await.unwrap();
    assert_eq!(
        ctx.shutdown_cause(Duration::from_secs(3)).await.tag(),
        "BackendIdMismatchError"
    );
    assert!(ctx.eventlog_count("eventlog") > 0);
}

#[tokio::test]
async fn ignores_backend_id_mismatch_error_push_when_ignore() {
    let ctx = Ctx::start(Opts {
        sync: mismatch_sync(OnBackendIdMismatch::Ignore),
        ..Default::default()
    })
    .await;
    let mut f = ctx.factory();
    ctx.push(vec![f.todo("1", "t1")]).await.unwrap();
    ctx.wait_state(|s| s.local_head.global == 1).await;

    ctx.mock
        .fail_next_pushes(1, Some(mismatch("new-id", "old-id")));
    ctx.push(vec![f.todo("2", "t2")]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(ctx.eventlog_count("eventlog") > 0);
    let mut cause = ctx.leader.shutdown_cause();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), cause.wait_for(Option::is_some))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn clears_databases_on_backend_id_mismatch_error_pull_with_reset() {
    let mock = MockSyncBackend::new(MockSyncBackendOptions::default());
    mock.fail_next_pulls(
        1,
        Some(Arc::new(|| {
            BackendIdMismatchError {
                expected: "new-id".into(),
                received: "old-id".into(),
            }
            .into()
        })),
    );
    let sync = SyncOptions {
        on_backend_id_mismatch: OnBackendIdMismatch::Reset,
        live_pull: Some(true),
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        mock: Some(mock),
        ..Default::default()
    })
    .await;
    let cause = ctx.shutdown_cause(Duration::from_secs(3)).await;
    assert_eq!(
        cause,
        ShutdownCause::IntentionalShutdownCause(IntentionalShutdownReason::BackendIdMismatch)
    );
    assert_eq!(ctx.eventlog_count("eventlog"), 0);
    assert_eq!(ctx.eventlog_count("__livestore_sync_status"), 0);
}

// ---------- test context (mirrors `withTestCtx` / `TestContext`) ----------

type Wrap = Arc<dyn Fn(Arc<dyn SyncBackend>) -> BackendOverride + Send + Sync>;

#[derive(Default)]
struct Opts {
    sync: SyncOptions,
    params: Params,
    testing: Testing,
    /// A pre-made (seeded or armed) mock; defaults to `makeMockSyncBackend()`.
    mock: Option<MockSyncBackend>,
    /// `mockBackendOverride`.
    wrap: Option<Wrap>,
}

struct Ctx {
    leader: Leader,
    mock: MockSyncBackend,
    queue: tokio::sync::Mutex<PullQueue>,
}

impl Ctx {
    async fn start(opts: Opts) -> Ctx {
        let mock = opts
            .mock
            .unwrap_or_else(|| MockSyncBackend::new(MockSyncBackendOptions::default()));
        let wrap = opts.wrap.unwrap_or_else(|| Arc::new(BackendOverride::new));
        let m = mock.clone();
        let backend = constructor(move |_| {
            let (m, wrap) = (m.clone(), wrap.clone());
            async move { Ok(Arc::new(wrap(m.make_sync_backend().await)) as Arc<dyn SyncBackend>) }
        });
        let leader = Leader::builder(fixture_schema())
            .store_id("test")
            .client_id("test")
            .sync(SyncOptions {
                backend: Some(backend),
                ..opts.sync
            })
            .params(opts.params)
            .testing(opts.testing)
            .random(Arc::new(FixedRandom))
            .boot()
            .await
            .unwrap();
        // The leader connects the backend in the background at boot; settle it so tests start from a known state.
        let _ = tokio::time::timeout(T, leader.is_connected().wait_for(|c| *c)).await;
        let queue = tokio::sync::Mutex::new(leader.pull_queue(SeqNum::ROOT));
        Ctx {
            leader,
            mock,
            queue,
        }
    }

    fn factory(&self) -> EventFactory {
        factory(self.leader.client_id(), "static-session-id")
    }

    async fn push(&self, events: Vec<Event>) -> Result<(), LeaderPushError> {
        self.leader.push(events).await
    }

    async fn wait_state(&self, f: impl FnMut(&SyncState) -> bool) {
        let mut rx = self.leader.sync_state();
        tokio::time::timeout(T, rx.wait_for(f))
            .await
            .unwrap()
            .unwrap();
    }

    async fn shutdown_cause(&self, within: Duration) -> ShutdownCause {
        let mut rx = self.leader.shutdown_cause();
        tokio::time::timeout(within, rx.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap()
            .clone()
            .unwrap()
    }

    async fn drain_queue(&self) -> Vec<SessionPullItem> {
        let mut queue = self.queue.lock().await;
        std::iter::from_fn(|| queue.try_recv().ok()).collect()
    }

    fn todos(&self) -> Vec<Value> {
        self.leader
            .query("SELECT * FROM todos")
            .unwrap()
            .into_iter()
            .map(Value::Object)
            .collect()
    }

    fn ids(&self) -> Vec<String> {
        self.todos()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn state_head(&self) -> SeqNum {
        self.leader.db().lock().unwrap().state_head().unwrap()
    }

    fn eventlog_count(&self, table: &str) -> i64 {
        let db = self.leader.db().lock().unwrap();
        db.eventlog_conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
}

/// Live pulls that fail offline on demand: the TS `pullAttempts`/`unavailable`/`recovered`/`disconnect` override.
async fn outage_recovery(reports_connectivity: bool) {
    let flaky = FlakyPull::default();
    let ctx = Ctx::start(Opts {
        sync: live(),
        wrap: Some(flaky.wrap(false)),
        ..Default::default()
    })
    .await;

    flaky.unavailable.store(true, Ordering::SeqCst);
    if reports_connectivity {
        ctx.mock.disconnect();
    }
    flaky.disconnect();
    tokio::time::sleep(Duration::from_secs(20)).await;
    let attempts = flaky.attempts.load(Ordering::SeqCst);
    assert!(
        attempts > 1 && attempts <= 12,
        "{attempts} pull attempts during a 20 s outage"
    );

    ctx.mock
        .advance(vec![ctx.factory().todo_global("after-outage", "Recovered")])
        .await;
    flaky.unavailable.store(false, Ordering::SeqCst);
    flaky.recovered.store(true, Ordering::SeqCst);
    let connected_at = tokio::time::Instant::now();
    if reports_connectivity {
        ctx.mock.connect();
    }
    let limit = Duration::from_secs(if reports_connectivity { 2 } else { 40 });
    let mut state = ctx.leader.sync_state();
    tokio::time::timeout(limit, state.wait_for(|s| s.local_head.global == 1))
        .await
        .unwrap()
        .unwrap();
    if reports_connectivity {
        assert!(connected_at.elapsed() <= Duration::from_secs(2));
    }
    assert_eq!(ctx.ids(), ["after-outage"]);
}

async fn applies_local_pushes_after_pull_end(pull_end: PullEnd) {
    let pulled_pages = if pull_end == PullEnd::Complete { 3 } else { 1 };
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        non_live_chunk_size: 1,
        ..Default::default()
    });
    seed_paginated_backend_todos(&mock).await;
    let wrap = match pull_end {
        PullEnd::Complete => None,
        PullEnd::Fail => Some(end_pull_after_first_page(|| {
            Some(UnknownError::new("Simulated mid-pagination pull failure").into())
        })),
        PullEnd::Interrupt => Some(end_pull_after_first_page(|| None)),
    };
    let on_sync_error = if pull_end == PullEnd::Fail {
        OnSyncError::Ignore
    } else {
        OnSyncError::Shutdown
    };
    let sync = SyncOptions {
        live_pull: Some(false),
        on_sync_error,
        ..Default::default()
    };
    let ctx = Ctx::start(Opts {
        sync,
        mock: Some(mock),
        wrap,
        ..Default::default()
    })
    .await;

    ctx.wait_state(|s| s.local_head.global == pulled_pages)
        .await;
    let local_head = ctx.leader.sync_state().borrow().local_head;
    let (seq_num, parent_seq_num) = local_head.next_pair(false, None);
    let event = Event {
        seq_num,
        parent_seq_num,
        ..ctx.factory().todo("local", "local")
    };
    ctx.push(vec![event]).await.unwrap();
    if pull_end == PullEnd::Complete {
        tokio::time::timeout(T, ctx.mock.take_pushed(1))
            .await
            .unwrap();
    }

    let mut ids = ctx.ids();
    ids.sort();
    let mut expected: Vec<String> = (1..=pulled_pages).map(|i| format!("backend-{i}")).collect();
    expected.push("local".into());
    assert_eq!(ids, expected, "{pull_end:?}");
    assert!(
        ctx.leader.shutdown_cause().borrow().is_none(),
        "{pull_end:?}"
    );
}

#[derive(Clone, Default)]
struct FlakyPull {
    attempts: Arc<AtomicUsize>,
    unavailable: Arc<AtomicBool>,
    recovered: Arc<AtomicBool>,
    /// The disconnect deferred a new pull captures, and how many have been resolved.
    current: Arc<AtomicU64>,
    resolved: Arc<watch::Sender<u64>>,
}

impl FlakyPull {
    fn disconnect(&self) {
        self.resolved
            .send_replace(self.current.load(Ordering::SeqCst) + 1);
    }

    fn next_disconnect(&self) {
        self.current.fetch_add(1, Ordering::SeqCst);
    }

    /// `merge`: keep the whole live pull until disconnect (else take its first page, then wait).
    fn wrap(&self, merge: bool) -> Wrap {
        let flaky = self.clone();
        Arc::new(move |inner| {
            let flaky = flaky.clone();
            BackendOverride::new(inner).pull(move |inner, cursor, options| {
                if !options.live {
                    return inner.pull(cursor, options);
                }
                assert!(
                    flaky.attempts.fetch_add(1, Ordering::SeqCst) < 1_000,
                    "Pull retry loop exceeded 1,000 attempts"
                );
                let offline = || {
                    PullError::from(IsOfflineError {
                        cause: "Test backend unavailable".into(),
                    })
                };
                if flaky.unavailable.load(Ordering::SeqCst) {
                    return stream::iter([Err(offline())]).boxed();
                }
                if !merge && flaky.recovered.load(Ordering::SeqCst) {
                    return inner.pull(cursor, options);
                }
                let (mut resolved, deferred) = (
                    flaky.resolved.subscribe(),
                    flaky.current.load(Ordering::SeqCst) + 1,
                );
                let disconnected = stream::once(async move {
                    let _ = resolved.wait_for(|r| *r >= deferred).await;
                    Err(offline())
                });
                if merge {
                    stream::select(inner.pull(cursor, options), disconnected).boxed()
                } else {
                    inner
                        .pull(cursor, options)
                        .take(1)
                        .chain(disconnected)
                        .boxed()
                }
            })
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PullEnd {
    Complete,
    Fail,
    Interrupt,
}

async fn seed_paginated_backend_todos(mock: &MockSyncBackend) {
    let mut b = backend_factory();
    mock.advance(vec![
        b.todo_global("backend-1", "b1"),
        b.todo_global("backend-2", "b2"),
        b.todo_global("backend-3", "b3"),
    ])
    .await;
}

/// Serves the first backend page, then ends the pull with `end()`: an error, or `None` for an interrupt
/// (the TS processor treats an interrupt-only pull like one that ended).
fn end_pull_after_first_page(end: impl Fn() -> Option<PullError> + Send + Sync + 'static) -> Wrap {
    let end = Arc::new(end);
    Arc::new(move |inner| {
        let end = end.clone();
        BackendOverride::new(inner).pull(move |inner, cursor, options| {
            let end = end.clone();
            inner
                .pull(cursor, options)
                .take(1)
                .chain(stream::once(async move { end() }).filter_map(|e| async move { e.map(Err) }))
                .boxed()
        })
    })
}

fn live() -> SyncOptions {
    SyncOptions {
        live_pull: Some(true),
        ..Default::default()
    }
}

fn mismatch_sync(on_backend_id_mismatch: OnBackendIdMismatch) -> SyncOptions {
    SyncOptions {
        on_backend_id_mismatch,
        live_pull: Some(false),
        ..Default::default()
    }
}

fn mismatch(expected: &str, received: &str) -> PushFailure {
    let (expected, received) = (expected.to_owned(), received.to_owned());
    Arc::new(move |_| {
        BackendIdMismatchError {
            expected: expected.clone(),
            received: received.clone(),
        }
        .into()
    })
}

fn tag(payload: &Payload) -> &'static str {
    match payload {
        Payload::UpstreamAdvance { .. } => "upstream-advance",
        Payload::UpstreamRebase { .. } => "upstream-rebase",
        Payload::LocalPush { .. } => "local-push",
    }
}

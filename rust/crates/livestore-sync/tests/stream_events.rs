mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{TodoFactory, factory, fixture_schema};
use futures::{Stream, StreamExt};
use livestore_core::{Event, SeqNum, SyncState};
use livestore_sqlite::{EventQuery, LeaderDb, eventlog};
use livestore_sync::stream_events::stream_events;
use livestore_sync::testing::{ClientIdentity, EventFactory, Sequence};
use serde_json::json;
use tokio::sync::watch;

const T: Duration = Duration::from_secs(5);

#[tokio::test]
async fn emits_events_as_upstream_head_advances() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let initial = [f.todo("1", "first"), f.todo("2", "second")];
    env.insert(&initial);
    let collect = env.collect(
        EventQuery {
            since: Some(SeqNum::ROOT),
            ..Default::default()
        },
        4,
    );
    env.advance_head(initial[1].seq_num);
    let later = [f.todo("3", "third"), f.todo("4", "fourth")];
    env.insert(&later);
    env.advance_head(later[1].seq_num);

    let emitted = collect.await.unwrap();
    assert!(emitted.iter().all(|e| e.name == "todoCreated"));
    assert_eq!(
        emitted.iter().map(|e| e.args.clone()).collect::<Vec<_>>(),
        [
            json!({"id": "1", "text": "first", "completed": false}),
            json!({"id": "2", "text": "second", "completed": false}),
            json!({"id": "3", "text": "third", "completed": false}),
            json!({"id": "4", "text": "fourth", "completed": false}),
        ]
    );
}

#[tokio::test]
async fn filters_events_by_name() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let events: Vec<Event> = vec![
        f.todo("1", "first"),
        f.next_client("todoCompleted", json!({"id": "1"})),
        f.todo("2", "second"),
        f.next_client("todoCompleted", json!({"id": "2"})),
    ];
    env.insert(&events);
    let collect = env.collect(
        EventQuery {
            since: Some(SeqNum::ROOT),
            filter: Some(vec!["todoCompleted".into()]),
            ..Default::default()
        },
        2,
    );
    env.advance_head(events.last().unwrap().seq_num);
    let emitted = collect.await.unwrap();
    assert_eq!(
        emitted.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        ["todoCompleted", "todoCompleted"]
    );
}

#[tokio::test]
async fn finalises_when_reaching_until_head() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let events = [
        f.todo("1", "first"),
        f.todo("2", "second"),
        f.todo("3", "third"),
    ];
    env.insert(&events);
    let stream = env.stream(EventQuery {
        since: Some(SeqNum::ROOT),
        until: Some(events[1].seq_num),
        ..Default::default()
    });
    env.advance_head(events[1].seq_num);
    let emitted: Vec<_> = tokio::time::timeout(T, stream.collect::<Vec<_>>())
        .await
        .unwrap();
    assert_eq!(emitted.len(), 2);
}

#[tokio::test]
async fn excludes_events_at_the_since_cursor() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let (first, second) = (f.todo("1", "first"), f.todo("2", "second"));
    env.insert(&[first.clone(), second.clone()]);
    let collect = env.collect(
        EventQuery {
            since: Some(first.seq_num),
            ..Default::default()
        },
        1,
    );
    env.advance_head(second.seq_num);
    assert_eq!(
        collect
            .await
            .unwrap()
            .iter()
            .map(|e| e.seq_num)
            .collect::<Vec<_>>(),
        [second.seq_num]
    );
}

#[tokio::test]
async fn filters_events_by_client_id() {
    let env = Env::new();
    let mut a = factory("client-a", "session-1");
    let mut b = EventFactory::starting_at(
        ClientIdentity::with_session("client-b", "session-2"),
        2,
        Sequence::At(1),
    );
    let (event_a, event_b) = (a.todo("1", "first"), b.todo("2", "second"));
    env.insert(&[event_a, event_b.clone()]);
    let collect = env.collect(
        EventQuery {
            since: Some(SeqNum::ROOT),
            client_ids: Some(vec!["client-b".into()]),
            ..Default::default()
        },
        1,
    );
    env.advance_head(event_b.seq_num);
    assert_eq!(
        collect
            .await
            .unwrap()
            .iter()
            .map(|e| e.client_id.as_str())
            .collect::<Vec<_>>(),
        ["client-b"]
    );
}

#[tokio::test]
async fn filters_events_by_session_id() {
    let env = Env::new();
    let mut one = factory("client-shared", "session-1");
    let mut two = EventFactory::starting_at(
        ClientIdentity::with_session("client-shared", "session-2"),
        2,
        Sequence::At(1),
    );
    let (event_one, event_two) = (one.todo("1", "first"), two.todo("2", "second"));
    env.insert(&[event_one, event_two.clone()]);
    let collect = env.collect(
        EventQuery {
            since: Some(SeqNum::ROOT),
            session_ids: Some(vec!["session-2".into()]),
            ..Default::default()
        },
        1,
    );
    env.advance_head(event_two.seq_num);
    assert_eq!(
        collect
            .await
            .unwrap()
            .iter()
            .map(|e| e.session_id.as_str())
            .collect::<Vec<_>>(),
        ["session-2"]
    );
}

#[tokio::test]
async fn skips_client_only_events_by_default() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let approved = [
        f.todo("1", "first"),
        f.todo("2", "second"),
        f.todo("3", "third"),
    ];
    let mut base = approved[2].seq_num;
    let client_only: Vec<Event> = [
        json!({"theme": "dark"}),
        json!({"fontSize": 18}),
        json!({"theme": "light", "fontSize": 20}),
    ]
    .into_iter()
    .map(|value| {
        let template = f.next_client("app_configSet", json!({"id": "session-1", "value": value}));
        let (seq_num, parent_seq_num) = base.next_pair(true, Some(base.rebase_generation));
        base = seq_num;
        Event {
            seq_num,
            parent_seq_num,
            ..template
        }
    })
    .collect();
    env.insert(&approved);
    env.insert(&client_only);
    let collect = env.collect(
        EventQuery {
            since: Some(SeqNum::ROOT),
            ..Default::default()
        },
        approved.len(),
    );
    env.advance_head(approved[2].seq_num);
    let emitted = collect.await.unwrap();
    assert_eq!(emitted.len(), approved.len());
    assert_eq!(
        emitted.iter().map(|e| e.seq_num.global).collect::<Vec<_>>(),
        approved
            .iter()
            .map(|e| e.seq_num.global)
            .collect::<Vec<_>>()
    );
    assert!(emitted.iter().all(|e| e.seq_num.client <= 0));
}

#[tokio::test]
async fn respects_until_marker_when_batch_size_exceeds_remaining_events() {
    let env = Env::new();
    let mut f = factory("client-1", "session-1");
    let all: Vec<Event> = (1..=20)
        .map(|i| f.todo(&i.to_string(), &format!("todo-{i}")))
        .collect();
    env.insert(&all);
    let stream = env.stream(EventQuery {
        since: Some(SeqNum::ROOT),
        until: Some(all[4].seq_num),
        batch_size: Some(10),
        ..Default::default()
    });
    env.advance_head(all.last().unwrap().seq_num);
    let emitted: Vec<Event> = tokio::time::timeout(T, stream.collect::<Vec<_>>())
        .await
        .unwrap();
    assert_eq!(emitted.len(), 5);
    assert_eq!(
        emitted.iter().map(|e| e.seq_num.global).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
}

#[tokio::test]
async fn property_streams_events_across_batches() {
    for batch_size in [1, 5, 12, 25, 50, 100] {
        for event_count in [0usize, 1, 6, 10, 100] {
            for batches_per_tick in [1, 3, 10, 100] {
                let env = Env::new();
                let mut f = factory("client-1", "session-1");
                let generated: Vec<Event> = (1..=event_count)
                    .map(|i| f.todo(&i.to_string(), &format!("todo-{i}")))
                    .collect();
                env.insert(&generated);
                let collect = env.collect(
                    EventQuery {
                        since: Some(SeqNum::ROOT),
                        batch_size: Some(batch_size),
                        ..Default::default()
                    },
                    event_count,
                );
                let tick = batch_size * batches_per_tick;
                for index in (tick..generated.len()).step_by(tick) {
                    env.advance_head(generated[index - 1].seq_num);
                }
                if let Some(last) = generated.last() {
                    env.advance_head(last.seq_num);
                }
                let emitted = collect.await.unwrap();
                assert_eq!(
                    emitted.len(),
                    event_count,
                    "{batch_size}/{event_count}/{batches_per_tick}"
                );
                assert_eq!(
                    emitted.iter().map(|e| e.seq_num.global).collect::<Vec<_>>(),
                    generated
                        .iter()
                        .map(|e| e.seq_num.global)
                        .collect::<Vec<_>>()
                );
            }
        }
    }
}

/// `makeTestEnvironment`: real eventlog + state DB and a controllable sync state.
struct Env {
    db: Arc<Mutex<LeaderDb>>,
    heads: watch::Sender<SyncState>,
}

impl Env {
    fn new() -> Self {
        let db = LeaderDb::open_in_memory(fixture_schema()).unwrap();
        let root = SyncState {
            pending: vec![],
            upstream_head: SeqNum::ROOT,
            local_head: SeqNum::ROOT,
        };
        Self {
            db: Arc::new(Mutex::new(db)),
            heads: watch::channel(root).0,
        }
    }

    fn insert(&self, events: &[Event]) {
        let db = self.db.lock().unwrap();
        for e in events {
            eventlog::insert(db.eventlog_conn(), e, 0, None).unwrap();
        }
    }

    fn advance_head(&self, head: SeqNum) {
        self.heads.send_replace(SyncState {
            pending: vec![],
            upstream_head: head,
            local_head: head,
        });
    }

    fn stream(&self, query: EventQuery) -> impl Stream<Item = Event> + Send + 'static {
        stream_events(self.db.clone(), self.heads.subscribe(), query).map(Result::unwrap)
    }

    /// `stream.pipe(Stream.take(n), Stream.runCollect, Effect.forkScoped)`.
    fn collect(&self, query: EventQuery, n: usize) -> tokio::task::JoinHandle<Vec<Event>> {
        let stream = self.stream(query).take(n);
        tokio::spawn(async move {
            tokio::time::timeout(T, stream.collect::<Vec<_>>())
                .await
                .unwrap()
        })
    }
}

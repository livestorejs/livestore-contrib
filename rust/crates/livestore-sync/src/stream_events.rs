//! `streamEventsWithSyncState`: pages through the eventlog as the upstream head advances.

use std::sync::{Arc, Mutex};

use futures::Stream;
use futures::stream::{self, StreamExt};
use livestore_core::{Event, SeqNum, SyncState};
use livestore_sqlite::eventlog::STREAM_EVENTS_BATCH_SIZE_DEFAULT;
use livestore_sqlite::{EventQuery, LeaderDb};
use tokio::sync::watch;

pub fn stream_events(
    db: Arc<Mutex<LeaderDb>>,
    sync_state: watch::Receiver<SyncState>,
    query: EventQuery,
) -> impl Stream<Item = Result<Event, livestore_sqlite::Error>> + Send + 'static {
    let state = State {
        cursor: query.since.unwrap_or(SeqNum::ROOT),
        head: SeqNum::ROOT,
        prev_global: -1,
        first: true,
        rx: sync_state,
    };
    stream::unfold(Some(state), move |state| {
        let (db, query) = (db.clone(), query.clone());
        async move {
            let mut s = state?;
            if query
                .until
                .is_some_and(|until| s.cursor.is_greater_than_or_equal(&until))
            {
                return None;
            }
            let wait = s.cursor.is_greater_than_or_equal(&s.head);
            let next_head = match s.next_head(wait).await {
                Some(h) => h,
                None if wait => return None,
                None => s.head,
            };
            let batch = query.batch_size.unwrap_or(STREAM_EVENTS_BATCH_SIZE_DEFAULT) as i64;
            let hard_stop = query.until.map_or(i64::MAX, |u| u.global);
            let target = SeqNum::new(
                hard_stop.min(s.cursor.global + batch).min(next_head.global),
                0,
                0,
            );
            let page = EventQuery {
                since: Some(s.cursor),
                until: Some(target),
                ..query.clone()
            };
            let events = db.lock().unwrap().query_events(&page);
            let reached_until = query
                .until
                .is_some_and(|until| target.is_greater_than_or_equal(&until));
            tracing::trace!(
                cursor = s.cursor.global,
                target = target.global,
                waited_for_head = wait,
                "@livestore/common:streamEvents:segment"
            );
            s.cursor = target;
            s.head = next_head;
            let items: Vec<Result<Event, livestore_sqlite::Error>> = match events {
                Ok(events) => events.into_iter().map(Ok).collect(),
                Err(e) => return Some((vec![Err(e)], None)),
            };
            Some((items, (!reached_until).then_some(s)))
        }
    })
    .flat_map(stream::iter)
}

struct State {
    cursor: SeqNum,
    head: SeqNum,
    prev_global: i64,
    first: bool,
    rx: watch::Receiver<SyncState>,
}

impl State {
    /// Latest upstream head that advanced past the previous one; waits for one when `wait`.
    async fn next_head(&mut self, wait: bool) -> Option<SeqNum> {
        loop {
            let fresh = std::mem::take(&mut self.first) || self.rx.has_changed().unwrap_or(false);
            if fresh {
                let head = self.rx.borrow_and_update().upstream_head;
                if head.global > self.prev_global {
                    self.prev_global = head.global;
                    return Some(head);
                }
            }
            if !wait || self.rx.changed().await.is_err() {
                return None;
            }
            self.first = true;
        }
    }
}

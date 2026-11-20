//! `makePullQueueSet`: per-session downstream queues, seeded from a cache of everything published.

use std::sync::Mutex;

use livestore_core::{Payload, SeqNum};
use tokio::sync::mpsc;

/// `ClientSessionLeaderThreadProxy.PullItem`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionPullItem {
    /// `upstream-advance` or `upstream-rebase`.
    pub payload: Payload,
    pub global_head: SeqNum,
    pub materializer_hashes: Vec<MaterializerHash>,
}

/// `LiveStoreEvent.Client.MaterializerHash`: lets a session check it materialized an event the same way.
#[derive(Clone, Debug, PartialEq)]
pub struct MaterializerHash {
    pub event_num: SeqNum,
    pub hash: Option<u64>,
}

pub type PullQueue = mpsc::UnboundedReceiver<SessionPullItem>;

#[derive(Default)]
pub(crate) struct PullQueueSet {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    queues: Vec<mpsc::UnboundedSender<SessionPullItem>>,
    /// Keyed by leader head; unbounded like TS.
    cache: Vec<(SeqNum, SessionPullItem)>,
}

impl PullQueueSet {
    pub fn make_queue(&self, cursor: SeqNum) -> PullQueue {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().unwrap();
        let mut since: Vec<&(SeqNum, SessionPullItem)> = inner
            .cache
            .iter()
            .filter(|(head, _)| head.is_greater_than(&cursor))
            .collect();
        since.sort_by(|a, b| a.0.compare(&b.0));
        for (_, item) in since {
            let item = match &item.payload {
                Payload::UpstreamAdvance { new_events } => SessionPullItem {
                    global_head: item.global_head,
                    payload: Payload::UpstreamAdvance {
                        new_events: new_events
                            .iter()
                            .skip_while(|e| cursor.is_greater_than_or_equal(&e.seq_num))
                            .cloned()
                            .collect(),
                    },
                    materializer_hashes: item
                        .materializer_hashes
                        .iter()
                        .filter(|h| h.event_num.is_greater_than(&cursor))
                        .cloned()
                        .collect(),
                },
                _ => item.clone(),
            };
            let _ = tx.send(item);
        }
        inner.queues.push(tx);
        rx
    }

    pub fn offer(&self, leader_head: SeqNum, item: SessionPullItem) {
        let mut inner = self.inner.lock().unwrap();
        inner.cache.push((leader_head, item.clone()));
        inner.queues.retain(|q| q.send(item.clone()).is_ok());
    }

    pub fn close(&self) {
        self.inner.lock().unwrap().queues.clear();
    }
}

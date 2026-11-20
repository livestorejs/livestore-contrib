//! `LiveStoreEvent.Client.Encoded` / `LiveStoreEvent.Global.Encoded`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SeqNum;

/// Client encoded event (`LiveStoreEvent.Client.Encoded`).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub name: String,
    pub args: Value,
    pub seq_num: SeqNum,
    pub parent_seq_num: SeqNum,
    pub client_id: String,
    pub session_id: String,
}

impl Event {
    /// Returns a copy moved to the position after `parent` (`LiveStoreEvent.Client.rebase`).
    pub fn rebase(&self, parent: SeqNum, is_client_only: bool, rebase_generation: i64) -> Event {
        let (seq_num, parent_seq_num) = parent.next_pair(is_client_only, Some(rebase_generation));
        Event {
            seq_num,
            parent_seq_num,
            ..self.clone()
        }
    }
}

/// `LiveStoreEvent.Client.isEqualEncoded`; JSON args are already canonical.
pub fn is_equal_encoded(a: &Event, b: &Event) -> bool {
    a.seq_num.global == b.seq_num.global
        && a.seq_num.client == b.seq_num.client
        && a.name == b.name
        && a.client_id == b.client_id
        && a.session_id == b.session_id
        && a.args == b.args
}

/// Global encoded event (`LiveStoreEvent.Global.Encoded`): the wire/backend shape.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlobalEvent {
    pub name: String,
    pub args: Value,
    pub seq_num: i64,
    pub parent_seq_num: i64,
    pub client_id: String,
    pub session_id: String,
}

impl Event {
    /// `LiveStoreEvent.Client.toGlobal`.
    pub fn to_global(&self) -> GlobalEvent {
        GlobalEvent {
            name: self.name.clone(),
            args: self.args.clone(),
            seq_num: self.seq_num.global,
            parent_seq_num: self.parent_seq_num.global,
            client_id: self.client_id.clone(),
            session_id: self.session_id.clone(),
        }
    }
}

impl From<GlobalEvent> for Event {
    /// `LiveStoreEvent.Client.fromGlobal`: client and rebase generation are 0.
    fn from(e: GlobalEvent) -> Self {
        Event {
            name: e.name,
            args: e.args,
            seq_num: SeqNum::new(e.seq_num, 0, 0),
            parent_seq_num: SeqNum::new(e.parent_seq_num, 0, 0),
            client_id: e.client_id,
            session_id: e.session_id,
        }
    }
}

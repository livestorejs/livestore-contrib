use livestore_core::{Event, GlobalEvent};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ClientIdentity {
    pub client_id: String,
    pub session_id: String,
}

impl ClientIdentity {
    /// `clientIdentity(label, session = `${label}-session`)`.
    pub fn new(label: &str) -> Self {
        Self {
            client_id: label.into(),
            session_id: format!("{label}-session"),
        }
    }

    pub fn with_session(label: &str, session: &str) -> Self {
        Self {
            client_id: label.into(),
            session_id: session.into(),
        }
    }
}

/// `SequenceValue`: `'root' | number`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sequence {
    Root,
    At(i64),
}

/// `EventFactory.makeFactory(...)(config)`: numbers global events from `start_seq`, chaining parents.
/// Unlike TS (one factory per event def sharing a counter) this is one counter with `next(name, args)`.
#[derive(Clone, Debug)]
pub struct EventFactory {
    client: ClientIdentity,
    next_seq: i64,
    parent: Sequence,
}

impl EventFactory {
    pub fn new(client: ClientIdentity) -> Self {
        Self::starting_at(client, 1, Sequence::Root)
    }

    pub fn starting_at(client: ClientIdentity, start_seq: i64, initial_parent: Sequence) -> Self {
        Self {
            client,
            next_seq: start_seq,
            parent: initial_parent,
        }
    }

    pub fn next(&mut self, name: &str, args: Value) -> GlobalEvent {
        let event = GlobalEvent {
            name: name.into(),
            args,
            seq_num: self.next_seq,
            parent_seq_num: match self.parent {
                Sequence::Root => 0,
                Sequence::At(n) => n,
            },
            client_id: self.client.client_id.clone(),
            session_id: self.client.session_id.clone(),
        };
        self.parent = Sequence::At(self.next_seq);
        self.next_seq += 1;
        event
    }

    /// Same as [`Self::next`], as a client-encoded event (`toClientEncoded`).
    pub fn next_client(&mut self, name: &str, args: Value) -> Event {
        self.next(name, args).into()
    }

    pub fn advance_to(&mut self, seq: i64, parent: Sequence) {
        self.next_seq = seq;
        self.parent = parent;
    }

    pub fn set_parent(&mut self, parent: Sequence) {
        self.parent = parent;
    }

    pub fn current(&self) -> (i64, Sequence) {
        (self.next_seq, self.parent)
    }
}

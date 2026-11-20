//! WebSocket sync client for the sync-cf backend (Effect RPC JSON over WS).
//! Protocol reference: `contributor-docs/rust/sync-cf-wire-protocol.md`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub use livestore_core::GlobalEvent;
pub use livestore_sync::PageInfo;

pub const PULL_TAG: &str = "SyncWsRpc.Pull";
pub const PUSH_TAG: &str = "SyncWsRpc.Push";
/// Must be byte-exact: the DO auto-responds to this literal string.
pub const PING_FRAME: &str = r#"{"_tag":"Ping"}"#;

// ---------- wire types ----------

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Num(u64),
    Str(String),
}

/// Effect `Option<T>` encoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum WireOption<T> {
    None,
    Some { value: T },
}

impl<T> From<Option<T>> for WireOption<T> {
    fn from(o: Option<T>) -> Self {
        match o {
            Some(value) => WireOption::Some { value },
            None => WireOption::None,
        }
    }
}

impl<T> From<WireOption<T>> for Option<T> {
    fn from(o: WireOption<T>) -> Self {
        match o {
            WireOption::Some { value } => Some(value),
            WireOption::None => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ClientMessage {
    Request(Request),
    Ack {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Ping,
    Eof,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: RequestId,
    pub tag: String,
    /// Kept raw; decode with [`PullRequest`]/[`PushRequest`] by `tag`.
    pub payload: Value,
    pub headers: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: Exit,
    },
    Pong,
    Defect {
        defect: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Exit {
    Success { value: Value },
    Failure { cause: Vec<CauseReason> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum CauseReason {
    Fail {
        error: BackendError,
    },
    Die {
        defect: Value,
    },
    Interrupt {
        #[serde(rename = "fiberId")]
        fiber_id: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum BackendError {
    #[serde(rename_all = "camelCase")]
    ServerAheadError {
        minimum_expected_num: i64,
        provided_num: i64,
    },
    BackendIdMismatchError {
        expected: String,
        received: String,
    },
    UnknownError {
        #[serde(flatten)]
        fields: serde_json::Map<String, Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullCursor {
    pub backend_id: String,
    pub event_sequence_number: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub store_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    pub live: bool,
    pub cursor: WireOption<PullCursor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub store_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    pub batch: Vec<GlobalEvent>,
    pub backend_id: WireOption<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub batch: Vec<PullItem>,
    pub page_info: PageInfo,
    pub backend_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullItem {
    pub event_encoded: GlobalEvent,
    pub metadata: WireOption<SyncMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum SyncMetadata {
    #[serde(rename = "SyncMessage.SyncMetadata")]
    SyncMetadata {
        #[serde(rename = "createdAt")]
        created_at: String,
    },
}

// ---------- errors ----------

#[derive(Debug, Clone, PartialEq)]
pub enum SyncError {
    ServerAhead {
        minimum_expected_num: i64,
        provided_num: i64,
    },
    BackendIdMismatch {
        expected: String,
        received: String,
    },
    Unknown(Value),
    /// Server-side defect (`Die` cause or connection-level `Defect`).
    Defect(Value),
    /// The socket is gone (Effect `Socket.SocketError` reasons).
    Socket(SocketError),
    /// HTTP transport failure (Effect `HttpClientError` reasons).
    Http {
        kind: HttpErrorKind,
        message: String,
    },
    /// Malformed RPC traffic (`RpcClientDefect`).
    Protocol(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketError {
    pub kind: SocketErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketErrorKind {
    Open,
    Upgrade,
    Read,
    Write,
    Close { code: u16 },
    PongTimeout,
    ClosedByClient,
}

/// `HttpClientError` reason kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpErrorKind {
    Transport,
    Encode,
    Decode,
    InvalidUrl,
    StatusCode,
    EmptyBody,
}

impl std::fmt::Display for SocketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl SyncError {
    pub fn socket(kind: SocketErrorKind, message: impl Into<String>) -> Self {
        SyncError::Socket(SocketError {
            kind,
            message: message.into(),
        })
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for SyncError {}

impl From<BackendError> for SyncError {
    fn from(e: BackendError) -> Self {
        match e {
            BackendError::ServerAheadError {
                minimum_expected_num,
                provided_num,
            } => SyncError::ServerAhead {
                minimum_expected_num,
                provided_num,
            },
            BackendError::BackendIdMismatchError { expected, received } => {
                SyncError::BackendIdMismatch { expected, received }
            }
            BackendError::UnknownError { fields } => SyncError::Unknown(Value::Object(fields)),
        }
    }
}

// ---------- client ----------

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub ping_interval: Duration,
    pub pong_timeout: Duration,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(10),
            pong_timeout: Duration::from_secs(10),
        }
    }
}

/// One socket, many multiplexed requests. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

/// Live or finite pull. Dropping it sends `Interrupt` if still open.
pub struct PullStream {
    id: RequestId,
    rx: mpsc::UnboundedReceiver<Routed>,
    inner: Arc<Inner>,
    done: bool,
}

pub async fn connect(
    url: &str,
    store_id: &str,
    payload: Option<Value>,
) -> Result<Client, SyncError> {
    connect_with(url, store_id, payload, ClientOptions::default()).await
}

pub async fn connect_with(
    url: &str,
    store_id: &str,
    payload: Option<Value>,
    options: ClientOptions,
) -> Result<Client, SyncError> {
    let mut full = format!(
        "{}/?storeId={}&transport=ws",
        url.trim_end_matches('/'),
        encode_uri_component(store_id)
    );
    if let Some(p) = &payload {
        full.push_str("&payload=");
        full.push_str(&encode_uri_component(&encode_uri_component(&p.to_string())));
    }
    let (ws, _) = tokio_tungstenite::connect_async(full.as_str())
        .await
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(_) => {
                SyncError::socket(SocketErrorKind::Upgrade, e.to_string())
            }
            e => SyncError::socket(SocketErrorKind::Open, e.to_string()),
        })?;
    let (mut sink, mut source) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    let inner = Arc::new(Inner {
        store_id: store_id.to_owned(),
        payload,
        out: out_tx,
        next_id: AtomicU64::new(0),
        state: Mutex::new(State::default()),
        open: tokio::sync::watch::channel(true).0,
    });

    let writer = Arc::downgrade(&inner);
    tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            // Empty frame = close sentinel from `fail_all`.
            if frame.is_empty() {
                break;
            }
            if let Err(e) = sink.send(Message::text(frame)).await {
                if let Some(inner) = writer.upgrade() {
                    inner.fail_all(SocketError {
                        kind: SocketErrorKind::Write,
                        message: e.to_string(),
                    });
                }
                break;
            }
        }
        let _ = sink.close().await;
    });

    let reader = inner.clone();
    tokio::spawn(async move {
        let reason = loop {
            match source.next().await {
                Some(Ok(Message::Text(t))) => reader.handle_frame(t.as_str()),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map_or((1005, String::new()), |f| {
                        (u16::from(f.code), f.reason.to_string())
                    });
                    break SocketError {
                        kind: SocketErrorKind::Close { code },
                        message: reason,
                    };
                }
                None => {
                    break SocketError {
                        kind: SocketErrorKind::Close { code: 1006 },
                        message: "socket closed".into(),
                    };
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    break SocketError {
                        kind: SocketErrorKind::Read,
                        message: e.to_string(),
                    };
                }
            }
        };
        reader.fail_all(reason);
    });

    let pinger = Arc::downgrade(&inner);
    tokio::spawn(async move {
        loop {
            let Some(inner) = pinger.upgrade() else {
                return;
            };
            if inner.state.lock().unwrap().closed.is_some() {
                return;
            }
            let client = Client { inner };
            if client.ping(options.pong_timeout).await.is_err() {
                client.inner.fail_all(SocketError {
                    kind: SocketErrorKind::PongTimeout,
                    message: "pong timeout".into(),
                });
                return;
            }
            drop(client);
            tokio::time::sleep(options.ping_interval).await;
        }
    });

    Ok(Client { inner })
}

impl Client {
    pub fn store_id(&self) -> &str {
        &self.inner.store_id
    }

    /// `cursor`: `(backend_id, last_seq_num)`; `None` pulls from the beginning.
    pub fn pull(&self, cursor: Option<PullCursor>, live: bool) -> Result<PullStream, SyncError> {
        let req = PullRequest {
            store_id: self.inner.store_id.clone(),
            payload: self.inner.payload.clone(),
            live,
            cursor: cursor.into(),
        };
        let (id, rx) = self.inner.start(PULL_TAG, to_value(&req))?;
        Ok(PullStream {
            id,
            rx,
            inner: self.inner.clone(),
            done: false,
        })
    }

    pub async fn push(
        &self,
        batch: Vec<GlobalEvent>,
        backend_id: Option<String>,
    ) -> Result<(), SyncError> {
        let req = PushRequest {
            store_id: self.inner.store_id.clone(),
            payload: self.inner.payload.clone(),
            batch,
            backend_id: backend_id.into(),
        };
        let (_, mut rx) = self.inner.start(PUSH_TAG, to_value(&req))?;
        loop {
            match rx.recv().await {
                Some(Routed::Chunk(_)) => {}
                Some(Routed::Exit(Exit::Success { .. })) => return Ok(()),
                Some(Routed::Exit(Exit::Failure { cause })) => {
                    return Err(cause_to_error(cause)
                        .unwrap_or(SyncError::Protocol("push interrupted".to_owned())));
                }
                Some(Routed::Error(e)) => return Err(e),
                None => return Err(self.inner.disconnected()),
            }
        }
    }

    /// Sends the literal Ping and waits for Pong.
    pub async fn ping(&self, timeout: Duration) -> Result<(), SyncError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.inner.state.lock().unwrap();
            if let Some(r) = &st.closed {
                return Err(SyncError::Socket(r.clone()));
            }
            st.pong_waiters.push(tx);
        }
        self.inner.send(PING_FRAME.to_owned())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(self.inner.disconnected()),
            Err(_) => Err(SyncError::socket(
                SocketErrorKind::PongTimeout,
                "pong timeout",
            )),
        }
    }

    /// `Some(reason)` once the socket is gone (closed, errored, or pong timeout).
    pub fn closed_reason(&self) -> Option<SocketError> {
        self.inner.state.lock().unwrap().closed.clone()
    }

    /// Flips to `false` when the socket goes away.
    pub fn open_state(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.open.subscribe()
    }

    pub fn close(&self) {
        self.inner.fail_all(SocketError {
            kind: SocketErrorKind::ClosedByClient,
            message: "closed by client".into(),
        });
    }
}

impl PullStream {
    pub fn request_id(&self) -> &RequestId {
        &self.id
    }

    /// `None` when the pull ended (finite pull done, or interrupted).
    pub async fn next(&mut self) -> Option<Result<PullResponse, SyncError>> {
        if self.done {
            return None;
        }
        loop {
            let item = match self.rx.recv().await {
                Some(Routed::Chunk(values)) => {
                    // Server sends the next history chunk only after an Ack (no-op for live chunks).
                    let _ = self.inner.send_msg(&ClientMessage::Ack {
                        request_id: self.id.clone(),
                    });
                    let mut responses = values.into_iter().map(|v| {
                        serde_json::from_value::<PullResponse>(v)
                            .map_err(|e| SyncError::Protocol(e.to_string()))
                    });
                    match responses.next() {
                        Some(r) => Some(r),
                        None => continue,
                    }
                }
                Some(Routed::Exit(Exit::Success { .. })) => None,
                Some(Routed::Exit(Exit::Failure { cause })) => cause_to_error(cause).map(Err),
                Some(Routed::Error(e)) => Some(Err(e)),
                None => Some(Err(self.inner.disconnected())),
            };
            if !matches!(item, Some(Ok(_))) {
                self.done = true;
            }
            return item;
        }
    }

    /// Ends the pull; `next()` then yields `None` once the server confirms.
    pub fn interrupt(&self) -> Result<(), SyncError> {
        self.inner.send_msg(&ClientMessage::Interrupt {
            request_id: self.id.clone(),
        })
    }
}

impl Drop for PullStream {
    fn drop(&mut self) {
        let mut st = self.inner.state.lock().unwrap();
        if st.pending.remove(&self.id).is_some() && st.closed.is_none() {
            drop(st);
            let _ = self.interrupt();
        }
    }
}

// ---------- internals ----------

struct Inner {
    store_id: String,
    payload: Option<Value>,
    out: mpsc::UnboundedSender<String>,
    next_id: AtomicU64,
    state: Mutex<State>,
    /// `true` while the socket is open.
    open: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    pending: HashMap<RequestId, mpsc::UnboundedSender<Routed>>,
    pong_waiters: Vec<oneshot::Sender<()>>,
    closed: Option<SocketError>,
}

enum Routed {
    Chunk(Vec<Value>),
    Exit(Exit),
    Error(SyncError),
}

impl Inner {
    fn start(
        &self,
        tag: &str,
        payload: Value,
    ) -> Result<(RequestId, mpsc::UnboundedReceiver<Routed>), SyncError> {
        let id = RequestId::Num(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut st = self.state.lock().unwrap();
            if let Some(r) = &st.closed {
                return Err(SyncError::Socket(r.clone()));
            }
            st.pending.insert(id.clone(), tx);
        }
        let req = Request {
            id: id.clone(),
            tag: tag.to_owned(),
            payload,
            headers: vec![],
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        self.send_msg(&ClientMessage::Request(req))?;
        Ok((id, rx))
    }

    fn send_msg(&self, msg: &ClientMessage) -> Result<(), SyncError> {
        self.send(serde_json::to_string(msg).expect("client message serializes"))
    }

    fn send(&self, frame: String) -> Result<(), SyncError> {
        self.out.send(frame).map_err(|_| self.disconnected())
    }

    fn disconnected(&self) -> SyncError {
        let reason = self.state.lock().unwrap().closed.clone();
        SyncError::Socket(reason.unwrap_or(SocketError {
            kind: SocketErrorKind::Close { code: 1006 },
            message: "socket closed".into(),
        }))
    }

    fn handle_frame(&self, text: &str) {
        let msg = match serde_json::from_str::<ServerMessage>(text) {
            Ok(m) => m,
            Err(e) => {
                let err = SyncError::Protocol(format!("undecodable server frame ({e}): {text}"));
                let mut st = self.state.lock().unwrap();
                for (_, tx) in st.pending.drain() {
                    let _ = tx.send(Routed::Error(err.clone()));
                }
                return;
            }
        };
        let mut st = self.state.lock().unwrap();
        match msg {
            ServerMessage::Pong => st.pong_waiters.drain(..).for_each(|w| {
                let _ = w.send(());
            }),
            ServerMessage::Chunk { request_id, values } => {
                if let Some(tx) = st.pending.get(&request_id) {
                    let _ = tx.send(Routed::Chunk(values));
                }
            }
            ServerMessage::Exit { request_id, exit } => {
                if let Some(tx) = st.pending.remove(&request_id) {
                    let _ = tx.send(Routed::Exit(exit));
                }
            }
            ServerMessage::Defect { defect } => {
                for (_, tx) in st.pending.drain() {
                    let _ = tx.send(Routed::Error(SyncError::Defect(defect.clone())));
                }
            }
        }
    }

    fn fail_all(&self, reason: SocketError) {
        let mut st = self.state.lock().unwrap();
        if st.closed.is_some() {
            return;
        }
        st.closed = Some(reason.clone());
        st.pong_waiters.clear();
        for (_, tx) in st.pending.drain() {
            let _ = tx.send(Routed::Error(SyncError::Socket(reason.clone())));
        }
        drop(st);
        self.open.send_replace(false);
        let _ = self.out.send(String::new());
    }
}

/// `None` for a pure interrupt (normal end of a pull).
pub(crate) fn cause_to_error(cause: Vec<CauseReason>) -> Option<SyncError> {
    let mut first = None;
    for reason in cause {
        let err = match reason {
            CauseReason::Fail { error } => error.into(),
            CauseReason::Die { defect } => SyncError::Defect(defect),
            CauseReason::Interrupt { .. } => continue,
        };
        first.get_or_insert(err);
    }
    first
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("wire type serializes")
}

/// JS `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_double_encoding_matches_ts_client() {
        let json = serde_json::json!({"authToken": "insecure-token"}).to_string();
        assert_eq!(
            encode_uri_component(&encode_uri_component(&json)),
            "%257B%2522authToken%2522%253A%2522insecure-token%2522%257D"
        );
    }
}

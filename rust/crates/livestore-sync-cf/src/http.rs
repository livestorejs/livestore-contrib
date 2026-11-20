//! HTTP transport (`client/transport/http-rpc-client.ts`): one Effect RPC request per POST, the
//! response body is a JSON array of `Chunk`/`Exit` messages. Live pulls poll.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, StreamExt};
use livestore_core::GlobalEvent;
use livestore_sync::{
    BackendIdStore, BackendMetadata, ConnectError, PingError, PullCursor, PullOptions, PullStream,
    PushError, Supports, SyncBackend, SyncBackendConstructor, constructor,
};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::transport::{
    self, Exit, HttpErrorKind, PullRequest, PullResponse, PushRequest, Request, RequestId,
    ServerMessage, SyncError,
};
use crate::{map_rpc_client_error, pull_error, push_error, res_item, split_batch};

pub const PULL_TAG: &str = "SyncHttpRpc.Pull";
pub const PUSH_TAG: &str = "SyncHttpRpc.Push";
pub const PING_TAG: &str = "SyncHttpRpc.Ping";

#[derive(Debug, Clone)]
pub struct HttpSyncOptions {
    pub headers: Vec<(String, String)>,
    /// `livePull.pollInterval`.
    pub poll_interval: Duration,
    pub ping_enabled: bool,
    pub ping_timeout: Duration,
    pub ping_interval: Duration,
}

impl Default for HttpSyncOptions {
    fn default() -> Self {
        Self {
            headers: vec![],
            poll_interval: Duration::from_secs(5),
            ping_enabled: true,
            ping_timeout: Duration::from_secs(10),
            ping_interval: Duration::from_secs(10),
        }
    }
}

/// `makeHttpSync({ url, ... })`.
pub fn make_http_sync(url: &str, options: HttpSyncOptions) -> SyncBackendConstructor {
    let url = url.to_owned();
    constructor(move |args| {
        let mut endpoint = format!(
            "{}/?storeId={}&transport=http",
            url.trim_end_matches('/'),
            transport::encode_uri_component(&args.store_id)
        );
        if let Some(p) = &args.payload {
            endpoint.push_str("&payload=");
            endpoint.push_str(&transport::encode_uri_component(
                &transport::encode_uri_component(&p.to_string()),
            ));
        }
        let backend = Arc::new(Inner {
            url: url.clone(),
            endpoint,
            store_id: args.store_id,
            payload: args.payload,
            options: options.clone(),
            backend_id: args.backend_id,
            http: reqwest::Client::new(),
            next_id: AtomicU64::new(0),
            push_lock: tokio::sync::Mutex::new(()),
            connected: watch::channel(false).0,
        });
        if options.ping_enabled {
            tokio::spawn(ping_loop(Arc::downgrade(&backend), options.ping_interval));
        }
        async move { Ok(Arc::new(HttpBackend(backend)) as Arc<dyn SyncBackend>) }
    })
}

struct HttpBackend(Arc<Inner>);

struct Inner {
    url: String,
    endpoint: String,
    store_id: String,
    payload: Option<Value>,
    options: HttpSyncOptions,
    backend_id: Arc<dyn BackendIdStore>,
    http: reqwest::Client,
    next_id: AtomicU64,
    push_lock: tokio::sync::Mutex<()>,
    connected: watch::Sender<bool>,
}

impl SyncBackend for HttpBackend {
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>> {
        let this = self.0.clone();
        Box::pin(async move { this.ping().await.map_err(map_rpc_client_error) })
    }

    fn pull(&self, cursor: Option<PullCursor>, options: PullOptions) -> PullStream {
        let state = (
            self.0.clone(),
            cursor.map(|c| c.event_sequence_number),
            true,
            VecDeque::<PullResponse>::new(),
            false,
        );
        stream::unfold(
            state,
            move |(this, mut cursor, mut first, mut page, failed)| async move {
                if failed {
                    return None;
                }
                loop {
                    if let Some(res) = page.pop_front() {
                        let mut last = cursor.unwrap_or(0);
                        let item = res_item(res, &*this.backend_id, &mut last);
                        if !item.batch.is_empty() {
                            cursor = Some(last);
                        }
                        return Some((Ok(item), (this, cursor, first, page, false)));
                    }
                    if !first && !options.live {
                        return None;
                    }
                    // Live: poll for events after the last one seen.
                    if !first {
                        tokio::time::sleep(this.options.poll_interval).await;
                    }
                    first = false;
                    match this.pull_once(cursor.map(|n| this.wire_cursor(n))).await {
                        Ok(items) => page = items.into(),
                        Err(e) => {
                            return Some((Err(pull_error(e)), (this, cursor, first, page, true)));
                        }
                    }
                }
            },
        )
        .boxed()
    }

    fn push(&self, batch: Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>> {
        let this = self.0.clone();
        Box::pin(async move {
            if batch.is_empty() {
                return Ok(());
            }
            let _permit = this.push_lock.lock().await;
            let backend_id = this.backend_id.get();
            let chunks = split_batch(&this.store_id, &this.payload, &backend_id, batch)
                .map_err(livestore_sync::UnknownError::new)?;
            for chunk in chunks {
                let req = PushRequest {
                    store_id: this.store_id.clone(),
                    payload: this.payload.clone(),
                    batch: chunk,
                    backend_id: backend_id.clone().into(),
                };
                this.call(PUSH_TAG, to_value(&req))
                    .await
                    .map_err(push_error)?;
            }
            Ok(())
        })
    }

    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>> {
        let this = self.0.clone();
        Box::pin(async move { this.ping().await.map_err(map_rpc_client_error) })
    }

    fn is_connected(&self) -> watch::Receiver<bool> {
        self.0.connected.subscribe()
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "@livestore/cf-sync-http".into(),
            description: "LiveStore sync backend implementation using HTTP RPC".into(),
            extra: [
                ("protocol".to_owned(), "http".into()),
                ("url".to_owned(), self.0.url.clone().into()),
            ]
            .into_iter()
            .collect(),
        }
    }

    fn supports(&self) -> Supports {
        Supports {
            pull_page_info_known: true,
            pull_live: true,
        }
    }
}

impl Inner {
    /// Ping; a timeout only marks the backend disconnected (TS `timeoutOrElse`).
    async fn ping(&self) -> Result<(), SyncError> {
        let req = json!({ "storeId": self.store_id, "payload": self.payload });
        match tokio::time::timeout(
            self.options.ping_timeout,
            self.call(PING_TAG, strip_null_payload(req)),
        )
        .await
        {
            Ok(Ok(_)) => {
                self.connected.send_replace(true);
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.connected.send_replace(false);
                Ok(())
            }
        }
    }

    fn wire_cursor(&self, event_sequence_number: i64) -> transport::PullCursor {
        let backend_id = self
            .backend_id
            .get()
            .expect("a cursor pull needs a known backend id");
        transport::PullCursor {
            backend_id,
            event_sequence_number,
        }
    }

    async fn pull_once(
        &self,
        cursor: Option<transport::PullCursor>,
    ) -> Result<Vec<PullResponse>, SyncError> {
        let req = PullRequest {
            store_id: self.store_id.clone(),
            payload: self.payload.clone(),
            live: false,
            cursor: cursor.into(),
        };
        let mut body = to_value(&req);
        body.as_object_mut().expect("object").remove("live");
        let chunks = self.call(PULL_TAG, body).await?;
        chunks
            .into_iter()
            .map(|v| serde_json::from_value(v).map_err(|e| SyncError::Protocol(e.to_string())))
            .collect()
    }

    /// One RPC round trip: returns the `Chunk` values, or the `Exit` failure.
    async fn call(&self, tag: &str, payload: Value) -> Result<Vec<Value>, SyncError> {
        let id = RequestId::Str(self.next_id.fetch_add(1, Ordering::Relaxed).to_string());
        let request = Request {
            id: id.clone(),
            tag: tag.to_owned(),
            payload,
            headers: vec![],
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let body = serde_json::to_vec(&transport::ClientMessage::Request(request))
            .map_err(|e| http_error(HttpErrorKind::Encode, e))?;
        let mut builder = self
            .http
            .post(&self.endpoint)
            .header("content-type", "application/json")
            .header("x-livestore-store-id", &self.store_id);
        for (k, v) in &self.options.headers {
            builder = builder.header(k, v);
        }
        let response = builder.body(body).send().await.map_err(|e| {
            let kind = if e.is_builder() {
                HttpErrorKind::InvalidUrl
            } else {
                HttpErrorKind::Transport
            };
            http_error(kind, e)
        })?;
        if !response.status().is_success() {
            return Err(http_error(HttpErrorKind::StatusCode, response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| http_error(HttpErrorKind::Transport, e))?;
        if bytes.is_empty() {
            return Err(http_error(HttpErrorKind::EmptyBody, "empty body"));
        }
        let messages: Vec<ServerMessage> =
            serde_json::from_slice(&bytes).map_err(|e| http_error(HttpErrorKind::Decode, e))?;
        let mut values = vec![];
        for message in messages {
            match message {
                ServerMessage::Chunk {
                    request_id,
                    values: v,
                } if request_id == id => values.extend(v),
                ServerMessage::Exit { request_id, exit } if request_id == id => {
                    return match exit {
                        Exit::Success { value } if values.is_empty() && !value.is_null() => {
                            Ok(vec![value])
                        }
                        Exit::Success { .. } => Ok(values),
                        Exit::Failure { cause } => Err(transport::cause_to_error(cause)
                            .unwrap_or_else(|| SyncError::Protocol("request interrupted".into()))),
                    };
                }
                ServerMessage::Defect { defect } => return Err(SyncError::Defect(defect)),
                _ => {}
            }
        }
        Err(SyncError::Protocol("response ended without an Exit".into()))
    }
}

async fn ping_loop(backend: Weak<Inner>, interval: Duration) {
    loop {
        let Some(inner) = backend.upgrade() else {
            return;
        };
        let _ = inner.ping().await;
        drop(inner);
        tokio::time::sleep(interval).await;
    }
}

fn strip_null_payload(mut v: Value) -> Value {
    if v["payload"].is_null() {
        v.as_object_mut().expect("object").remove("payload");
    }
    v
}

fn http_error(kind: HttpErrorKind, e: impl ToString) -> SyncError {
    SyncError::Http {
        kind,
        message: e.to_string(),
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("wire type serializes")
}

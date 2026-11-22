//! sync-cf provider client: the WebSocket transport (`transport`) and a [`SyncBackend`] on top of it
//! (`packages/@livestore/sync-cf/src/client`). Protocol reference: `contributor-docs/rust/sync-cf-wire-protocol.md`.

#![warn(clippy::unwrap_used)]

pub mod http;
pub mod pull_policy;
pub mod transport;

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, StreamExt};
use livestore_core::GlobalEvent;
use livestore_sync::{
    BackendIdMismatchError, BackendIdStore, BackendMetadata, ConnectError, IsOfflineError,
    PingError, PullCursor, PullError, PullItem, PullOptions, PullResItem, PullStream, PushError,
    ServerAheadError, Supports, SyncBackend, SyncBackendConstructor, TimeoutError, UnknownError,
    constructor,
};
use serde_json::Value;
use tokio::sync::watch;

use crate::transport::{Client, ClientOptions, HttpErrorKind, SocketErrorKind, SyncError};

/// `MAX_PUSH_EVENTS_PER_REQUEST`.
pub const MAX_PUSH_EVENTS_PER_REQUEST: usize = 100;
/// `MAX_TRANSPORT_PAYLOAD_BYTES` (WS message and HTTP request cap).
pub const MAX_TRANSPORT_PAYLOAD_BYTES: usize = 900_000;

/// `makeWsSync({ url })`: a constructor for the leader builder.
#[must_use]
pub fn make_ws_sync(url: &str, options: ClientOptions) -> SyncBackendConstructor {
    let url = url.to_owned();
    constructor(move |args| {
        let backend = CfSyncBackend {
            url: url.clone(),
            store_id: args.store_id,
            payload: args.payload,
            options: options.clone(),
            backend_id: args.backend_id,
            client: tokio::sync::Mutex::new(None),
            connected: watch::channel(false).0,
        };
        async move { Ok(Arc::new(CfBackend(Arc::new(backend))) as Arc<dyn SyncBackend>) }
    })
}

struct CfBackend(Arc<CfSyncBackend>);

struct CfSyncBackend {
    url: String,
    store_id: String,
    payload: Option<Value>,
    options: ClientOptions,
    backend_id: Arc<dyn BackendIdStore>,
    client: tokio::sync::Mutex<Option<Client>>,
    connected: watch::Sender<bool>,
}

impl CfSyncBackend {
    /// The open socket, reconnecting when the previous one is gone.
    async fn client(self: &Arc<Self>) -> Result<Client, SyncError> {
        let mut slot = self.client.lock().await;
        if let Some(c) = slot.as_ref().filter(|c| c.closed_reason().is_none()) {
            return Ok(c.clone());
        }
        let client = transport::connect_with(
            &self.url,
            &self.store_id,
            self.payload.clone(),
            self.options.clone(),
        )
        .await?;
        let mut open = client.open_state();
        let connected = self.connected.clone();
        connected.send_replace(true);
        tokio::spawn(async move {
            let _ = open.wait_for(|o| !*o).await;
            connected.send_replace(false);
        });
        *slot = Some(client.clone());
        Ok(client)
    }
}

impl SyncBackend for CfBackend {
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>> {
        let this = self.0.clone();
        Box::pin(async move { this.client().await.map(drop).map_err(map_rpc_client_error) })
    }

    fn pull(&self, cursor: Option<PullCursor>, options: PullOptions) -> PullStream {
        let this = self.0.clone();
        let last_seen = cursor.as_ref().map_or(0, |c| c.event_sequence_number);
        let init = async move {
            let client = this.client().await.map_err(pull_error)?;
            let wire_cursor =
                cursor
                    .zip(this.backend_id.get())
                    .map(|(c, backend_id)| transport::PullCursor {
                        backend_id,
                        event_sequence_number: c.event_sequence_number,
                    });
            let pull = client.pull(wire_cursor, options.live).map_err(pull_error)?;
            Ok::<_, PullError>((pull, this))
        };
        stream::once(init)
            .flat_map(move |started| match started {
                Err(e) => stream::iter([Err(e)]).boxed(),
                Ok((pull, this)) => stream::unfold(
                    (Some(pull), this, last_seen),
                    move |(pull, this, mut last_seen)| async move {
                        let mut pull = pull?;
                        let item = match pull.next().await {
                            Some(Ok(res)) => Ok(res_item(res, &*this.backend_id, &mut last_seen)),
                            Some(Err(e)) => {
                                return Some((Err(pull_error(e)), (None, this, last_seen)));
                            }
                            None if options.live => {
                                return Some((
                                    Err(IsOfflineError {
                                        cause: "live pull ended".into(),
                                    }
                                    .into()),
                                    (None, this, last_seen),
                                ));
                            }
                            None => return None,
                        };
                        Some((item, (Some(pull), this, last_seen)))
                    },
                )
                .boxed(),
            })
            .boxed()
    }

    fn push(&self, batch: Vec<GlobalEvent>) -> BoxFuture<'static, Result<(), PushError>> {
        let this = self.0.clone();
        Box::pin(async move {
            if batch.is_empty() {
                return Ok(());
            }
            let client = this.client().await.map_err(push_error)?;
            let backend_id = this.backend_id.get();
            let chunks = split_batch(
                &this.store_id,
                this.payload.as_ref(),
                backend_id.as_ref(),
                batch,
            )
            .map_err(UnknownError::new)?;
            for chunk in chunks {
                client
                    .push(chunk, this.backend_id.get())
                    .await
                    .map_err(push_error)?;
            }
            Ok(())
        })
    }

    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>> {
        let this = self.0.clone();
        Box::pin(async move {
            let client = this
                .client()
                .await
                .map_err(map_rpc_client_error::<PingError>)?;
            client
                .ping(Duration::from_secs(10))
                .await
                .map_err(|e| match e {
                    SyncError::Socket(s) if s.kind == SocketErrorKind::PongTimeout => {
                        TimeoutError.into()
                    }
                    other => map_rpc_client_error(other),
                })
        })
    }

    fn is_connected(&self) -> watch::Receiver<bool> {
        self.0.connected.subscribe()
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "@livestore/cf-sync".into(),
            description:
                "LiveStore sync backend implementation using Cloudflare Workers & Durable Objects"
                    .into(),
            extra: [
                ("protocol".to_owned(), "ws".into()),
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

/// Stores the backend id and strips already-seen events (the DO can deliver a live page twice,
/// seen after a `ServerAheadError`).
pub(crate) fn res_item(
    res: transport::PullResponse,
    backend_id: &dyn BackendIdStore,
    last_seen: &mut i64,
) -> PullResItem {
    backend_id.set(&res.backend_id);
    let batch: Vec<PullItem> = res
        .batch
        .into_iter()
        .filter(|i| i.event_encoded.seq_num > *last_seen)
        .map(|i| PullItem {
            metadata: Option::<transport::SyncMetadata>::from(i.metadata)
                .map(|m| serde_json::to_value(m).expect("metadata serializes")),
            event_encoded: i.event_encoded,
        })
        .collect();
    *last_seen = batch.last().map_or(*last_seen, |i| i.event_encoded.seq_num);
    PullResItem {
        batch,
        page_info: res.page_info,
    }
}

/// `mapRpcClientError`: only transport loss is retryable (offline); RPC defects and HTTP protocol
/// failures stay terminal. Application errors are classified by the callers before this.
#[must_use]
pub fn map_rpc_client_error<E: From<IsOfflineError> + From<UnknownError>>(e: SyncError) -> E {
    match e {
        SyncError::Socket(s) => IsOfflineError {
            cause: s.to_string(),
        }
        .into(),
        SyncError::Http {
            kind: HttpErrorKind::Transport,
            message,
        } => IsOfflineError { cause: message }.into(),
        other => UnknownError::new(other).into(),
    }
}

pub(crate) fn pull_error(e: SyncError) -> PullError {
    match e {
        SyncError::BackendIdMismatch { expected, received } => {
            BackendIdMismatchError { expected, received }.into()
        }
        other => map_rpc_client_error(other),
    }
}

pub(crate) fn push_error(e: SyncError) -> PushError {
    match e {
        SyncError::ServerAhead {
            minimum_expected_num,
            provided_num,
        } => ServerAheadError {
            minimum_expected_num,
            provided_num,
        }
        .into(),
        SyncError::BackendIdMismatch { expected, received } => {
            BackendIdMismatchError { expected, received }.into()
        }
        other => map_rpc_client_error(other),
    }
}

/// `splitArrayBySize`: ≤ 100 events and ≤ 900 kB encoded push payload per request.
pub(crate) fn split_batch(
    store_id: &str,
    payload: Option<&Value>,
    backend_id: Option<&String>,
    batch: Vec<GlobalEvent>,
) -> Result<Vec<Vec<GlobalEvent>>, String> {
    let size = |items: &[GlobalEvent]| {
        let req = transport::PushRequest {
            store_id: store_id.to_owned(),
            payload: payload.cloned(),
            batch: items.to_vec(),
            backend_id: backend_id.cloned().into(),
        };
        serde_json::to_vec(&req)
            .expect("push request serializes")
            .len()
    };
    let mut chunks: Vec<Vec<GlobalEvent>> = vec![];
    let mut current: Vec<GlobalEvent> = vec![];
    for event in batch {
        current.push(event);
        if current.len() > 1
            && (current.len() > MAX_PUSH_EVENTS_PER_REQUEST
                || size(&current) > MAX_TRANSPORT_PAYLOAD_BYTES)
        {
            let last = current.pop().expect("non-empty");
            chunks.push(std::mem::replace(&mut current, vec![last]));
        }
        if current.len() == 1 && size(&current) > MAX_TRANSPORT_PAYLOAD_BYTES {
            return Err(format!(
                "OversizeChunkItemError: {} > {MAX_TRANSPORT_PAYLOAD_BYTES}",
                size(&current)
            ));
        }
    }
    chunks.push(current);
    Ok(chunks)
}

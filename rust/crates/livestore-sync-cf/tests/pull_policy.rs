//! Port of the DO-RPC-only cases of `sync-cf/src/client/transport/do-rpc-client.test.ts`: the same
//! policies (`pull_policy`) over a scripted fake transport whose calls carry Cloudflare RPC flags.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, BoxStream};
use futures::{FutureExt, StreamExt};
use livestore_sync::testing::{ClientIdentity, EventFactory};
use livestore_sync::*;
use livestore_sync_cf::pull_policy::*;
use serde_json::json;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

type Pages = BoxStream<'static, Result<PullResItem, TransportFailure>>;
type Stub = Box<dyn FnOnce() -> Result<Pages, CfRpcError> + Send>;

#[tokio::test(start_paused = true)]
async fn overloaded_and_retryable_pull_dies_with_the_original_error_without_waiting() {
    terminal_pull(flags(true, true, false)).await;
}

#[tokio::test(start_paused = true)]
async fn overloaded_and_retryable_push_dies_with_the_original_error() {
    terminal_push(flags(true, true, false)).await;
}

#[tokio::test(start_paused = true)]
async fn remote_only_pull_dies_with_the_original_error_without_waiting() {
    terminal_pull(flags(false, false, true)).await;
}

#[tokio::test(start_paused = true)]
async fn remote_only_push_dies_with_the_original_error() {
    terminal_push(flags(false, false, true)).await;
}

#[tokio::test(start_paused = true)]
async fn unflagged_pull_dies_with_the_original_error_without_waiting() {
    terminal_pull(flags(false, false, false)).await;
}

#[tokio::test(start_paused = true)]
async fn unflagged_push_dies_with_the_original_error() {
    terminal_push(flags(false, false, false)).await;
}

#[tokio::test(start_paused = true)]
async fn backoff_grows_to_the_cap_across_pulls_that_each_deliver_a_page_and_then_fail() {
    let expected = [1, 2, 4, 8, 16, 30, 30];
    let backend = backend(
        expected
            .iter()
            .map(|_| page_then_reject(flags(false, true, false)))
            .collect(),
    );
    for secs in expected {
        let (items, waited) = pull_timed(&backend).await;
        assert!(
            matches!(items.last(), Some(Err(PullError::IsOffline(_)))),
            "{items:?}"
        );
        assert_backoff(waited, secs);
    }
}

#[tokio::test(start_paused = true)]
async fn backoff_interrupts_a_pull_while_it_is_waiting_to_retry() {
    let backend = backend(vec![reject(flags(false, true, false))]);
    let task = tokio::spawn(async move {
        backend
            .pull(None, PullOptions::default())
            .collect::<Vec<_>>()
            .await
    });
    tokio::time::sleep(PULL_BACKOFF_BASE.mul_f64(PULL_BACKOFF_JITTER.0) / 2).await;
    assert!(!task.is_finished(), "pull should still be waiting to retry");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn backoff_resets_once_a_pull_completes_its_catch_up() {
    let failure = || reject(flags(false, true, false));
    let backend = backend(vec![
        failure(),
        failure(),
        serve(vec![PageInfo::NoMore]),
        failure(),
    ]);
    pull_timed(&backend).await;
    pull_timed(&backend).await;
    let (completed, _) = pull_timed(&backend).await;
    let (_, after_reset) = pull_timed(&backend).await;
    assert!(completed.iter().all(Result::is_ok), "{completed:?}");
    assert_backoff(after_reset, 1);
}

#[tokio::test(start_paused = true)]
async fn a_stalled_catch_up_releases_its_producer_and_recovers_on_a_fresh_stub() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = DropFlag(cancelled.clone());
    let stalled: Stub = Box::new(move || {
        Ok(stream::iter([Ok(page(PageInfo::MoreUnknown))])
            .chain(stream::pending().map(move |x| {
                let _ = &guard;
                x
            }))
            .boxed())
    });
    let backend = backend(vec![stalled, serve(vec![PageInfo::NoMore])]);
    let (items, waited) = pull_timed(&backend).await;
    assert!(
        matches!(items.as_slice(), [Ok(_), Err(PullError::IsOffline(_))]),
        "{items:?}"
    );
    assert!(waited >= CATCH_UP_DEADLINE);
    assert!(
        cancelled.load(Ordering::SeqCst),
        "the stalled producer was not released"
    );
    let (recovered, _) = pull_timed(&backend).await;
    assert_eq!(recovered.len(), 1);
    assert!(recovered[0].is_ok());
}

#[tokio::test(start_paused = true)]
async fn the_catch_up_deadline_restarts_for_each_page() {
    let (send_first, first) = oneshot::channel::<()>();
    let (send_last, last) = oneshot::channel::<()>();
    let gated: Stub = Box::new(move || {
        Ok(stream::once(first.map(|_| Ok(page(PageInfo::MoreUnknown))))
            .chain(stream::once(last.map(|_| Ok(page(PageInfo::NoMore)))))
            .boxed())
    });
    let backend = backend(vec![gated]);
    let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        backend
            .pull(None, PullOptions::default())
            .inspect(move |_| {
                let _ = seen_tx.send(());
            })
            .collect::<Vec<_>>()
            .await
    });
    tokio::time::sleep(Duration::from_secs(40)).await;
    send_first.send(()).unwrap();
    seen.recv().await.unwrap();
    tokio::time::sleep(Duration::from_secs(40)).await;
    send_last.send(()).unwrap();
    let items = task.await.unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(Result::is_ok), "{items:?}");
}

#[tokio::test(start_paused = true)]
async fn overload_on_a_stream_read_remains_terminal() {
    let error = flags(true, true, false);
    let backend = backend(vec![page_then_reject(error.clone())]);
    let (items, waited) = pull_timed(&backend).await;
    assert_eq!(items.last(), Some(&Err(UnknownError::new(error).into())));
    assert_eq!(waited, Duration::ZERO);
}

#[test]
fn classification_matches_the_ts_flag_rules() {
    let offline = |f| matches!(classify_transport_failure(f), Classified::Offline(_));
    assert!(offline(TransportFailure::Call(flags(false, true, false))));
    assert!(!offline(TransportFailure::Call(flags(true, true, false))));
    assert!(!offline(TransportFailure::Call(flags(false, false, true))));
    assert!(!offline(TransportFailure::Call(flags(false, false, false))));
    assert!(offline(TransportFailure::StreamRead(flags(
        false, false, false
    ))));
    assert!(!offline(TransportFailure::StreamRead(flags(
        false, false, true
    ))));
    assert!(!offline(TransportFailure::StreamRead(flags(
        true, true, false
    ))));
}

async fn terminal_pull(error: CfRpcError) {
    assert_eq!(
        classify_transport_failure(TransportFailure::Call(error.clone())),
        Classified::Terminal(error.clone())
    );
    let backend = backend(vec![reject(error.clone())]);
    let (items, waited) = pull_timed(&backend).await;
    assert_eq!(items, vec![Err(UnknownError::new(error).into())]);
    assert_eq!(waited, Duration::ZERO);
}

async fn terminal_push(error: CfRpcError) {
    let backend = backend(vec![reject(error.clone())]);
    let mut f = EventFactory::new(ClientIdentity::new("client"));
    let result = backend.push(vec![f.next("todoCreated", json!({}))]).await;
    assert_eq!(result, Err(UnknownError::new(error).into()));
}

fn flags(overloaded: bool, retryable: bool, remote: bool) -> CfRpcError {
    CfRpcError {
        message: "Network connection lost.".into(),
        retryable,
        overloaded,
        remote,
    }
}

fn page(page_info: PageInfo) -> PullResItem {
    PullResItem {
        batch: vec![],
        page_info,
    }
}

fn reject(error: CfRpcError) -> Stub {
    Box::new(move || Err(error))
}

fn serve(pages: Vec<PageInfo>) -> Stub {
    Box::new(move || Ok(stream::iter(pages.into_iter().map(|p| Ok(page(p)))).boxed()))
}

/// Delivers one page, then fails the next stream read with `error`.
fn page_then_reject(error: CfRpcError) -> Stub {
    Box::new(move || {
        Ok(stream::iter([
            Ok(page(PageInfo::MoreUnknown)),
            Err(TransportFailure::StreamRead(error)),
        ])
        .boxed())
    })
}

async fn pull_timed(
    backend: &Arc<dyn SyncBackend>,
) -> (Vec<Result<PullResItem, PullError>>, Duration) {
    let start = Instant::now();
    let items = backend.pull(None, PullOptions::default()).collect().await;
    (items, start.elapsed())
}

fn assert_backoff(waited: Duration, base_secs: u64) {
    let base = Duration::from_secs(base_secs);
    assert!(
        waited >= base.mul_f64(0.8) && waited <= base.mul_f64(1.2),
        "waited {waited:?}, expected ~{base:?}"
    );
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Each call consumes the next stub, like `getSyncBackendStub` handing out a fresh stub per call.
fn backend(stubs: Vec<Stub>) -> Arc<dyn SyncBackend> {
    with_pull_policy(
        Arc::new(FakeTransport {
            stubs: Mutex::new(stubs.into()),
            connected: watch::channel(true).0,
        }),
        Arc::new(StdRandom),
    )
}

struct FakeTransport {
    stubs: Mutex<VecDeque<Stub>>,
    connected: watch::Sender<bool>,
}

impl FakeTransport {
    fn call(&self) -> Result<Pages, CfRpcError> {
        (self
            .stubs
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra stub"))()
    }
}

impl SyncBackend for FakeTransport {
    fn connect(&self) -> BoxFuture<'static, Result<(), ConnectError>> {
        async { Ok(()) }.boxed()
    }

    fn pull(&self, _: Option<PullCursor>, _: PullOptions) -> PullStream {
        match self.call() {
            Err(e) => stream::iter([Err(
                classify_transport_failure(TransportFailure::Call(e)).into_error()
            )])
            .boxed(),
            Ok(pages) => pages
                .map(|r| r.map_err(|f| classify_transport_failure(f).into_error()))
                .boxed(),
        }
    }

    fn push(
        &self,
        _: Vec<livestore_core::GlobalEvent>,
    ) -> BoxFuture<'static, Result<(), PushError>> {
        let result = self
            .call()
            .map(drop)
            .map_err(|e| classify_transport_failure(TransportFailure::Call(e)).into_error());
        async move { result }.boxed()
    }

    fn ping(&self) -> BoxFuture<'static, Result<(), PingError>> {
        async { Ok(()) }.boxed()
    }

    fn is_connected(&self) -> watch::Receiver<bool> {
        self.connected.subscribe()
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            name: "fake-do-rpc".into(),
            description: String::new(),
            extra: Default::default(),
        }
    }

    fn supports(&self) -> Supports {
        Supports {
            pull_page_info_known: true,
            pull_live: true,
        }
    }
}

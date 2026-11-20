//! Leader configuration, mirroring `SyncOptions`, `MakeLeaderThreadLayerParams.params` and `.testing`.

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use livestore_core::Event;

use crate::backend::SyncBackendConstructor;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OnSyncError {
    Shutdown,
    #[default]
    Ignore,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OnBackendIdMismatch {
    #[default]
    Reset,
    Shutdown,
    Ignore,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InitialSyncOptions {
    #[default]
    Skip,
    /// Boot waits until the first pull reached `NoMore`, or the timeout.
    Blocking { timeout: Duration },
}

/// `retryDelay`: `min(max, base * 2^(attempt-1))`; pull retries add 0.8-1.2 jitter like TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    pub base: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    pub fn delay(&self, attempt: u32) -> Duration {
        let factor = 2u32.saturating_pow(attempt.saturating_sub(1));
        self.base.saturating_mul(factor).min(self.max)
    }
}

/// `SyncOptions`.
#[derive(Clone, Default)]
pub struct SyncOptions {
    pub backend: Option<SyncBackendConstructor>,
    pub live_pull: Option<bool>,
    pub on_sync_error: OnSyncError,
    pub on_backend_id_mismatch: OnBackendIdMismatch,
    pub initial_sync: InitialSyncOptions,
    pub backoff: Backoff,
}

/// `params`.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub local_push_batch_size: usize,
    pub backend_push_batch_size: usize,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            local_push_batch_size: 10,
            backend_push_batch_size: 50,
        }
    }
}

pub type Hook<A> = Arc<dyn Fn(A) -> BoxFuture<'static, ()> + Send + Sync>;

/// `{ isConnected, fallbackMs }` seen by `backendPullReconnectWait`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReconnectWait {
    pub is_connected: bool,
    pub fallback: Duration,
}

/// `testing.syncProcessor`: delays and hooks that let tests interleave with the mailbox.
#[derive(Clone, Default)]
pub struct Testing {
    /// Local work stays blocked until this future resolves (`delays.localPushProcessing`).
    pub local_push_processing: Option<Arc<Mutex<Option<BoxFuture<'static, ()>>>>>,
    /// Transforms the jittered pull retry fallback (`delays.backendPullReconnect`).
    pub backend_pull_reconnect: Option<Arc<dyn Fn(Duration) -> Duration + Send + Sync>>,
    pub local_push_admitted: Option<Hook<Vec<Event>>>,
    /// Runs in the mailbox before it handles a backend page.
    pub upstream_batch_received: Option<Hook<Vec<Event>>>,
    pub backend_pull_reconnect_wait: Option<Hook<ReconnectWait>>,
}

impl Testing {
    pub fn with_local_push_processing(
        mut self,
        delay: impl Future<Output = ()> + Send + 'static,
    ) -> Self {
        self.local_push_processing = Some(Arc::new(Mutex::new(Some(Box::pin(delay)))));
        self
    }
}

/// Wraps an async closure as a [`Hook`].
pub fn hook<A, F, Fut>(f: F) -> Hook<A>
where
    F: Fn(A) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    Arc::new(move |a| Box::pin(f(a)))
}

/// Random source (`Random` service), used for retry jitter.
pub trait Random: Send + Sync {
    /// Uniform in `[low, high)`.
    fn next_between(&self, low: f64, high: f64) -> f64;
}

/// Seeded from the std hasher's per-process random keys.
#[derive(Default)]
pub struct StdRandom;

impl Random for StdRandom {
    fn next_between(&self, low: f64, high: f64) -> f64 {
        let unit = (RandomState::new().hash_one(0u8) >> 11) as f64 / (1u64 << 53) as f64;
        low + unit * (high - low)
    }
}

/// Always returns the midpoint; makes jitter deterministic in tests.
pub struct FixedRandom;

impl Random for FixedRandom {
    fn next_between(&self, low: f64, high: f64) -> f64 {
        (low + high) / 2.0
    }
}

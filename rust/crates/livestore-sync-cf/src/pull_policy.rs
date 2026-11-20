//! The DO-RPC client's transport policies (`client/transport/do-rpc-client.ts`), transport-generic:
//! Cloudflare RPC failure classification, the catch-up deadline and the pull backoff.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures::StreamExt;
use futures::stream;
use livestore_sync::{
    BackendOverride, IsOfflineError, PageInfo, PullError, Random, StdRandom, SyncBackend,
    SyncBackendConstructor, UnknownError, constructor,
};

pub const PULL_BACKOFF_BASE: Duration = Duration::from_secs(1);
pub const PULL_BACKOFF_CAP: Duration = Duration::from_secs(30);
pub const PULL_BACKOFF_JITTER: (f64, f64) = (0.8, 1.2);
pub const CATCH_UP_DEADLINE: Duration = Duration::from_secs(60);

/// A Cloudflare RPC exception with the runtime flags it carries as own properties.
#[derive(Debug, Clone, Default, PartialEq, Eq, thiserror::Error)]
#[error("{message} (retryable: {retryable}, overloaded: {overloaded}, remote: {remote})")]
pub struct CfRpcError {
    pub message: String,
    pub retryable: bool,
    pub overloaded: bool,
    pub remote: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportFailure {
    /// The RPC call itself rejected.
    Call(CfRpcError),
    /// Reading a returned stream failed; transferred streams can lose the `retryable` flag.
    StreamRead(CfRpcError),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Classified {
    Offline(IsOfflineError),
    /// The TS client dies with the original error.
    Terminal(CfRpcError),
}

/// `classifyTransportFailure`: overload wins, then `retryable` (or an unflagged non-remote stream read).
pub fn classify_transport_failure(failure: TransportFailure) -> Classified {
    let (cause, stream_read) = match failure {
        TransportFailure::Call(c) => (c, false),
        TransportFailure::StreamRead(c) => (c, true),
    };
    if !cause.overloaded && (cause.retryable || (stream_read && !cause.remote)) {
        Classified::Offline(IsOfflineError {
            cause: cause.to_string(),
        })
    } else {
        Classified::Terminal(cause)
    }
}

impl Classified {
    pub fn into_error<E: From<IsOfflineError> + From<UnknownError>>(self) -> E {
        match self {
            Classified::Offline(e) => e.into(),
            Classified::Terminal(e) => UnknownError::new(e).into(),
        }
    }
}

/// `makePullBackoff`: the attempt count spans pulls and resets only when a pull completes its catch-up.
pub struct PullBackoff {
    attempt: AtomicU32,
    random: Arc<dyn Random>,
}

impl PullBackoff {
    pub fn new(random: Arc<dyn Random>) -> Self {
        Self {
            attempt: AtomicU32::new(0),
            random,
        }
    }

    pub async fn wait(&self) {
        let n = self.attempt.fetch_add(1, Ordering::SeqCst);
        let base = PULL_BACKOFF_BASE
            .saturating_mul(2u32.saturating_pow(n))
            .min(PULL_BACKOFF_CAP);
        tokio::time::sleep(
            base.mul_f64(
                self.random
                    .next_between(PULL_BACKOFF_JITTER.0, PULL_BACKOFF_JITTER.1),
            ),
        )
        .await;
    }

    pub fn reset(&self) {
        self.attempt.store(0, Ordering::SeqCst);
    }
}

/// Wraps every backend a constructor makes with [`with_pull_policy`].
pub fn pull_policy(inner: SyncBackendConstructor) -> SyncBackendConstructor {
    constructor(move |args| {
        let made = inner(args);
        async move { Ok(with_pull_policy(made.await?, Arc::new(StdRandom))) }
    })
}

/// Applies the DO-RPC pull policy: each catch-up page must arrive within [`CATCH_UP_DEADLINE`]
/// (the stalled pull is dropped), offline failures wait out the backoff before surfacing, and a
/// `NoMore` page resets the backoff. A live tail may stay idle indefinitely.
pub fn with_pull_policy(
    inner: Arc<dyn SyncBackend>,
    random: Arc<dyn Random>,
) -> Arc<dyn SyncBackend> {
    let backoff = Arc::new(PullBackoff::new(random));
    Arc::new(
        BackendOverride::new(inner).pull(move |inner, cursor, options| {
            let backoff = backoff.clone();
            stream::unfold(
                (Some(inner.pull(cursor, options)), false),
                move |(pull, mut caught_up)| {
                    let backoff = backoff.clone();
                    async move {
                        let mut pull = pull?;
                        let next = if caught_up {
                            pull.next().await
                        } else {
                            match tokio::time::timeout(CATCH_UP_DEADLINE, pull.next()).await {
                                Ok(next) => next,
                                Err(_) => Some(Err(IsOfflineError {
                                    cause: format!(
                                        "pull made no progress for {} seconds",
                                        CATCH_UP_DEADLINE.as_secs()
                                    ),
                                }
                                .into())),
                            }
                        };
                        match next? {
                            Ok(res) => {
                                if res.page_info == PageInfo::NoMore {
                                    backoff.reset();
                                    caught_up = true;
                                }
                                Some((Ok(res), (Some(pull), caught_up)))
                            }
                            Err(e) => {
                                drop(pull);
                                if matches!(e, PullError::IsOffline(_)) {
                                    backoff.wait().await;
                                }
                                Some((Err(e), (None, caught_up)))
                            }
                        }
                    }
                },
            )
            .boxed()
        }),
    )
}

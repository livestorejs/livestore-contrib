//! `StoreRegistry`: stores cached by `storeId`, reference counted, disposed after `unusedCacheTime`
//! without users (an `RcMap` with idle TTL). Failures stay cached until their entry is evicted.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::task::AbortHandle;

use crate::errors::StoreError;
use crate::store::{Store, StoreOptions, create_store};

/// `Number.POSITIVE_INFINITY` (the default outside a browser).
pub const NEVER: Duration = Duration::MAX;

pub type LoadResult = Result<Store, Arc<StoreError>>;
pub type LoadingStore = Shared<BoxFuture<'static, LoadResult>>;

#[derive(Clone)]
pub struct RegistryStoreOptions {
    pub store: StoreOptions,
    pub unused_cache_time: Option<Duration>,
}

impl From<StoreOptions> for RegistryStoreOptions {
    fn from(store: StoreOptions) -> Self {
        Self {
            store,
            unused_cache_time: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct RegistryDefaults {
    pub unused_cache_time: Option<Duration>,
}

/// What `getOrLoadPromise` returns without throwing: the cached store, or the (shared) load in progress.
pub enum StoreOrLoading {
    Store(Store),
    Loading(LoadingStore),
}

#[derive(Clone, Default)]
pub struct StoreRegistry {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    defaults: RegistryDefaults,
    entries: HashMap<String, Entry>,
    next_generation: u64,
}

struct Entry {
    generation: u64,
    state: State,
    rc: usize,
    ttl: Duration,
    idle_timer: Option<AbortHandle>,
}

enum State {
    Loading {
        future: LoadingStore,
        task: AbortHandle,
    },
    Loaded(Store),
    Failed(Arc<StoreError>),
}

impl StoreRegistry {
    pub fn new(defaults: RegistryDefaults) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                defaults,
                ..Inner::default()
            })),
        }
    }

    /// `getOrLoad(options).pipe(Effect.scoped)`: acquires and immediately releases the entry.
    pub async fn get_or_load(&self, options: &RegistryStoreOptions) -> LoadResult {
        let (generation, result) = match self.acquire(options) {
            Acquired::Ready(generation, result) => (generation, result),
            Acquired::Loading(generation, future) => {
                let result = future.await;
                (generation, result)
            }
        };
        self.release(&options.store.store_id, generation);
        result
    }

    /// `getOrLoadPromise`: the cached store or the shared pending load; a cached failure is returned as `Err`
    /// (TS throws synchronously).
    pub fn get_or_load_promise(
        &self,
        options: &RegistryStoreOptions,
    ) -> Result<StoreOrLoading, Arc<StoreError>> {
        match self.acquire(options) {
            Acquired::Ready(generation, result) => {
                self.release(&options.store.store_id, generation);
                result.map(StoreOrLoading::Store)
            }
            Acquired::Loading(generation, future) => {
                self.release(&options.store.store_id, generation);
                Ok(StoreOrLoading::Loading(future))
            }
        }
    }

    /// `retain(options)`: keeps the store (loading it if needed) until the returned release is called.
    pub fn retain(&self, options: &RegistryStoreOptions) -> impl FnOnce() + Send + 'static {
        let generation = match self.acquire(options) {
            Acquired::Ready(generation, _) | Acquired::Loading(generation, _) => generation,
        };
        let (registry, store_id) = (self.clone(), options.store.store_id.clone());
        move || registry.release(&store_id, generation)
    }

    /// `preload`: best effort, never fails.
    pub async fn preload(&self, options: &RegistryStoreOptions) {
        if let Ok(StoreOrLoading::Loading(future)) = self.get_or_load_promise(options) {
            let _ = future.await;
        }
    }

    fn acquire(&self, options: &RegistryStoreOptions) -> Acquired {
        let mut inner = lock(&self.inner);
        let store_id = options.store.store_id.clone();
        if let Some(entry) = inner.entries.get_mut(&store_id) {
            entry.rc += 1;
            if let Some(timer) = entry.idle_timer.take() {
                timer.abort();
            }
            let generation = entry.generation;
            return match &entry.state {
                State::Loaded(store) => Acquired::Ready(generation, Ok(store.clone())),
                State::Failed(e) => Acquired::Ready(generation, Err(e.clone())),
                State::Loading { future, .. } => Acquired::Loading(generation, future.clone()),
            };
        }
        let ttl = options
            .unused_cache_time
            .or(inner.defaults.unused_cache_time)
            .unwrap_or(NEVER);
        inner.next_generation += 1;
        let generation = inner.next_generation;
        let mut load = create_store(options.store.clone()).boxed();
        // A load that finishes without suspending is returned synchronously (`Effect.runSyncExit`).
        let state = match (&mut load).now_or_never() {
            Some(Ok(store)) => State::Loaded(store),
            Some(Err(e)) => State::Failed(Arc::new(e)),
            None => {
                let registry = self.clone();
                let id = store_id.clone();
                let task = tokio::spawn(async move {
                    let result = load.await.map_err(Arc::new);
                    registry.finish_load(&id, generation, &result);
                    result
                });
                let abort = task.abort_handle();
                let future = async move {
                    task.await.unwrap_or_else(|_| {
                        Err(Arc::new(StoreError::defect(
                            "store loading was interrupted",
                        )))
                    })
                }
                .boxed()
                .shared();
                State::Loading {
                    future,
                    task: abort,
                }
            }
        };
        let acquired = match &state {
            State::Loaded(store) => Acquired::Ready(generation, Ok(store.clone())),
            State::Failed(e) => Acquired::Ready(generation, Err(e.clone())),
            State::Loading { future, .. } => Acquired::Loading(generation, future.clone()),
        };
        inner.entries.insert(
            store_id,
            Entry {
                generation,
                state,
                rc: 1,
                ttl,
                idle_timer: None,
            },
        );
        acquired
    }

    fn finish_load(&self, store_id: &str, generation: u64, result: &LoadResult) {
        let mut inner = lock(&self.inner);
        match inner.entries.get_mut(store_id) {
            Some(entry) if entry.generation == generation => {
                entry.state = match result {
                    Ok(store) => State::Loaded(store.clone()),
                    Err(e) => State::Failed(e.clone()),
                };
            }
            // Evicted while loading: nobody can reach this store any more.
            _ => {
                if let Ok(store) = result {
                    let store = store.clone();
                    tokio::spawn(async move { store.close().await });
                }
            }
        }
    }

    fn release(&self, store_id: &str, generation: u64) {
        let mut inner = lock(&self.inner);
        let Some(entry) = inner
            .entries
            .get_mut(store_id)
            .filter(|e| e.generation == generation)
        else {
            return;
        };
        entry.rc -= 1;
        if entry.rc > 0 || entry.ttl == NEVER {
            return;
        }
        let (registry, id, ttl) = (self.clone(), store_id.to_string(), entry.ttl);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            registry.evict(&id, generation);
        });
        entry.idle_timer = Some(timer.abort_handle());
    }

    fn evict(&self, store_id: &str, generation: u64) {
        let entry = {
            let mut inner = lock(&self.inner);
            match inner.entries.get(store_id) {
                Some(e) if e.generation == generation && e.rc == 0 => {
                    inner.entries.remove(store_id)
                }
                _ => None,
            }
        };
        match entry.map(|e| e.state) {
            Some(State::Loaded(store)) => {
                tokio::spawn(async move { store.close().await });
            }
            Some(State::Loading { task, .. }) => task.abort(),
            _ => {}
        }
    }
}

enum Acquired {
    Ready(u64, LoadResult),
    Loading(u64, LoadingStore),
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

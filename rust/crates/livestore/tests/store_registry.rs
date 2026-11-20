//! Port of `packages/@livestore/livestore/src/store/StoreRegistry.test.ts`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use livestore::{
    Adapter, RegistryDefaults, RegistryStoreOptions, Store, StoreError, StoreOptions,
    StoreOrLoading, StoreRegistry, make_in_memory_adapter,
};

#[tokio::test]
async fn returns_a_promise_when_the_store_is_loading() {
    let registry = StoreRegistry::default();
    let Ok(StoreOrLoading::Loading(result)) = registry.get_or_load_promise(&options()) else {
        panic!("expected a pending load")
    };
    result.await.unwrap().shutdown(None).await;
}

#[tokio::test]
async fn returns_cached_store_synchronously_after_first_load_resolves() {
    let registry = StoreRegistry::default();
    let store = loading(&registry, &options()).await;
    let Ok(StoreOrLoading::Store(cached)) = registry.get_or_load_promise(&options()) else {
        panic!("expected a cached store")
    };
    assert_eq!(cached, store);
    store.shutdown(None).await;
}

#[tokio::test]
async fn reuses_the_same_promise_for_concurrent_get_or_load_promise_calls_while_loading() {
    let registry = StoreRegistry::default();
    let opts = options();
    let (Ok(StoreOrLoading::Loading(first)), Ok(StoreOrLoading::Loading(second))) = (
        registry.get_or_load_promise(&opts),
        registry.get_or_load_promise(&opts),
    ) else {
        panic!("expected pending loads")
    };
    assert!(first.ptr_eq(&second));
    let store = first.await.unwrap();
    assert_eq!(second.await.unwrap(), store);
    store.shutdown(None).await;
}

#[tokio::test]
async fn throws_synchronously_and_rethrows_on_subsequent_calls_for_sync_failures() {
    let registry = StoreRegistry::default();
    let bad = invalid_adapter_options();
    assert!(registry.get_or_load_promise(&bad).is_err());
    assert!(registry.get_or_load_promise(&bad).is_err());
}

#[tokio::test]
async fn caches_and_rethrows_rejection_on_subsequent_calls_for_async_failures() {
    let registry = StoreRegistry::default();
    let bad = with_adapter(async_failing_adapter());
    let Ok(StoreOrLoading::Loading(pending)) = registry.get_or_load_promise(&bad) else {
        panic!("expected a pending load")
    };
    assert!(pending.await.is_err());
    assert!(registry.get_or_load_promise(&bad).is_err());
}

#[tokio::test]
async fn throws_the_same_error_instance_on_multiple_calls_after_failure() {
    let registry = StoreRegistry::default();
    let bad = with_adapter(async_failing_adapter());
    let Ok(StoreOrLoading::Loading(pending)) = registry.get_or_load_promise(&bad) else {
        panic!("expected a pending load")
    };
    assert!(pending.await.is_err());
    let error1 = registry
        .get_or_load_promise(&bad)
        .err()
        .expect("cached failure");
    let error2 = registry
        .get_or_load_promise(&bad)
        .err()
        .expect("cached failure");
    assert!(Arc::ptr_eq(&error1, &error2));
}

#[tokio::test]
async fn preload_does_not_throw() {
    let registry = StoreRegistry::default();
    let bad = invalid_adapter_options();
    registry.preload(&bad).await;
    assert!(registry.get_or_load_promise(&bad).is_err());
}

#[tokio::test]
async fn warms_the_cache_so_subsequent_get_or_load_store_is_synchronous_after_preload() {
    let registry = StoreRegistry::default();
    let opts = options();
    registry.preload(&opts).await;
    let Ok(StoreOrLoading::Store(store)) = registry.get_or_load_promise(&opts) else {
        panic!("expected a cached store")
    };
    store.shutdown(None).await;
}

#[tokio::test(start_paused = true)]
async fn disposes_store_after_unused_cache_time_expires() {
    let registry = with_ttl(25);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
    advance(25).await;
    let next = registry.get_or_load(&opts).await.unwrap();
    assert_ne!(next, store);
    assert!(!next.client_session().debug_instance_id.is_empty());
}

#[tokio::test(start_paused = true)]
async fn does_not_dispose_when_unused_cache_time_is_infinity() {
    let registry = StoreRegistry::new(RegistryDefaults {
        unused_cache_time: Some(livestore::registry::NEVER),
    });
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    advance(100_000).await;
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn schedules_disposal_if_store_becomes_unused_during_loading() {
    let registry = with_ttl(50);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    advance(50).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn allows_call_site_options_to_override_default_options() {
    let registry = with_ttl(10_000);
    let opts = RegistryStoreOptions {
        unused_cache_time: Some(ms(25)),
        ..options()
    };
    let store = registry.get_or_load(&opts).await.unwrap();
    advance(25).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn disposes_different_stores_according_to_their_own_unused_cache_time() {
    let registry = with_ttl(1000);
    let short = RegistryStoreOptions {
        unused_cache_time: Some(ms(25)),
        ..options_for("short-lived")
    };
    let long = RegistryStoreOptions {
        unused_cache_time: Some(ms(10_000)),
        ..options_for("long-lived")
    };
    let short_store = registry.get_or_load(&short).await.unwrap();
    let long_store = registry.get_or_load(&long).await.unwrap();
    advance(25).await;
    assert_ne!(registry.get_or_load(&short).await.unwrap(), short_store);
    assert_eq!(registry.get_or_load(&long).await.unwrap(), long_store);
}

/// Skipped in TS too: dynamic `unusedCacheTime` updates for cached stores are unsupported (livestore#918).
#[tokio::test(start_paused = true)]
#[ignore = "it.effect.skip in TS: dynamic unusedCacheTime updates are unsupported"]
async fn keeps_the_longest_unused_cache_time_seen_for_a_store_when_options_vary_across_calls() {
    let registry = StoreRegistry::default();
    let opts = RegistryStoreOptions {
        unused_cache_time: Some(ms(10)),
        ..options()
    };
    let release = registry.retain(&opts);
    let store = registry.get_or_load(&opts).await.unwrap();
    registry
        .get_or_load(&RegistryStoreOptions {
            unused_cache_time: Some(ms(100)),
            ..options()
        })
        .await
        .unwrap();
    release();
    advance(99).await;
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
    advance(1).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn handles_rapid_retain_release_cycles_without_errors() {
    let registry = with_ttl(50);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    for _ in 0..10 {
        let release = registry.retain(&opts);
        release();
    }
    advance(50).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn cancels_disposal_when_new_retain() {
    let registry = with_ttl(50);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    advance(45).await;
    let release = registry.retain(&opts);
    advance(5).await;
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
    release();
    advance(50).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn aborts_loading_when_disposal_fires_while_store_is_still_loading() {
    let registry = with_ttl(10);
    let base = make_in_memory_adapter();
    let adapter: Adapter = Arc::new(move |args| {
        let base = base.clone();
        async move {
            tokio::time::sleep(ms(1000)).await;
            base(args).await
        }
        .boxed()
    });
    let opts = with_adapter(adapter);
    let release = registry.retain(&opts);
    tokio::task::yield_now().await;
    release();
    tokio::task::yield_now().await;
    advance(10).await;
    let fresh = tokio::spawn({
        let (registry, opts) = (registry.clone(), opts.clone());
        async move { registry.get_or_load(&opts).await }
    });
    tokio::task::yield_now().await;
    advance(1000).await;
    assert!(fresh.await.unwrap().is_ok());
}

#[tokio::test(start_paused = true)]
async fn retain_keeps_store_alive_past_unused_cache_time() {
    let registry = with_ttl(50);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    let release = registry.retain(&opts);
    advance(100).await;
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
    release();
}

#[tokio::test(start_paused = true)]
async fn manages_multiple_stores_with_different_ids_independently() {
    let registry = with_ttl(50);
    let (o1, o2) = (options_for("store-1"), options_for("store-2"));
    let s1 = registry.get_or_load(&o1).await.unwrap();
    let s2 = registry.get_or_load(&o2).await.unwrap();
    assert_ne!(s1, s2);
    assert_eq!(registry.get_or_load(&o1).await.unwrap(), s1);
    assert_eq!(registry.get_or_load(&o2).await.unwrap(), s2);
    advance(50).await;
    assert_ne!(registry.get_or_load(&o1).await.unwrap(), s1);
    assert_ne!(registry.get_or_load(&o2).await.unwrap(), s2);
}

#[tokio::test(start_paused = true)]
async fn applies_default_options_from_constructor() {
    let registry = with_ttl(100);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    assert!(!store.client_session().debug_instance_id.is_empty());
    advance(50).await;
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
}

#[tokio::test(start_paused = true)]
async fn does_not_serve_a_disposed_store_from_cache() {
    let registry = with_ttl(25);
    let opts = options();
    let original = registry.get_or_load(&opts).await.unwrap();
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), original);
    advance(25).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), original);
}

#[tokio::test(start_paused = true)]
async fn schedules_disposal_after_preload_if_no_retainers_are_added() {
    let registry = with_ttl(50);
    let opts = options();
    let store = registry.get_or_load(&opts).await.unwrap();
    assert_eq!(registry.get_or_load(&opts).await.unwrap(), store);
    advance(50).await;
    assert_ne!(registry.get_or_load(&opts).await.unwrap(), store);
}

fn options() -> RegistryStoreOptions {
    options_for("test-store")
}

fn options_for(store_id: &str) -> RegistryStoreOptions {
    StoreOptions::new(
        common::todomvc::schema(),
        make_in_memory_adapter(),
        store_id,
    )
    .into()
}

fn with_adapter(adapter: Adapter) -> RegistryStoreOptions {
    StoreOptions::new(common::todomvc::schema(), adapter, "test-store").into()
}

/// TS passes `adapter: null`.
fn invalid_adapter_options() -> RegistryStoreOptions {
    let mut opts = options();
    opts.store.adapter = None;
    opts
}

fn async_failing_adapter() -> Adapter {
    Arc::new(|_| {
        async {
            tokio::task::yield_now().await;
            Err(StoreError::Unknown("Async failure".into()))
        }
        .boxed()
    })
}

fn with_ttl(millis: u64) -> StoreRegistry {
    StoreRegistry::new(RegistryDefaults {
        unused_cache_time: Some(ms(millis)),
    })
}

fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
}

/// `Effect.yieldNow` + `TestClock.adjust`.
async fn advance(millis: u64) {
    tokio::task::yield_now().await;
    tokio::time::advance(ms(millis)).await;
    tokio::task::yield_now().await;
}

async fn loading(registry: &StoreRegistry, opts: &RegistryStoreOptions) -> Store {
    let Ok(StoreOrLoading::Loading(pending)) = registry.get_or_load_promise(opts) else {
        panic!("expected a pending load")
    };
    pending.await.unwrap()
}

//! Port of `packages/@livestore/livestore/src/store/create-store.test.ts`.

mod common;

use std::sync::{Arc, Mutex};

use futures::FutureExt;
use livestore::{Adapter, StoreError, StoreOptions, StoreParams, create_store};

#[tokio::test]
async fn validates_state_rebuild_batch_size_before_invoking_the_adapter() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let adapter: Adapter = {
        let observed = observed.clone();
        Arc::new(move |args| {
            observed.lock().unwrap().push(args.state_rebuild_batch_size);
            async { Err(StoreError::Unknown("adapter sentinel".into())) }.boxed()
        })
    };
    let run = |size: Option<f64>| {
        let mut options = StoreOptions::new(
            common::todomvc::schema(),
            adapter.clone(),
            "batch-size-test",
        );
        options.params = StoreParams {
            state_rebuild_batch_size: size,
            ..Default::default()
        };
        create_store(options)
    };
    for invalid in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
        assert!(
            matches!(run(Some(invalid)).await, Err(StoreError::Unknown(m)) if m.starts_with("Invalid stateRebuildBatchSize"))
        );
    }
    assert!(observed.lock().unwrap().is_empty());
    let _ = run(None).await;
    let _ = run(Some(1.0)).await;
    let _ = run(Some(100_000.0)).await;
    assert_eq!(*observed.lock().unwrap(), [100, 1, 100_000]);
}

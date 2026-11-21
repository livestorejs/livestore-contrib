mod common;

use std::sync::Arc;
use std::time::Duration;

use futures::{StreamExt, stream};

use common::fixture_schema;
use livestore_sync::testing::{MockSyncBackend, MockSyncBackendOptions};
use livestore_sync::*;

#[tokio::test]
async fn a_cancelled_blocking_boot_releases_the_data_folder() {
    let dir = std::env::temp_dir().join(format!("ls-boot-cancel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mock = MockSyncBackend::new(MockSyncBackendOptions {
        start_connected: false,
        ..Default::default()
    });
    let boot = |initial_sync| {
        Leader::builder(fixture_schema())
            .storage(Storage::Folder(dir.clone()))
            .sync(SyncOptions {
                backend: Some(stalled_pulls(&mock)),
                initial_sync,
                ..Default::default()
            })
            .boot()
    };

    let stalled = boot(InitialSyncOptions::Blocking {
        timeout: Duration::from_secs(60),
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), stalled)
            .await
            .is_err()
    );

    let mut reopened = Err(String::new());
    for _ in 0..100 {
        reopened = boot(InitialSyncOptions::Skip)
            .await
            .map(drop)
            .map_err(|e| e.to_string());
        if reopened.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(reopened, Ok(()));
}

fn stalled_pulls(mock: &MockSyncBackend) -> SyncBackendConstructor {
    let mock = mock.clone();
    constructor(move |_| {
        let mock = mock.clone();
        async move {
            let backend = BackendOverride::new(mock.make_sync_backend().await)
                .pull(|_, _, _| stream::pending().boxed());
            Ok(Arc::new(backend) as Arc<dyn SyncBackend>)
        }
    })
}

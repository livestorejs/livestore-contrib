//! Port of `tests/sync-provider/src/providers/registry.ts`: the providers the sync-provider suite runs.

use livestore_sync::SyncBackendConstructor;
use livestore_sync_cf::http::{HttpSyncOptions, make_http_sync};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;

pub struct Provider {
    pub key: &'static str,
    pub name: &'static str,
    pub make: fn(&str) -> SyncBackendConstructor,
}

/// Both run against the DO-SQLite worker started by `scripts/test-live.sh`.
pub const PROVIDERS: &[Provider] = &[
    Provider {
        key: "cf-http-do",
        name: "Cloudflare HTTP RPC (DO)",
        make: http,
    },
    Provider {
        key: "cf-ws-do",
        name: "Cloudflare WebSocket (DO)",
        make: ws,
    },
];

pub const PROVIDER_SELECTION_ENV_VAR: &str = "TEST_SYNC_PROVIDER";

pub fn provider_keys() -> Vec<&'static str> {
    PROVIDERS.iter().map(|p| p.key).collect()
}

/// `selectedProviderKeys` for a given `TEST_SYNC_PROVIDER` value.
pub fn selected_provider_keys_for(selected: Option<&str>) -> Result<Vec<&'static str>, String> {
    match selected {
        None | Some("") => Ok(provider_keys()),
        Some(key) => match PROVIDERS.iter().find(|p| p.key == key) {
            Some(p) => Ok(vec![p.key]),
            None => Err(format!(
                "Unknown {PROVIDER_SELECTION_ENV_VAR}={key:?}. Expected one of: {}",
                provider_keys().join(", ")
            )),
        },
    }
}

pub fn selected_providers() -> Vec<&'static Provider> {
    let env = std::env::var(PROVIDER_SELECTION_ENV_VAR).ok();
    let keys = selected_provider_keys_for(env.as_deref()).unwrap();
    PROVIDERS.iter().filter(|p| keys.contains(&p.key)).collect()
}

pub fn is_provider_selected_for(selected: Option<&str>, key: &str) -> bool {
    selected_provider_keys_for(selected).unwrap().contains(&key)
}

pub fn is_provider_selected(key: &str) -> bool {
    is_provider_selected_for(
        std::env::var(PROVIDER_SELECTION_ENV_VAR).ok().as_deref(),
        key,
    )
}

fn ws(url: &str) -> SyncBackendConstructor {
    make_ws_sync(url, ClientOptions::default())
}

/// TS polls every 200 ms in tests.
fn http(url: &str) -> SyncBackendConstructor {
    make_http_sync(
        &super::http_base(url),
        HttpSyncOptions {
            poll_interval: std::time::Duration::from_millis(200),
            ..Default::default()
        },
    )
}

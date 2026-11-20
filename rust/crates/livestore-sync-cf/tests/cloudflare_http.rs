//! Port of `tests/sync-provider/src/cloudflare-http-specific.test.ts` (HTTP transport against wrangler).

mod common;

use common::providers::is_provider_selected;
use common::*;
use livestore_sync::testing::{ClientIdentity, EventFactory};
use livestore_sync_cf::http::{HttpSyncOptions, PING_TAG, make_http_sync};
use serde_json::json;

#[tokio::test]
async fn http_responses_include_custom_headers() {
    let Some(url) = backend().await else { return };
    if !is_provider_selected("cf-http-do") {
        return;
    }
    let store_id = unique("test-store-http-headers");
    let backend = make_backend(
        &make_http_sync(&http_base(&url), HttpSyncOptions::default()),
        &store_id,
        None,
    )
    .await;
    assert_eq!(backend.metadata().extra["protocol"], "http");

    // A correctly framed Ping, routed to the store's DO the same way the HTTP client does.
    let response = reqwest::Client::new()
        .post(format!("{}/?storeId={store_id}&transport=http", http_base(&url)))
        .header("x-livestore-store-id", &store_id)
        .json(&json!({"_tag": "Request", "id": "0", "tag": PING_TAG, "payload": {"storeId": store_id}, "headers": []}))
        .send()
        .await
        .unwrap();
    let headers = response.headers().clone();
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body[0]["exit"]["_tag"], "Success");
    assert_eq!(headers["x-custom-header"], "test-value");
    assert_eq!(headers["x-livestore-version"], "1.0.0");
}

#[tokio::test]
async fn http_push_threads_the_client_payload_through_to_on_push() {
    let Some(url) = backend().await else { return };
    if !is_provider_selected("cf-http-do") {
        return;
    }
    let store_id = unique("test-store-http-payload");
    let sync_payload = json!("issue-1417-http-payload");
    let backend = make_backend(
        &make_http_sync(&http_base(&url), HttpSyncOptions::default()),
        &store_id,
        Some(sync_payload.clone()),
    )
    .await;
    backend.connect().await.unwrap();
    let mut f = EventFactory::new(ClientIdentity::with_session("test-client", "test-session"));
    backend
        .push(vec![f.next(
            "todoCreated",
            json!({"id": "e1", "text": "issue-1417", "completed": false}),
        )])
        .await
        .unwrap();

    let probe = get_json(&format!(
        "{}/instance/push-probe?storeId={store_id}",
        http_base(&url)
    ))
    .await;
    assert_eq!(probe["observed"], true);
    assert_eq!(probe["payload"], sync_payload);
}

//! Port of `tests/sync-provider/src/do-hibernation.test.ts`: client-visible behaviour across sync DO
//! hibernation (workerd evicts an idle DO after ~10 s). Run via `scripts/test-live.sh`.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::providers::is_provider_selected;
use common::*;
use futures::{SinkExt, StreamExt};
use livestore_sqlite::LocalLeader;
use livestore_sync::testing::{ClientIdentity, EventFactory};
use livestore_sync::{PullOptions, SyncBackend};
use livestore_sync_cf::make_ws_sync;
use livestore_sync_cf::transport::ClientOptions;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

const IDLE_WINDOW: Duration = Duration::from_secs(20);

async fn setup() -> Option<String> {
    let url = backend().await?;
    is_provider_selected("cf-ws-do").then_some(url)
}

#[tokio::test]
async fn an_idle_ws_client_lets_the_do_hibernate_and_a_warm_do_stays_resident() {
    let Some(url) = setup().await else { return };
    let observed = tokio::join!(
        hibernates_when_idle(&url, false),
        hibernates_when_idle(&url, true),
        stays_resident_while_warm(&url)
    );
    assert_eq!(
        observed,
        (true, true, false),
        "(idle, livePull, warmControl)"
    );
}

#[tokio::test]
async fn live_pulls_receive_one_valid_interrupted_exit_before_and_after_reconstruction() {
    let Some(url) = setup().await else { return };
    let store_id = unique("hibernation-interrupt");
    let mut ws = open_websocket(&url, &store_id).await;

    start_live_pull(&mut ws, &store_id, "warm-pull").await;
    let exits = send_and_collect(
        &mut ws,
        json!({"_tag": "Interrupt", "requestId": "warm-pull"}),
        is_exit("warm-pull"),
    )
    .await;
    assert_single_interrupted_exit(&exits, "warm-pull");

    start_live_pull(&mut ws, &store_id, "restored-pull").await;
    let before = probe_with_open_socket(&url, &store_id).await;
    sleep(IDLE_WINDOW).await;
    let after = probe_with_open_socket(&url, &store_id).await;
    assert_ne!(after, before);

    start_live_pull(&mut ws, &store_id, "current-pull").await;
    let exits = send_and_collect(
        &mut ws,
        json!({"_tag": "Interrupt", "requestId": "current-pull"}),
        is_exit("current-pull"),
    )
    .await;
    assert_single_interrupted_exit(&exits, "current-pull");

    assert_eq!(
        probe(&url, &store_id).await["pullRequestIds"],
        json!(["restored-pull"])
    );

    let exits = send_and_collect(
        &mut ws,
        json!({"_tag": "Interrupt", "requestId": "restored-pull"}),
        is_exit("restored-pull"),
    )
    .await;
    assert_single_interrupted_exit(&exits, "restored-pull");

    assert_eq!(probe(&url, &store_id).await["pullRequestIds"], json!([]));
}

#[tokio::test]
async fn terminal_pull_exits_remove_persisted_fan_out_request_ids() {
    let Some(url) = setup().await else { return };
    let store_id = unique("pull-exit-cleanup");
    let mut ws = open_websocket(&url, &store_id).await;

    run_pull_to_exit(
        &mut ws,
        &store_id,
        "completed-pull",
        false,
        json!({"_tag": "None"}),
    )
    .await;
    run_pull_to_exit(
        &mut ws,
        &store_id,
        "failed-pull",
        true,
        json!({"_tag": "Some", "value": {"backendId": "stale-backend", "eventSequenceNumber": 0}}),
    )
    .await;

    assert_eq!(probe(&url, &store_id).await["pullRequestIds"], json!([]));
}

#[tokio::test]
async fn protocol_defects_clear_restored_fan_out_request_ids() {
    let Some(url) = setup().await else { return };
    let store_id = unique("pull-defect-cleanup");
    let mut ws = open_websocket(&url, &store_id).await;
    start_live_pull(&mut ws, &store_id, "restored-pull").await;

    let before = probe_with_open_socket(&url, &store_id).await;
    sleep(IDLE_WINDOW).await;
    let after = probe_with_open_socket(&url, &store_id).await;
    assert_ne!(after, before);

    assert_eq!(
        probe(&url, &store_id).await["pullRequestIds"],
        json!(["restored-pull"])
    );

    send_and_wait(&mut ws, "{".into(), |m| m["_tag"] == "Defect", |_| None).await;

    assert_eq!(probe(&url, &store_id).await["pullRequestIds"], json!([]));
}

#[tokio::test]
async fn shutting_down_a_live_pull_store_drops_its_subscription_on_the_server() {
    let Some(url) = setup().await else { return };
    let store_id = unique("ws-unsubscribe");
    let store = start(
        LocalLeader::open_in_memory(
            livestore_todomvc::schema(),
            "unsubscribe",
            "unsubscribe-session",
        )
        .unwrap()
        .into_db(),
        "unsubscribe",
        options(&url, &store_id),
    )
    .await;
    assert_eq!(await_pull_count(&url, &store_id, 1).await, 1);
    store.shutdown().await;
    assert_eq!(await_pull_count(&url, &store_id, 0).await, 0);
}

#[tokio::test]
async fn server_keeps_fanning_out_to_a_live_subscriber_after_the_backend_is_reconstructed() {
    let Some(url) = setup().await else { return };
    let store_id = unique("server-reconstruction");
    let ctor = make_ws_sync(&url, ClientOptions::default());
    let subscriber = make_backend(&ctor, &store_id, None).await;
    let writer = make_backend(&ctor, &store_id, None).await;
    let mut f = EventFactory::new(ClientIdentity::with_session(
        "sync-writer",
        "sync-writer-session",
    ));
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let collector = collect_received_ids(subscriber.clone(), received.clone());

    sleep(Duration::from_secs(1)).await;
    writer
        .push(vec![f.next(
            "todoCreated",
            json!({"id": "before-evict", "text": "before", "completed": false}),
        )])
        .await
        .unwrap();
    await_delivery(&received, "before-evict").await;

    let before = probe_with_open_socket(&url, &store_id).await;
    let mut after = before.clone();
    for _ in 0..3 {
        sleep(Duration::from_secs(14)).await;
        after = probe_with_open_socket(&url, &store_id).await;
        if after != before {
            break;
        }
    }
    assert_ne!(
        after, before,
        "backend never reconstructed within the idle windows"
    );

    writer
        .push(vec![f.next(
            "todoCreated",
            json!({"id": "after-evict", "text": "after", "completed": false}),
        )])
        .await
        .unwrap();
    await_delivery(&received, "after-evict").await;
    collector.abort();
}

async fn hibernates_when_idle(url: &str, live_pull: bool) -> bool {
    let store_id = unique(if live_pull {
        "hibernation-live-pull"
    } else {
        "hibernation-idle"
    });
    let backend = make_backend(
        &make_ws_sync(url, ClientOptions::default()),
        &store_id,
        None,
    )
    .await;
    let mut f = EventFactory::new(ClientIdentity::with_session(
        "hibernation-client",
        "hibernation-session",
    ));
    backend.connect().await.unwrap();

    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let collector = live_pull.then(|| collect_received_ids(backend.clone(), received.clone()));
    if live_pull {
        // A dead pull leaves no park, so "it hibernated" would pass for the wrong reason.
        sleep(Duration::from_secs(1)).await;
        backend
            .push(vec![f.next(
                "todoCreated",
                json!({"id": "before-idle", "text": "before", "completed": false}),
            )])
            .await
            .unwrap();
        await_delivery(&received, "before-idle").await;
    }

    let before = probe_with_open_socket(url, &store_id).await;
    sleep(IDLE_WINDOW).await;
    let after = probe_with_open_socket(url, &store_id).await;

    if live_pull {
        backend
            .push(vec![f.next(
                "todoCreated",
                json!({"id": "after-idle", "text": "after", "completed": false}),
            )])
            .await
            .unwrap();
        await_delivery(&received, "after-idle").await;
    }
    if let Some(c) = collector {
        c.abort();
    }
    before != after
}

async fn stays_resident_while_warm(url: &str) -> bool {
    let store_id = unique("hibernation-warm");
    let before = probe(url, &store_id).await;
    let deadline = Instant::now() + IDLE_WINDOW;
    while Instant::now() + Duration::from_secs(3) < deadline {
        sleep(Duration::from_secs(3)).await;
        probe(url, &store_id).await;
    }
    sleep(deadline - Instant::now()).await;
    let after = probe(url, &store_id).await;
    before["instanceId"] != after["instanceId"]
}

fn collect_received_ids(
    backend: Arc<dyn SyncBackend>,
    received: Arc<Mutex<Vec<String>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut pull = backend.pull(None, PullOptions { live: true });
        while let Some(res) = pull.next().await {
            let res = res.expect("live pull failed");
            received.lock().unwrap().extend(
                res.batch
                    .iter()
                    .map(|i| i.event_encoded.args["id"].as_str().unwrap().to_owned()),
            );
        }
    })
}

async fn await_delivery(received: &Mutex<Vec<String>>, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !received.lock().unwrap().iter().any(|r| r == id) {
        assert!(
            Instant::now() < deadline,
            "live subscriber never received {id:?} within 10s"
        );
        sleep(Duration::from_millis(300)).await;
    }
}

/// Polls until the server holds `expected` live pull subscriptions; returns the last count seen.
async fn await_pull_count(url: &str, store_id: &str, expected: usize) -> usize {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let count = probe(url, store_id).await["pullRequestIds"]
            .as_array()
            .map_or(0, Vec::len);
        if count == expected || Instant::now() > deadline {
            return count;
        }
        sleep(Duration::from_millis(300)).await;
    }
}

/// `GET /instance/sync`: a changed `instanceId` means the DO was evicted and rebuilt.
async fn probe(url: &str, store_id: &str) -> Value {
    get_json(&format!(
        "{}/instance/sync?storeId={store_id}",
        http_base(url)
    ))
    .await
}

async fn probe_with_open_socket(url: &str, store_id: &str) -> Value {
    let p = probe(url, store_id).await;
    assert_ne!(
        p["webSocketCount"], 0,
        "no websocket attached to {store_id}; hibernation claim would be vacuous"
    );
    p["instanceId"].clone()
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn open_websocket(url: &str, store_id: &str) -> Ws {
    tokio_tungstenite::connect_async(format!("{url}/?storeId={store_id}&transport=ws"))
        .await
        .expect("WebSocket failed to open")
        .0
}

fn is_exit(id: &'static str) -> impl Fn(&Value) -> bool {
    move |m| m["_tag"] == "Exit" && m["requestId"] == id
}

async fn next_message(ws: &mut Ws) -> Value {
    loop {
        match ws
            .next()
            .await
            .expect("WebSocket closed before the expected RPC message")
            .unwrap()
        {
            Message::Text(t) => {
                return serde_json::from_str(t.as_str()).expect("invalid RPC response");
            }
            Message::Close(_) => panic!("WebSocket closed before the expected RPC message"),
            _ => {}
        }
    }
}

/// Sends `outgoing`, answers each message with `on_message` (if it returns a frame), until `matches`.
async fn send_and_wait(
    ws: &mut Ws,
    outgoing: String,
    matches: impl Fn(&Value) -> bool,
    on_message: impl Fn(&Value) -> Option<Value>,
) -> Value {
    ws.send(Message::text(outgoing)).await.unwrap();
    timeout(Duration::from_secs(5), async {
        loop {
            let m = next_message(ws).await;
            if let Some(reply) = on_message(&m) {
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
            if matches(&m) {
                return m;
            }
        }
    })
    .await
    .expect("timed out waiting for RPC message")
}

async fn send_and_collect(
    ws: &mut Ws,
    outgoing: Value,
    matches: impl Fn(&Value) -> bool,
) -> Vec<Value> {
    ws.send(Message::text(outgoing.to_string())).await.unwrap();
    let mut messages = vec![];
    let deadline = Instant::now() + Duration::from_millis(500);
    while let Ok(m) = timeout(deadline - Instant::now(), next_message(ws)).await {
        if matches(&m) {
            messages.push(m);
        }
    }
    messages
}

fn pull_request(store_id: &str, id: &str, live: bool, cursor: Value) -> String {
    json!({"_tag": "Request", "id": id, "tag": "SyncWsRpc.Pull", "payload": {"storeId": store_id, "live": live, "cursor": cursor}, "headers": []}).to_string()
}

async fn start_live_pull(ws: &mut Ws, store_id: &str, id: &str) {
    send_and_wait(
        ws,
        pull_request(store_id, id, true, json!({"_tag": "None"})),
        |m| m["_tag"] == "Chunk" && m["requestId"] == id,
        |_| None,
    )
    .await;
    ws.send(Message::text(
        json!({"_tag": "Ack", "requestId": id}).to_string(),
    ))
    .await
    .unwrap();
}

async fn run_pull_to_exit(
    ws: &mut Ws,
    store_id: &str,
    id: &str,
    live: bool,
    cursor: Value,
) -> Value {
    send_and_wait(
        ws,
        pull_request(store_id, id, live, cursor),
        |m| m["_tag"] == "Exit" && m["requestId"] == id,
        |m| {
            (m["_tag"] == "Chunk" && m["requestId"] == id)
                .then(|| json!({"_tag": "Ack", "requestId": id}))
        },
    )
    .await
}

fn assert_single_interrupted_exit(messages: &[Value], id: &str) {
    assert_eq!(messages.len(), 1, "{messages:?}");
    let m = &messages[0];
    assert_eq!((&m["_tag"], &m["requestId"]), (&json!("Exit"), &json!(id)));
    let exit = &m["exit"];
    assert_eq!(exit["_tag"], "Failure", "{exit}");
    let cause = exit["cause"].as_array().expect("Exit.cause is an array");
    assert!(cause.iter().all(|r| ["Fail", "Die", "Interrupt"].contains(&r["_tag"].as_str().unwrap_or_default())), "{exit}");
    assert!(
        cause.iter().any(|r| r["_tag"] == "Interrupt"),
        "Exit.hasInterrupts: {exit}"
    );
}

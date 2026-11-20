//! Cross-language: a real TypeScript LiveStore client (`scripts/ts-todo-client.ts`, in-memory adapter + sync-cf)
//! and the Rust client commit on the same store; both must end with identical `todos` rows.
//! Run via `scripts/test-live.sh` (needs `bun`); skips when no backend is reachable.

mod common;

use std::process::Stdio;
use std::time::Duration;

use common::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[tokio::test]
async fn typescript_and_rust_clients_converge() {
    let Some(url) = backend().await else { return };
    let store_id = unique("rust-ts-e2e");
    let rust = start(
        open(&temp_dir("e2e"), "rust-client").into_db(),
        "rust-client",
        options(&url, &store_id),
    )
    .await;
    rust.commit("v1.TodoCreated", json!({"id": "r1", "text": "from rust 1"}))
        .await
        .unwrap();
    rust.commit("v1.TodoCreated", json!({"id": "r2", "text": "from rust 2"}))
        .await
        .unwrap();
    assert!(rust.wait_synced(T).await);

    let mut ts = TsClient::spawn(&url, &store_id).await;
    ts.call("commit v1.TodoCreated {\"id\":\"ts1\",\"text\":\"from typescript\"}")
        .await;
    ts.call("commit v1.TodoCompleted {\"id\":\"r1\"}").await;
    rust.commit("v1.TodoCreated", json!({"id": "r3", "text": "from rust 3"}))
        .await
        .unwrap();
    rust.commit("v1.TodoCompleted", json!({"id": "r2"}))
        .await
        .unwrap();
    ts.call("commit v1.TodoDeleted {\"id\":\"r2\",\"deletedAt\":\"2026-05-06T07:08:09.010Z\"}")
        .await;
    rust.commit(
        "v1.TodoClearedCompleted",
        json!({"deletedAt": "2026-05-06T07:08:10.000Z"}),
    )
    .await
    .unwrap();

    let deadline = tokio::time::Instant::now() + T;
    let (ts_rows, rust_rows) = loop {
        let reply = ts.call("rows").await;
        let ts_rows: Vec<Value> = reply["rows"].as_array().unwrap().clone();
        let rust_rows: Vec<Value> = rust
            .query(ALL_TODOS)
            .unwrap()
            .into_iter()
            .map(Value::Object)
            .collect();
        let settled = reply["status"]["isSynced"] == true && rust.info().pending == 0;
        if settled && ts_rows.len() == 4 && ts_rows == rust_rows {
            break (ts_rows, rust_rows);
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no convergence\nts:   {ts_rows:?}\nrust: {rust_rows:?}\n{:?}",
            rust.info()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(ts_rows, rust_rows);
    let ids: Vec<&str> = ts_rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["r1", "r2", "r3", "ts1"]);
    assert!(
        ts_rows
            .iter()
            .all(|r| r["id"] != "r2" || !r["deletedAt"].is_null())
    );
    ts.quit().await;
}

struct TsClient {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl TsClient {
    async fn spawn(url: &str, store_id: &str) -> TsClient {
        let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".into());
        let mut child = Command::new(bun)
            .args(["scripts/ts-todo-client.ts", url, store_id])
            .current_dir(ROOT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("bun must be on PATH (or set BUN)");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut client = TsClient {
            child,
            stdin,
            stdout,
        };
        assert_eq!(client.read().await, json!({"ready": true}));
        client
    }

    async fn call(&mut self, line: &str) -> Value {
        self.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        let reply = self.read().await;
        assert!(reply.get("error").is_none(), "{line}: {reply}");
        reply
    }

    async fn read(&mut self) -> Value {
        let line = tokio::time::timeout(T, self.stdout.next_line())
            .await
            .expect("ts client timed out")
            .unwrap();
        serde_json::from_str(&line.expect("ts client exited")).unwrap()
    }

    async fn quit(mut self) {
        let _ = self.stdin.write_all(b"quit\n").await;
        let _ = tokio::time::timeout(T, self.child.wait()).await;
    }
}

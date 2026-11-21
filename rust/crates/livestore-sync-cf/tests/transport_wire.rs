use livestore_sync_cf::transport::*;
use serde_json::Value;

fn frames() -> Vec<(String, String, String)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/wire");
    let mut out = vec![];
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let entries: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for e in entries {
            if let Some(raw) = e["raw"].as_str() {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                out.push((name, e["dir"].as_str().unwrap().to_owned(), raw.to_owned()));
            }
        }
    }
    assert!(out.len() > 50);
    out
}

fn roundtrip<T: serde::de::DeserializeOwned + serde::Serialize>(v: &Value) -> Value {
    let t: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("decode {v}: {e}"));
    serde_json::to_value(t).unwrap()
}

#[test]
fn every_captured_frame_roundtrips() {
    let (mut requests, mut chunks) = (0, 0);
    for (file, dir, raw) in frames() {
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            assert_eq!(raw, "not json", "{file}");
            continue;
        };
        if dir == "client->server" {
            assert_eq!(roundtrip::<ClientMessage>(&json), json, "{file}");
            if let ClientMessage::Request(r) = serde_json::from_value(json.clone()).unwrap() {
                let typed = match r.tag.as_str() {
                    PULL_TAG => serde_json::from_value::<PullRequest>(r.payload.clone())
                        .ok()
                        .map(|_| roundtrip::<PullRequest>(&r.payload)),
                    PUSH_TAG => Some(roundtrip::<PushRequest>(&r.payload)),
                    _ => None,
                };
                if let Some(typed) = typed {
                    assert_eq!(typed, r.payload, "{file}");
                    requests += 1;
                }
            }
            if json["_tag"] == "Ping" {
                assert_eq!(raw, PING_FRAME);
            }
        } else {
            assert_eq!(dir, "server->client");
            assert_eq!(roundtrip::<ServerMessage>(&json), json, "{file}");
            if let ServerMessage::Chunk { values, .. } = serde_json::from_value(json).unwrap() {
                for v in values {
                    assert_eq!(roundtrip::<PullResponse>(&v), v, "{file}");
                    chunks += 1;
                }
            }
        }
    }
    assert!(requests > 15 && chunks > 8, "{requests} {chunks}");
}

#[test]
fn typed_errors_decode() {
    let all: Vec<ServerMessage> = frames()
        .into_iter()
        .filter(|(_, d, _)| d == "server->client")
        .map(|(_, _, raw)| serde_json::from_str(&raw).unwrap())
        .collect();
    let errors: Vec<&BackendError> = all
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Exit {
                exit: Exit::Failure { cause },
                ..
            } => Some(cause),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match c {
            CauseReason::Fail { error } => Some(error),
            _ => None,
        })
        .collect();
    assert!(errors.contains(&&BackendError::ServerAheadError {
        minimum_expected_num: 251,
        provided_num: 4
    }));
    assert!(errors.iter().any(|e| matches!(e, BackendError::BackendIdMismatchError { received, .. } if received == "wrong-backend-id")));
    assert!(
        all.iter()
            .any(|m| matches!(m, ServerMessage::Defect { .. }))
    );
    assert!(all.iter().any(
        |m| matches!(m, ServerMessage::Exit { request_id: RequestId::Str(s), .. } if s == "live-1")
    ));
}

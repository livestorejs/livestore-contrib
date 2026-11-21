//! Port of `packages/@livestore/sync-cf/src/client/transport/rpc-client-error.test.ts`.

use livestore_sync::{IsOfflineError, PullError, UnknownError};
use livestore_sync_cf::map_rpc_client_error;
use livestore_sync_cf::transport::{HttpErrorKind, SocketError, SocketErrorKind, SyncError};

fn assert_offline(kind: SocketErrorKind, message: &str) {
    let reason = SocketError {
        kind,
        message: message.into(),
    };
    let result: PullError = map_rpc_client_error(SyncError::Socket(reason.clone()));
    assert_eq!(
        result,
        PullError::IsOffline(IsOfflineError {
            cause: reason.to_string()
        })
    );
}

#[test]
fn maps_socket_close_error_to_offline() {
    assert_offline(SocketErrorKind::Close { code: 1012 }, "Restart");
}

#[test]
fn maps_socket_read_error_to_offline() {
    assert_offline(SocketErrorKind::Read, "Disconnected");
}

#[test]
fn maps_socket_write_error_to_offline() {
    assert_offline(SocketErrorKind::Write, "Disconnected");
}

#[test]
fn maps_socket_open_error_to_offline() {
    assert_offline(SocketErrorKind::Open, "Unavailable");
}

#[test]
fn maps_socket_upgrade_error_to_offline() {
    assert_offline(SocketErrorKind::Upgrade, "Upgrade failed");
}

#[test]
fn maps_an_http_transport_failure_to_offline() {
    let result: PullError = map_rpc_client_error(SyncError::Http {
        kind: HttpErrorKind::Transport,
        message: "connection refused".into(),
    });
    assert_eq!(
        result,
        PullError::IsOffline(IsOfflineError {
            cause: "connection refused".into()
        })
    );
}

fn assert_terminal(error: SyncError) {
    let result: PullError = map_rpc_client_error(error.clone());
    assert_eq!(result, PullError::Unknown(UnknownError::new(error)));
}

#[test]
fn keeps_protocol_failure_rpc_client_defect_terminal() {
    assert_terminal(SyncError::Protocol("Malformed RPC response".into()));
}

#[test]
fn keeps_protocol_failure_http_error_terminal() {
    for kind in [
        HttpErrorKind::Encode,
        HttpErrorKind::Decode,
        HttpErrorKind::InvalidUrl,
        HttpErrorKind::StatusCode,
        HttpErrorKind::EmptyBody,
    ] {
        assert_terminal(SyncError::Http {
            kind,
            message: format!("{kind:?}"),
        });
    }
}

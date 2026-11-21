# Rust Client sync-cf — Requirements

Role: the client side of the Cloudflare sync provider.

## Context

Realizes the client half of core [`03-sync/03-cf/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/03-sync/03-cf)
(`LS.SYS.SYNC.CF-*`) in `rust/crates/livestore-sync-cf`. Parent:
[../requirements.md](../requirements.md). Wire reference:
[`contributor-docs/rust/sync-cf-wire-protocol.md`](../../../../contributor-docs/rust/sync-cf-wire-protocol.md).

## Requirements

- **LSC.CLIENT.RUST.CF-R01 Same wire messages:** Requests and responses use the
  sync-cf Effect RPC JSON schema; real captures in `rust/fixtures/wire/` decode
  and re-encode unchanged. `refines: LS.SYS.SYNC.CF-R01, LS.SYS.SYNC.CF-R03`
- **LSC.CLIENT.RUST.CF-R02 WebSocket and HTTP only:** The client realizes the
  WebSocket transport (`make_ws_sync`) and the HTTP transport
  (`http::make_http_sync`); the DO-RPC transport is not realized, since it only
  applies inside Cloudflare. `refines: LS.SYS.SYNC.CF-R02`
- **LSC.CLIENT.RUST.CF-R03 Same liveness:** Ping/pong keepalive, reconnect, and
  error mapping follow `mapRpcClientError`: transport loss is offline, everything
  else is terminal. `refines: LS.SYS.SYNC.CF-R05, LS.SYS.SYNC-R03`

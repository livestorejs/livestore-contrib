# CLI and Control-Surface Reuse Audit

Captured: 2026-08-23.

| Reuse candidate | Adopt | Boundary |
| --- | --- | --- |
| `@effect/cli` and existing contrib Effect CLI example | Yes | Argument parsing, help, command composition |
| `@effect/rpc` plus Effect Schema/tagged errors | Yes | One versioned Bot control contract and shared machine output |
| DFX generated REST and interaction services | Yes, runtime-side | Never expose generic Discord REST as administrative RPC |
| Retired `discord-agent` daemon/CLI pattern | Concepts only | Reuse typed daemon/client and output-mode ideas, not raw REST RPC or CLI-side policy |
| Private TUI renderer packages | No initial dependency | Keep contrib app standalone; extract only after a second consumer |
| LiveStore as action journal | No initial authority | SQLite remains critical journal; LiveStore may consume a read-only projection later |

Keep domain modules inside private `apps/discord-bot` initially. Extract a
published package only after a second real consumer establishes a stable reuse
boundary. Upstream Discord protocol corrections to DFX; keep LiveStore-specific
policy, journal, and control operations in contrib.

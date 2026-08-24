# Discord implementation reuse audit

Snapshot date: 2026-08-23.

| Source | Reuse | Do not couple |
| --- | --- | --- |
| `tim-smart/dfx` 1.0.15 | Gateway, generated REST, interactions, UI helpers, rate-limit mechanics | default memory stores as application durability; upstream test coverage |
| `Effect-TS/discord-bot` | DFX layer composition; topic opt-in auto-threads; message filtering; AI fallback; edit/archive controls | private `@chat/*` workspace packages; its Fly deployment; its product policy |
| retired dotfiles `discord-agent` | fake Gateway topology; live E2E correlation/cleanup ideas | agent identity/RPC domain; raw REST; fixed sleeps; private guild IDs |
| `bonsai-discord` | thin domain-port idea only | incomplete Gateway; user-token DM model; custom transport and persistence |
| old LiveStore bot | pure low-value classifier and link-suppression behavior as test inputs | handwritten transport, prompts, lifecycle, hard-coded configuration |

The strongest direct prior art is the active MIT-licensed Effect community
bot's `AutoThreads.ts`: it uses DFX `MESSAGE_CREATE`, a topic opt-in marker,
AI naming with fallback, `createThreadFromMessage`, and interaction controls.
It has no substantive verification suite, so it is design evidence rather than
an acceptance result.

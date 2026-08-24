# LiveStore Discord bot

Private executable application for the LiveStore Discord bot. Its behavior and
acceptance criteria are owned by
[`context/applications/discord-bot`](../../context/applications/discord-bot/).
It is not a published contrib package.

The app deliberately uses an isolated dependency graph because DFX 1.0.15
requires a newer Effect prerelease than the contrib root workspace. Do not add
it to the root generated workspace while that workspace overrides Effect to
beta.98.

The admitted runtime tuple is pinned exactly:

- DFX 1.0.15
- Effect 4.0.0-beta.105
- `@effect/platform-node` and `@effect/platform-node-shared` 4.0.0-beta.105
- `discord-api-types` 0.38.40

The current entrypoint composes runtime configuration, DFX Gateway/REST
adapters, shared workflows, the control RPC, and the operator CLI. The default
mode is a local fake runtime and does not contact Discord; live writes require
the separately gated staging runner and an explicitly injected credential.

Current evidence is deliberately split by boundary: the application suite is
35 files and 198 tests, the source-executable runtime black-box is 1/1, the
same black-box against the Nix-installed executable is 1/1, the credential-free
E2E receipt is 7/40, and the immutable package build passed.
These are local/source or artifact receipts, not live Discord evidence. Live
staging and production remain `UNRUN`.

From the application workspace, run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

A clean frozen install is only meaningful after the application-local lockfile
has been generated and admitted. Never store bot or provider credentials in
this directory; deployment projects them from 1Password.

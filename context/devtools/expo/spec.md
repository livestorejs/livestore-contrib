# Expo Devtools — Spec

Specifies the Expo devtools surface (`packages/@livestore/devtools-expo`) at the
realization-contract level. Builds on [requirements.md](./requirements.md); the
mechanism-agnostic surface contract is core
[`07-devtools/spec.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/spec.md).
Citations are `src/…:line` within the package.

## Status

Draft.

## Shape

The package is glue, not a protocol implementation: ~90 lines of Metro
middleware plus a plugin manifest and a redirect page. The published entry
(`main` → `./dist/index.cjs`) re-exports the Metro config module
(`src/index.cts:3`). The devtools protocol, message schemas, the server, and the
UI are all reused (LSC.DT.EXPO-R02); nothing here is version-gated or
protocol-aware.

## Metro Integration

`addLiveStoreDevtoolsMiddleware(config, options)` is the sole public function
(`src/metro-config.cts:16`, exported `:86`). It mutates the passed Metro config
in place and takes `Options` (`src/types.d.ts:7`): `schemaPath`
(string | array), `port` (default `4242`, `src/metro-config.cts:22`), `host`
(default `0.0.0.0`, `:21`), and an optional `viteConfig` transform.

It is development-only: the whole function returns early when
`process.env.CI !== undefined` or `process.stdout.isTTY === false`
(`src/metro-config.cts:18`) (LSC.DT.EXPO-R01).

## Server Reuse

The endpoint is the Node adapter's devtools server, dynamically imported and run:
`import('@livestore/adapter-node/devtools')` → `startDevtoolsServer({ ... })`
(`src/metro-config.cts:27`, `:34`). It is invoked with
`clientSessionInfo: undefined` (`src/metro-config.cts:35`) — a protocol host with
no privileged in-process session (LSC.DT.EXPO-R02, core LS.SYS.DT-R01) — plus
`schemaPath`, `host`, `port`. The server is provided a Node HTTP-client layer and
a pretty logger and started with `Effect.runPromise` (`:39`–`:44`); errors are
logged and swallowed (`.catch`, `:46`) — see LSC.DT.EXPO-DQ1. That server owns
the HTTP + WebSocket Webmesh edge and the Vite-served UI (core
`07-devtools`; Node adapter [devtools](../../adapters/node/spec.md#devtools));
`@livestore/devtools-vite` is a peer dependency (`package.json:51`).

## Client Endpoint Advertisement

Before booting the server the middleware sets
`process.env.EXPO_PUBLIC_LIVESTORE_DEVTOOLS_URL = ws://${host}:${port}`
(`src/metro-config.cts:25`), commented "Needed for @livestore/adapter-expo"
(`:24`). The RN client adapter reads this env var to open the outbound webmesh
`proxy` channel to the server (LSC.DT.EXPO-R03). The channel itself — mode
`proxy`, the hop-routed out-of-process path (core spec §Channel modes) — is
opened by the sibling [`context/adapters/expo/`](../../adapters/expo) node, not
here.

## Request Redirection

The middleware wraps the existing `enhanceMiddleware`
(`src/metro-config.cts:50`, `:68`). Any request whose URL starts with
`/_livestore` is `302`-redirected to
`http://${maybeLocalhost}:${port}/_livestore/${rest}` (`src/metro-config.cts:56`,
`:63`–`:65`); all other requests fall through to the prior middleware
(`:71`–`:74`) (LSC.DT.EXPO-R04). The redirect host rewrites `0.0.0.0` →
`localhost` (`src/metro-config.cts:62`) to avoid the web adapter's
`navigator.locks` limitation (source comment, `:61`) — see LSC.DT.EXPO-DQ2.

## Expo Plugin Surface

`expo-module.config.json` registers the package as an Expo devtools plugin:
`platforms: ["devtools"]`, `devtools.webpageRoot: "webui"`
(`expo-module.config.json:2`–`:5`). The menu entry loads `webui/index.html`,
whose inline script redirects the browser to
`http://localhost:${currentUrl.port}/_livestore/node?autoconnect`
(`webui/index.html:9`) (LSC.DT.EXPO-R05). `port` is taken from the page's own
URL, and the host is again pinned to `localhost`.

## Distribution Class: Pinned

This surface is **pinned**: its running version is determined mechanically by the
app's dependency resolution (npm + lockfile). It therefore ships in lockstep with
core and takes on **no** protocol-version tolerance — no accepted-version window,
no negotiation, no capability degradation.

The distinction is the *install path*, not the topology. Expo devtools is
out-of-process, frequently on another device, and reaches the app over a
hop-routed webmesh `proxy` channel — and is still pinned, because a LiveStore
release changes which build the developer runs without any action outside
dependency install. Only an **unpinned** surface (one installed and updated
independently of the app, e.g. a browser extension) needs negotiated
compatibility.

Recorded explicitly so that tolerance is not added here by analogy with the
browser extension.

## Not Owned Here

Everything the protocol contract covers — message schemas, versioning/handshake,
subscription lifecycle, session discovery, control operations, at-least-once
dedup — is core `07-devtools` and is exercised through the reused server and the
sibling client adapter. This node adds no protocol behavior, so no core devtools
requirement is left unmet by it; there is no `.delta`.

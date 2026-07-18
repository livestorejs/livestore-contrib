# Expo Devtools — Requirements

Role: the Expo/React Native realization of LiveStore's devtools **surface** —
build-time glue that stands up a devtools endpoint alongside the Metro dev
server and exposes it through Expo's devtools plugin menu, so an RN app running
on a device or simulator can be inspected with the standard LiveStore devtools
UI.

## Context

Refines the core devtools surface contract
([`02-system/07-devtools/`](https://github.com/livestorejs/livestore/tree/main/context/02-system/07-devtools),
`LS.SYS.DT-*`). Package:
[`packages/@livestore/devtools-expo`](../../../packages/@livestore/devtools-expo).

This node owns only the **server/tooling half** of the Expo surface: it reuses
the core protocol, the Node adapter's devtools server, and the shared devtools
UI — it defines none of them. The **client half** — the RN app's outbound
webmesh `proxy` connection — is realized by the sibling adapter node
([`context/adapters/expo/`](../../adapters/expo)) via `@livestore/adapter-expo`,
which is why this package contains no protocol or channel code. The core
Surfaces contract enumerates the Expo transport as "webmesh `proxy`"
([spec §Channel modes / §Surfaces](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/spec.md)).

Conformance status lives in the core registry
([`07-devtools/realizations.md`](https://github.com/livestorejs/livestore/blob/main/context/02-system/07-devtools/realizations.md)):
the Expo surface is **not covered by the devtools protocol compat test** today.

## Requirements

- **LSC.DT.EXPO-R01 Build-time Metro integration point (dev only):** The surface
  is installed by patching the Metro config: `addLiveStoreDevtoolsMiddleware`
  wraps `config.server.enhanceMiddleware`, the sole entry point. It is a
  development-only surface — the patch is a no-op when `process.env.CI` is set or
  stdout is not a TTY, so no devtools endpoint is stood up in CI or headless
  runs. `refines: LS.SYS.DT-R05`
- **LSC.DT.EXPO-R02 Reused devtools server, no in-process session:** The devtools
  endpoint is not reimplemented — it dynamically imports
  `@livestore/adapter-node/devtools` and runs its `startDevtoolsServer` with
  `clientSessionInfo: undefined`, i.e. a protocol host with no privileged
  in-process session; the RN client attaches as a remote peer over the protocol.
  `refines: LS.SYS.DT-R01, LS.SYS.DT-R05`
- **LSC.DT.EXPO-R03 Client endpoint advertisement:** The surface advertises the
  server's WebSocket URL to the RN client by setting
  `EXPO_PUBLIC_LIVESTORE_DEVTOOLS_URL = ws://{host}:{port}`, which
  `@livestore/adapter-expo` (sibling node) reads to open the core-enumerated
  webmesh `proxy` channel. This node advertises the endpoint; it does not open
  the channel. `refines: LS.SYS.DT-R12, LS.SYS.DT-R05`
- **LSC.DT.EXPO-R04 Dev-server request redirection:** Requests to `/_livestore/*`
  arriving on the Metro dev server are `302`-redirected to the reused devtools
  server (`http://{host}:{port}/_livestore/*`), so the browser UI and the core
  `fetch('/_livestore')` discovery probe reach the server across the Metro/port
  boundary. `refines: LS.SYS.DT-R05`
- **LSC.DT.EXPO-R05 Expo devtools plugin entry point:** The package registers as
  an Expo devtools plugin (`platforms: ["devtools"]`, `webpageRoot: webui`); the
  menu entry opens a redirect page that forwards a browser to the devtools
  server's node surface, giving a developer an in-menu way to open the surface
  without app cooperation. `refines: LS.SYS.DT-R05`

## Open Design Questions

- **LSC.DT.EXPO-DQ1 Unmanaged server lifecycle.** The devtools server is booted
  as a fire-and-forget side effect of the Metro middleware
  (`startDevtoolsServer(...).pipe(Effect.runPromise)` with a bare
  `.catch(console.error)`); it is not tied to Metro's lifecycle and its failure
  does not fail the dev server. Whether Metro should own start/stop of the
  endpoint is uncaptured.
- **LSC.DT.EXPO-DQ2 Host duality.** The server binds `0.0.0.0` (reachable from a
  physical device) but the redirect and the plugin webui rewrite the host to
  `localhost` to dodge the web adapter's `navigator.locks` limitation. Whether
  this host juggling holds across device/simulator/tunnel topologies is open.
- **LSC.DT.EXPO-DQ3 Two schema resolvers.** `schemaPath` is passed straight to
  the reused (Vite-based) server for import, while the app itself is bundled by
  Metro; whether Expo and the devtools UI should share one schema-resolution path
  rather than resolving the same file through two bundlers is unsettled.

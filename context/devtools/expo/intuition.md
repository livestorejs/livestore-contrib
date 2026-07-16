# Expo Devtools — Intuition

*For: contributors to `devtools-expo` · Assumes: the core devtools mental model
(surfaces as protocol peers over webmesh) · Covers: why the Expo surface is glue,
not an implementation*

The mental unlock is that `devtools-expo` implements almost nothing. The devtools
protocol, the server that speaks it, and the UI that renders it already exist —
the Node adapter's devtools server and the shared devtools UI. What was missing
for Expo was not a new devtools; it was a way to *stand up the existing one next
to a Metro dev server and hand a developer a door into it*. That is all this
package is: a Metro config patch, an env var, an HTTP redirect, and a plugin menu
entry.

Follow the wiring and the picture is a triangle. Metro (the dev server) boots a
Node devtools **server** on the side. The RN app, running on a device or
simulator, reaches back to that server over a WebSocket — but it only knows where
to reach because the middleware wrote the URL into
`EXPO_PUBLIC_LIVESTORE_DEVTOOLS_URL` for the Expo client adapter to read. The
developer's browser reaches the same server either by hitting `/_livestore` on
Metro (which 302s across to the server's port) or through the Expo devtools menu
(a redirect page). Three clients, one reused server; this package is only the
wiring between them.

**How this differs from the browser-extension surface.** The browser extension
lives entirely inside one browser: it bridges the page and the extension with
`window.postMessage` and never leaves the process. Expo can't do that — the app
is a separate JS runtime on another device, and there is no browser to host an
extension. So the topology inverts: instead of bridging within a process, you
run a server *outside* the app and have the app dial out to it over a hop-routed
webmesh `proxy` channel (mode `proxy` vs. the extension's `direct`). That
out-of-process reach is exactly why the surface is split across two packages —
this one advertises and hosts the endpoint, `adapter-expo` opens the client
channel to it.

The trap to avoid: reading this package expecting to find the "Expo devtools" and
finding no protocol code, then concluding it's incomplete. It isn't — the surface
is deliberately assembled from an existing server (`adapter-node`) and an existing
client (`adapter-expo`), and the value of `devtools-expo` is precisely that it
adds no new protocol surface to maintain. Its real risks are operational, not
protocol-level: an unmanaged server lifecycle, and the `0.0.0.0`-vs-`localhost`
host juggling that keeps the pieces reachable.

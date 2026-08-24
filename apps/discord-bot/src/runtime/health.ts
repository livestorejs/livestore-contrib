import { createServer } from "node:http"
import { Effect, Ref, Schema } from "effect"

export const RuntimeState = Schema.Literals(["starting", "ready", "degraded", "terminal"])
export type RuntimeState = typeof RuntimeState.Type

export const RestProbeState = Schema.Literals(["pending", "ok", "failed"])
export type RestProbeState = typeof RestProbeState.Type

export const GatewayState = Schema.Literals(["connecting", "ready", "disconnected", "fatal"])
export type GatewayState = typeof GatewayState.Type

export interface RuntimeHealthState {
  readonly state: RuntimeState
  readonly actionAuthority: boolean
  readonly journal: boolean
  readonly environment: "staging" | "production"
  readonly releaseId: string
  readonly identityVerified: boolean
  readonly restProbe: RestProbeState
  readonly handlersRegistered: boolean
  /** Documentation readiness is informational and never gates core readiness. */
  readonly docsReady: boolean
  readonly gateway: GatewayState
  readonly lastGatewayActivityAt?: string
  readonly lastRestProbeAt?: string
  readonly terminalErrorClass?: string
}

export const initialHealthState = (
  environment: RuntimeHealthState["environment"],
  releaseId: string,
): RuntimeHealthState => ({
  state: "starting",
  actionAuthority: false,
  journal: false,
  environment,
  releaseId,
  identityVerified: false,
  restProbe: "pending",
  handlersRegistered: false,
  docsReady: false,
  gateway: "connecting",
})

export const isReady = (state: RuntimeHealthState) =>
  state.state !== "terminal" && state.actionAuthority && state.journal && state.identityVerified && state.restProbe === "ok" &&
  state.gateway === "ready" && state.handlersRegistered

/** Computes lifecycle state from dependency observations; callers do not set ready by hand. */
export const deriveRuntimeState = (state: RuntimeHealthState): RuntimeState =>
  state.state === "terminal" ? "terminal" : isReady(state) ? "ready" :
    state.gateway === "disconnected" || state.gateway === "fatal" || state.restProbe === "failed" ? "degraded" : "starting"

export const serveHealth = (state: Ref.Ref<RuntimeHealthState>, host: "127.0.0.1", port: number) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly close: () => Promise<void> }, Error>(resume => {
      const server = createServer((request, response) => {
        if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/readyz")) {
          response.writeHead(404).end()
          return
        }
        Effect.runPromise(Ref.get(state)).then(current => {
          const ready = isReady(current)
          const success = request.url === "/healthz" ? current.state !== "terminal" : ready
          response.writeHead(success ? 200 : 503, { "content-type": "application/json" })
          response.end(JSON.stringify({ apiVersion: 1, state: current.state, ready, environment: current.environment,
            releaseId: current.releaseId, capabilities: { threading: isReady(current), docs: current.docsReady },
            identityVerified: current.identityVerified, restProbe: current.restProbe, lastRestProbeAt: current.lastRestProbeAt,
            handlersRegistered: current.handlersRegistered, gateway: { state: current.gateway, lastActivityAt: current.lastGatewayActivityAt, terminalErrorClass: current.terminalErrorClass } }))
        }).catch(() => response.writeHead(503).end())
      })
      server.once("error", cause => resume(Effect.fail(cause)))
      server.listen(port, host, () => {
        const address = server.address()
        resume(Effect.succeed({
          port: typeof address === "object" && address !== null ? address.port : port,
          close: () => new Promise<void>(resolve => server.close(() => resolve())),
        }))
      })
      return Effect.sync(() => server.close())
    }),
    server => Effect.promise(server.close),
  ).pipe(Effect.map(({ port }) => ({ port })), Effect.withSpan("runtime.health.serve"))

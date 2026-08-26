import { parseControlSocketOption } from './socket-option.ts'

/**
 * Process-level transport selection for operator lanes: explicit `--socket`
 * keeps dev4 parity, an authenticated HTTPS admin endpoint comes next, and the
 * deployment-default Unix socket is the final fallback.
 */
export type ControlTransportOption =
  | { readonly _tag: 'UnixSocket'; readonly path: string }
  | { readonly _tag: 'HttpsEndpoint'; readonly url: string; readonly token: string }
  | { readonly _tag: 'UsageError'; readonly message: string }

export type ControlEndpointOption =
  | { readonly _tag: 'Parsed'; readonly url: string | undefined }
  | { readonly _tag: 'UsageError'; readonly message: string }

/** Normalizes a base URL for `{base}/admin/rpc/{Operation}` posts; non-http(s) input is rejected. */
export const normalizeAdminBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

export const parseControlEndpointOption = (args: ReadonlyArray<string>): ControlEndpointOption => {
  const occurrences = args.flatMap((value, index) => (value === '--endpoint' ? [index] : []))
  if (occurrences.length === 0) return { _tag: 'Parsed', url: undefined }
  if (occurrences.length !== 1) return { _tag: 'UsageError', message: '--endpoint must be specified at most once' }

  const value = args[occurrences[0]! + 1]
  const url = value === undefined ? undefined : normalizeAdminBaseUrl(value)
  if (url === undefined) return { _tag: 'UsageError', message: '--endpoint requires an absolute http(s) URL' }
  return { _tag: 'Parsed', url }
}

export const selectControlTransport = (input: {
  readonly args: ReadonlyArray<string>
  readonly environmentEndpoint: string | undefined
  readonly environmentToken: string | undefined
  readonly socketEnvironmentPath: string | undefined
  readonly defaultSocketPath: string
}): ControlTransportOption => {
  const socket = parseControlSocketOption(input.args)
  if (socket._tag === 'UsageError') return socket
  // Explicit --socket wins over any configured endpoint so existing dev4
  // invocations keep talking to the local runtime unchanged.
  if (socket.path !== undefined) return { _tag: 'UnixSocket', path: socket.path }

  const endpoint = parseControlEndpointOption(input.args)
  if (endpoint._tag === 'UsageError') return endpoint
  const flagUrl = endpoint.url
  const environmentUrl =
    flagUrl === undefined && input.environmentEndpoint !== undefined
      ? normalizeAdminBaseUrl(input.environmentEndpoint)
      : undefined
  if (flagUrl === undefined && input.environmentEndpoint !== undefined && environmentUrl === undefined) {
    return { _tag: 'UsageError', message: 'LIVESTORE_DISCORD_ADMIN_ENDPOINT must be an absolute http(s) URL' }
  }
  const url = flagUrl ?? environmentUrl
  if (url !== undefined) {
    // The token is env-only by design: argv leaks through /proc and shell history.
    if (input.environmentToken === undefined || input.environmentToken.trim().length === 0) {
      return {
        _tag: 'UsageError',
        message: 'LIVESTORE_DISCORD_ADMIN_TOKEN must be set when an admin endpoint is configured',
      }
    }
    return { _tag: 'HttpsEndpoint', url, token: input.environmentToken }
  }

  return {
    _tag: 'UnixSocket',
    path: input.socketEnvironmentPath ?? input.defaultSocketPath,
  }
}

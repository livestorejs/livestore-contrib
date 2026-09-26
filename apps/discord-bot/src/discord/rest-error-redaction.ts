import { Cause, Layer, Logger, References } from 'effect'
import { HttpClientError } from 'effect/unstable/http'

/** No upstream error, request, response, URL, headers, body, or cause is retained. */
export class DiscordRestFailure extends Error {
  readonly _tag = 'DiscordRestFailure'
  readonly method: string
  readonly route: '/api/*'
  readonly status: number | undefined
  readonly errorClass: string

  constructor(method: string, route: '/api/*', status: number | undefined, errorClass: string) {
    super(`Discord REST ${method} ${route} ${status === undefined ? 'no response' : status} ${errorClass}`)
    this.name = 'DiscordRestFailure'
    this.method = method
    this.route = route
    this.status = status
    this.errorClass = errorClass
  }
}

const safeMethod = (value: unknown): string =>
  value === 'GET' || value === 'POST' || value === 'PATCH' || value === 'PUT' || value === 'DELETE' ? value : 'UNKNOWN'

const safeStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) === true && value >= 100 && value <= 599 ? value : undefined

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** DFX accepts Redacted tokens, but unwraps them into an HTTP Authorization header. */
export const redactDiscordRestError = (error: unknown): DiscordRestFailure => {
  if (error instanceof DiscordRestFailure) return error
  if (HttpClientError.isHttpClientError(error) === true) {
    const reason = error.reason
    return new DiscordRestFailure(
      safeMethod(reason.request.method),
      '/api/*',
      safeStatus('response' in reason ? reason.response.status : undefined),
      reason._tag,
    )
  }
  // DFX decodes ordinary Discord 4xx into DiscordRestError, which also embeds
  // the authenticated request and response (including their sensitive headers).
  const details = record(error)
  if (
    error instanceof Error &&
    error.name === 'DiscordRestError' &&
    (details?._tag === 'ErrorResponse' || details?._tag === 'RatelimitedResponse')
  ) {
    return new DiscordRestFailure(
      safeMethod(record(details.request)?.method),
      '/api/*',
      safeStatus(record(details.response)?.status),
      'DiscordRestError',
    )
  }
  // Unknown errors may contain a nested HTTP request or even secret-bearing message.
  return new DiscordRestFailure('UNKNOWN', '/api/*', undefined, 'UnexpectedError')
}

export const redactDiscordRestCause = (cause: Cause.Cause<unknown>): DiscordRestFailure => {
  const reason = cause.reasons[0]
  return redactDiscordRestError(
    reason === undefined
      ? undefined
      : Cause.isFailReason(reason) === true
        ? reason.error
        : Cause.isDieReason(reason) === true
          ? reason.defect
          : undefined,
  )
}

/** Only allowlisted fields cross process, Worker log, and Effect logger boundaries. */
export const safeDiscordFailureMessage = (error: unknown): string => {
  if (Cause.isCause(error) === true) {
    return error.reasons
      .map((reason) =>
        Cause.isFailReason(reason) === true
          ? redactDiscordRestError(reason.error).message
          : Cause.isDieReason(reason) === true
            ? redactDiscordRestError(reason.defect).message
            : 'Discord operation interrupted',
      )
      .join('; ')
  }
  return redactDiscordRestError(error).message
}

/** Scrub DFX log annotations as well as messages before either console or telemetry sees them. */
const redactLogText = (text: string): string =>
  text
    .replace(/(\/(?:webhooks|interactions)\/\d{17,20}\/)[^/?\s"']+/giu, '$1{token}')
    .replace(/((?:https?:\/\/|\/api\/)[^\s"'?]+)\?[^\s"']+/giu, '$1?{redacted}')
    .replace(/\b(Authorization\s*[:=]\s*(?:Bot|Bearer)\s+)[^\s"',}]+/giu, '$1<redacted>')
    .replace(/\b(Bot|Bearer)\s+[^\s"',}]+/giu, '$1 <redacted>')
    .replace(/\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{20,}\b/gu, '<redacted>')

const redactLogValue = (value: unknown, key = ''): unknown => {
  if (/^(?:authorization|cookie|set-cookie|x-api-key)$/iu.test(key) === true) return '<redacted>'
  if (typeof value === 'string') return redactLogText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value) === true) return value.map((item) => redactLogValue(item))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [redactLogText(field), redactLogValue(item, field)]),
    )
  }
  // Never inspect arbitrary Error, Request, Response, Redacted or class objects.
  return '[object]'
}

export const discordSafeLogger = Logger.withConsoleError(
  Logger.make((options) => {
    const formatted = Logger.formatStructured.log(options)
    return JSON.stringify({
      level: formatted.level,
      fiberId: formatted.fiberId,
      timestamp: formatted.timestamp,
      message: redactLogValue(formatted.message),
      cause: options.cause.reasons.length === 0 ? undefined : safeDiscordFailureMessage(options.cause),
      annotations: redactLogValue(formatted.annotations),
      spans: redactLogValue(formatted.spans),
    })
  }),
)

export const discordSafeLoggerLayer = Layer.merge(
  Logger.layer([discordSafeLogger]),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
)

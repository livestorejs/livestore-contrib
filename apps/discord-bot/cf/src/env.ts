import * as Redacted from 'effect/Redacted'

/**
 * Secret bindings arrive either as plain strings (local dev) or Redacted
 * values (`secret_text` on Cloudflare); both collapse to their string value.
 */
export const readSecret = (env: Record<string, unknown>, key: string): string => {
  const value = env[key]
  return typeof value === 'string' ? value : Redacted.value(value as Redacted.Redacted)
}

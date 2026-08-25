import * as Redacted from 'effect/Redacted'

/**
 * Secret bindings arrive either as plain strings (local dev) or Redacted
 * values (`secret_text` on Cloudflare); both collapse to their string value.
 */
export const readSecret = (env: Record<string, unknown>, key: string): string => {
  const value = env[key]
  if (typeof value === 'string') return value
  // Alchemy's deploy phase evaluates the DO init with placeholder bindings
  // that are neither strings nor Redacted values; fail loudly instead of
  // crashing inside Redacted internals.
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { _tag?: unknown })._tag !== 'Redacted'
  ) {
    throw new Error(`secret binding ${key} is not available in this phase`)
  }
  return Redacted.value(value as Redacted.Redacted)
}

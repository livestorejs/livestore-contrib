import { Effect, Logger, References } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { discordSafeLogger, discordSafeLoggerLayer } from './rest-error-redaction.ts'

describe('Discord logger credential boundary', () => {
  it('scrubs DFX 429 debug messages and annotations before output', () => {
    const token = 'FAKE_WEBHOOK_TOKEN_NEVER_LOG_123456'
    const botToken = 'FAKE_BOT_TOKEN_NEVER_LOG_123456'
    const lines: string[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      Effect.runSync(
        Effect.logDebug(`429 Authorization: Bot ${botToken}`).pipe(
          Effect.annotateLogs({
            url: `https://discord.com/api/v10/webhooks/123456789012345678/${token}?secret=${token}`,
            callback: `https://discord.com/api/v10/interactions/123456789012345678/${token}/callback`,
            Authorization: `Bot ${botToken}`,
            auth: `Bearer ${botToken}`,
          }),
          Effect.provide(Logger.layer([discordSafeLogger])),
          Effect.provideService(References.MinimumLogLevel, 'Debug'),
        ),
      )
      expect(lines).toHaveLength(1)
      const output = lines.join('')
      expect(output).toContain('/webhooks/123456789012345678/{token}')
      expect(output).toContain('/interactions/123456789012345678/{token}/callback')
      expect(output).toContain('<redacted>')
      expect(output).not.toContain(`secret=${token}`)
      expect(output).not.toContain(token)
      expect(output).not.toContain(botToken)
      expect(output).not.toContain(`Bot ${botToken}`)
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('sets an Info minimum so DFX Debug is not emitted by default', () => {
    const lines: string[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      Effect.runSync(Effect.logDebug('429').pipe(Effect.provide(discordSafeLoggerLayer)))
      Effect.runSync(Effect.logInfo('running').pipe(Effect.provide(discordSafeLoggerLayer)))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('running')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

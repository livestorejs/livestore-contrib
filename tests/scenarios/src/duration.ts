import { Duration } from '@livestore/utils/effect'

export class ScenarioDurationError extends Error {
  readonly _tag = 'ScenarioDurationError'

  constructor(message: string) {
    super(message)
    this.name = 'ScenarioDurationError'
  }
}

/** Parses the concise Scenario duration vocabulary through Effect Duration. */
export const parseScenarioDurationMs = (source: string): number => {
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(source)
  if (match === null) {
    throw new ScenarioDurationError(`Expected a positive duration in ms, s, or m; received '${source}'`)
  }
  const amount = Number(match[1])
  const duration =
    match[2] === 'ms' ? Duration.millis(amount) : match[2] === 's' ? Duration.seconds(amount) : Duration.minutes(amount)
  const durationMs = Duration.toMillis(duration)
  if (Number.isSafeInteger(durationMs) === false) {
    throw new ScenarioDurationError(`Duration is too large: '${source}'`)
  }
  return durationMs
}

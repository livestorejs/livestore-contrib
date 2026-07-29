import React from 'react'

/** Causes a periodic re-render */
export const useTick = (intervalMs: number, isActive: boolean) => {
  const [tick, setTick] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (isActive) {
      const interval = setInterval(() => setTick(Date.now()), intervalMs)
      return () => clearInterval(interval)
    }
    return undefined
  }, [intervalMs, isActive])

  return tick
}

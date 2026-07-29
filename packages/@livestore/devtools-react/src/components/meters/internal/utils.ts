export const shouldNeverHappen = (msg?: string, ...args: unknown[]): never => {
  console.error(msg, ...args)
  throw new Error(`This should never happen: ${msg}`)
}

export const casesHandled = (x: never): never => {
  throw new Error(`Unhandled case: ${String(x)}`)
}

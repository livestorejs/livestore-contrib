import { posix } from 'node:path'

export type ControlSocketOption =
  | { readonly _tag: 'Parsed'; readonly path: string | undefined }
  | { readonly _tag: 'UsageError'; readonly message: string }

export type SelectedControlSocketOption =
  | { readonly _tag: 'Parsed'; readonly path: string }
  | { readonly _tag: 'UsageError'; readonly message: string }

/** Parses the process-level transport override before the RPC client exists. */
export const parseControlSocketOption = (args: ReadonlyArray<string>): ControlSocketOption => {
  const occurrences = args.flatMap((value, index) => (value === '--socket' ? [index] : []))
  if (occurrences.length === 0) return { _tag: 'Parsed', path: undefined }
  if (occurrences.length !== 1) return { _tag: 'UsageError', message: '--socket must be specified at most once' }

  const path = args[occurrences[0]! + 1]
  if (
    path === undefined ||
    path.startsWith('/') === false ||
    posix.normalize(path) !== path ||
    path.endsWith('.sock') === false
  ) {
    return { _tag: 'UsageError', message: '--socket requires a normalized absolute .sock path' }
  }
  return { _tag: 'Parsed', path }
}

export const selectControlSocketPath = (input: {
  readonly args: ReadonlyArray<string>
  readonly environmentPath: string | undefined
  readonly defaultPath: string
}): SelectedControlSocketOption => {
  const parsed = parseControlSocketOption(input.args)
  return parsed._tag === 'UsageError'
    ? parsed
    : { _tag: 'Parsed', path: parsed.path ?? input.environmentPath ?? input.defaultPath }
}

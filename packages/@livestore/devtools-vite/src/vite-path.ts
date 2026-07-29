import path from 'node:path'

import { normalizePath } from 'vite'

/**
 * Computes the mount path for the devtools, combining the Vite base path with the devtools pathname.
 *
 * The result is used both for server-side middleware mounting and for the client-side
 * `LIVESTORE_DEVTOOLS_PATH` define which is used to construct URLs at runtime.
 *
 * Scenarios:
 * - `base: '/'` (default Vite) + `pathname: '/_livestore'` → `/_livestore`
 * - `base: '/_build'` (e.g. TanStack Start) + `pathname: '/_livestore'` → `/_build/_livestore`
 * - `base: './'` (e.g. Electron file:// protocol) + `pathname: '/_livestore'` → `/_livestore`
 *
 * The trailing normalization ensures the path always starts with `/` for URL compatibility,
 * which is necessary because `path.join('./', '/_livestore')` returns `_livestore` (no leading slash).
 */
export const getMountPath = ({
  path: explicitPath,
  base,
}: {
  path: string | undefined
  base: string
}): string => {
  const pathname = explicitPath ?? '/_livestore'
  const joined = path.join(base, pathname)
  return joined.startsWith('/') ? joined : `/${joined}`
}

/**
 * Extracts the pathname portion from a Node.js request URL without requiring a base origin.
 */
export const getPathnameFromRequestUrl = (rawUrl: string): string => {
  if (rawUrl.length === 0) return '/'

  if (rawUrl[0] === '/') {
    const q = rawUrl.indexOf('?')
    return q === -1 ? rawUrl : rawUrl.slice(0, q)
  }

  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      return new URL(rawUrl).pathname
    } catch {
      // fall through to generic fallback
    }
  }

  const q = rawUrl.indexOf('?')
  const p = q === -1 ? rawUrl : rawUrl.slice(0, q)
  return p.startsWith('/') ? p : `/${p}`
}

const viteResourceExtensions = [
  '.ts',
  '.js',
  '.mjs',
  '.jsx',
  '.tsx',
  '.css',
  '.json',
  '.wasm',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
] as const

const viteResourceQueryFlags = ['import', 'raw', 'url', 'worker', 'sharedworker'] as const

const hasViteResourceQuery = (rawUrl: string): boolean => {
  const queryStart = rawUrl.indexOf('?')
  if (queryStart === -1) return false

  const query = rawUrl.slice(queryStart + 1)
  const params = new URLSearchParams(query)
  return viteResourceQueryFlags.some((flag) => params.has(flag))
}

/**
 * Decides whether a request under the DevTools mount belongs to Vite instead of the
 * DevTools HTML fallback. Vite owns module/resource URLs; DevTools owns app-shell routes.
 */
export const shouldPassThroughViteRequest = ({
  rawUrl,
  mountPath,
}: {
  rawUrl: string
  mountPath: string
}): boolean => {
  const pathname = getPathnameFromRequestUrl(rawUrl)
  const relativePathnameRaw = pathname.startsWith(mountPath)
    ? pathname.slice(mountPath.length) || '/'
    : pathname
  const relativePathname = relativePathnameRaw.startsWith('/')
    ? relativePathnameRaw
    : `/${relativePathnameRaw}`

  return (
    relativePathname.startsWith('/@') ||
    viteResourceExtensions.some((extension) => relativePathname.endsWith(extension)) ||
    hasViteResourceQuery(rawUrl)
  )
}

/**
 * Normalizes a Vite-resolved module id for use as a browser import.
 *
 * Vite's `/@fs` prefix is concatenated directly with the absolute pathname:
 * `/@fs/home/example/module.ts`, never `/@fs//home/example/module.ts`.
 */
export const normalizeClientImport = (
  resolved: string | null | undefined,
): string | undefined => {
  if (!resolved) return undefined
  if (resolved.startsWith('file://')) {
    return `/@fs${normalizePath(new URL(resolved).pathname)}`
  }
  if (path.isAbsolute(resolved) && !resolved.startsWith('/@fs/')) {
    return `/@fs${normalizePath(resolved)}`
  }
  return resolved
}

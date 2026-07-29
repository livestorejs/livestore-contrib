import { describe, expect, it } from 'vitest'

import {
  devtoolsReactSourceFilter,
  getMountPath,
  getPathnameFromRequestUrl,
  normalizeClientImport,
  shouldPassThroughViteRequest,
} from './vite-path.js'

describe('devtoolsReactSourceFilter', () => {
  it('matches Vite absolute source ids', () => {
    expect(
      devtoolsReactSourceFilter.test(
        '/@fs/workspace/packages/@livestore/devtools-react/src/mount-devtools.tsx',
      ),
    ).toEqual(true)
  })

  it('matches package-manager source ids on Windows', () => {
    expect(
      devtoolsReactSourceFilter.test(
        String.raw`C:\workspace\node_modules\@livestore\devtools-react\src\mod.ts`,
      ),
    ).toEqual(true)
  })

  it('does not match host application source', () => {
    expect(
      devtoolsReactSourceFilter.test('/workspace/examples/solid/src/App.tsx'),
    ).toEqual(false)
  })
})

describe('getMountPath', () => {
  it('default vite / node adapter case', () => {
    expect(getMountPath({ path: undefined, base: '/' })).toEqual('/_livestore')
  })

  it('TanStack Start case', () => {
    expect(getMountPath({ path: undefined, base: '/_build' })).toEqual('/_build/_livestore')
  })

  it('TanStack Start case with explicit path', () => {
    expect(getMountPath({ path: '/_livestore', base: '/_build' })).toEqual('/_build/_livestore')
  })

  it('Electron file:// protocol case (relative base)', () => {
    expect(getMountPath({ path: undefined, base: './' })).toEqual('/_livestore')
  })
})

describe('getPathnameFromRequestUrl', () => {
  it('strips query from path-only urls', () => {
    expect(getPathnameFromRequestUrl('/_livestore/packages/pkg/package.json?import')).toEqual(
      '/_livestore/packages/pkg/package.json',
    )
  })

  it('handles absolute urls', () => {
    expect(
      getPathnameFromRequestUrl('http://127.0.0.1:4242/_livestore/@vite/client?import'),
    ).toEqual('/_livestore/@vite/client')
  })
})

describe('shouldPassThroughViteRequest', () => {
  it('passes through Vite internals', () => {
    expect(
      shouldPassThroughViteRequest({
        rawUrl: '/_livestore/@vite/client?import',
        mountPath: '/_livestore',
      }),
    ).toEqual(true)
  })

  it('passes through JSON module imports emitted by Vite', () => {
    expect(
      shouldPassThroughViteRequest({
        rawUrl: '/_livestore/packages/@livestore/common/package.json?import',
        mountPath: '/_livestore',
      }),
    ).toEqual(true)
  })

  it('passes through Vite resource query requests even without a known extension', () => {
    expect(
      shouldPassThroughViteRequest({
        rawUrl: '/_livestore/assets/icon?raw',
        mountPath: '/_livestore',
      }),
    ).toEqual(true)
  })

  it('keeps direct DevTools app routes on the HTML fallback', () => {
    expect(
      shouldPassThroughViteRequest({
        rawUrl: '/_livestore/web/app-root/client/session/default',
        mountPath: '/_livestore',
      }),
    ).toEqual(false)
  })
})

describe('normalizeClientImport', () => {
  it('normalizes absolute paths without a double slash after /@fs', () => {
    expect(normalizeClientImport('/workspace/example/module.ts')).toEqual(
      '/@fs/workspace/example/module.ts',
    )
  })

  it('normalizes file URLs without a double slash after /@fs', () => {
    expect(normalizeClientImport('file:///workspace/example/module.ts')).toEqual(
      '/@fs/workspace/example/module.ts',
    )
  })

  it('preserves Vite ids that are already browser-consumable', () => {
    expect(normalizeClientImport('/@fs/workspace/example/module.ts')).toEqual(
      '/@fs/workspace/example/module.ts',
    )
  })
})

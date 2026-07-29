/** biome-ignore-all lint/correctness/noUnusedVariables: This is used to expose variables on `window` */

/// <reference types="vite/client" />

import type { Opfs } from '@livestore/utils/effect'

declare global {
  interface Window {
    /**
     * This is useful to temporarily expose variables on `window`
     * without having to write `(window as any).someProp`
     */
    [key: `tmp${string}`]: any
    [key: `__debug${string}`]: any
    __debugLiveStore: Record<string, import('@livestore/livestore').Store<any>> | undefined
  }

  // eslint-disable-next-line no-var
  var __debugOpfsUtils: typeof Opfs.debugUtils

  var LIVESTORE_DEVTOOLS_ENFORCE_LICENSE: boolean | undefined
  var LIVESTORE_DEVTOOLS_SANDBOX: true | undefined
}

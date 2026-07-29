import type { WebAdapterOptions } from '@livestore/adapter-web'
import type { Devtools } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/livestore'
import { Opfs } from '@livestore/utils/effect/browser'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import React from 'react'
import * as RA from 'react-aria'
import { createRoot } from 'react-dom/client'

import { RootContext } from './root-context.js'
import { router } from './router.js'
import { routeTree } from './routeTree.gen.js'
import { ThemeProvider } from './theme/mod.js'
import type { DevtoolsOptions } from './types.js'

// In case there's some debugging needed, we expose some OPFS utils
globalThis.__debugOpfsUtils = Opfs.debugUtils

export const mountDevtools = ({
  schemas,
  sharedWorker,
  rootEl,
  options,
  mode,
  license,
  mountPath = '/_livestore',
  useMemoryRouter,
  portalEl,
}: {
  schemas: ReadonlyArray<LiveStoreSchema>
  rootEl: HTMLElement
  options?: DevtoolsOptions
  /** Only needed for web adapter */
  sharedWorker: WebAdapterOptions['sharedWorker']
  mode?: Devtools.DevtoolsMode
  license?: string
  mountPath?: string
  useMemoryRouter?: {
    initialRoute: string
  }
  portalEl?: HTMLElement
}) => {
  // Needed for Glide Data Grid
  if (document.getElementById('portal') === null) {
    const portal = document.createElement('div')
    portal.id = 'portal'
    document.body.append(portal)
  }

  // Needed to support embedding the devtools in LiveStore website
  const usedRouter = useMemoryRouter
    ? createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [useMemoryRouter.initialRoute] }),
      })
    : router

  // void import('../dist/index.css?inline').then((cssText) => {
  // const styleElement = document.createElement('style')
  //   styleElement.innerHTML = cssText.default
  // document.head.append(styleElement)
  // })

  const Main: React.FC<React.PropsWithChildren> = ({ children }) => {
    const [reloadKey, setReloadKey] = React.useState(0)

    return (
      <ThemeProvider>
        <RA.UNSAFE_PortalProvider getContainer={() => portalEl ?? document.body}>
          <RootContext.Provider
            key={reloadKey}
            value={{
              appSchemas: schemas,
              mode,
              license,
              sharedWorker,
              options,
              mountPath,
              triggerReload: () => setReloadKey((k) => k + 1),
            }}
          >
            {children}
          </RootContext.Provider>
        </RA.UNSAFE_PortalProvider>
      </ThemeProvider>
    )
  }

  createRoot(rootEl).render(
    <RouterProvider
      router={usedRouter}
      basepath={mountPath}
      InnerWrap={({ children }) => <Main>{children}</Main>}
    />,
  )
}

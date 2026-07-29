import type { WebAdapterOptions } from '@livestore/adapter-web'
import type { Devtools } from '@livestore/common'
import type * as LiveStore from '@livestore/livestore'
import React from 'react'

// import { Root } from './Root.js'
import { ShadowRootWrapper } from './ShadowRootWrapper.js'

const AllTabsLazy = React.lazy(() =>
  import('./Tabs/AllTabs.js').then((m) => ({ default: m.AllTabs })),
)

export const DevtoolsLazy: React.FC<{
  schema: LiveStore.LiveStoreSchema
  sharedWorker: WebAdapterOptions['sharedWorker']
  className?: string
  mode: Devtools.DevtoolsMode
}> = ({ schema: _schema, sharedWorker: _sharedWorker, className, mode: _mode }) => (
  <ShadowRootWrapper
    {...(className !== undefined ? { className } : {})}
    render={() => (
      <React.Suspense fallback={<div>Loading...</div>}>
        {/* <Root schema={schema} sharedWorker={sharedWorker} mode={mode}> */}
        <AllTabsLazy />
        {/* </Root> */}
      </React.Suspense>
    )}
  />
)

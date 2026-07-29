import React from 'react'

import { Icons } from '../Icons/mod.js'
import type { Tab } from '../TabsContainer.js'
import { TabsContainer } from '../TabsContainer.js'
import { DataBrowser } from './data-browser/DataBrowser.js'
import { EventlogBrowser } from './EventlogBrowser.js'
import { General } from './General.js'
import { Queries } from './Queries/Queries.js'
// import { Refreshes } from './Refreshes.js'
import { Sync } from './Sync.js'

export const AllTabs: React.FC = () => {
  const allTabs: Tab[] = React.useMemo(
    () => [
      {
        label: 'Database',
        component: () => <DataBrowser />,
        icon: <Icons.Database className="w-4 h-4" />,
      },
      { label: 'Queries', component: Queries, icon: <Icons.TextSearch className="w-4 h-4" /> },
      // { label: 'Refreshes', component: Refreshes },
      {
        label: 'Events',
        component: () => <EventlogBrowser />,
        icon: <Icons.GalleryHorizontalEnd className="w-4 h-4" />,
      },
      { label: 'Sync', component: Sync, icon: <Icons.Wifi className="w-4 h-4" /> },
      { label: 'General', component: General, icon: <Icons.Settings className="w-4 h-4" /> },
    ],
    [],
  )

  return <TabsContainer tabs={allTabs} />
}

import type { Meta, StoryObj } from '@storybook/react'

import { createTestingDecorator } from '../../testing/testing-provider.js'
import { DataBrowser } from './DataBrowser.js'

const meta: Meta<typeof DataBrowser> = {
  title: 'DevTools Tabs/Database/DataBrowser',
  component: DataBrowser,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'database',
      },
    }),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {}

export const LiveStoreInternalsExpanded: Story = {
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'database',
        tabState: {
          livestoreInternalsExpanded: true,
        },
      },
    }),
  ],
}

export const ClientDocumentFlattened: Story = {
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'database',
        tabState: {
          expandedTables: ['user_preferences'],
          livestoreInternalsExpanded: false,
        },
      },
    }),
  ],
}

export const SessionIdBadge: Story = {
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'database',
        tabState: {
          expandedTables: ['session_data'],
          livestoreInternalsExpanded: false,
        },
      },
    }),
  ],
}

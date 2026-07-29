import type { Meta, StoryObj } from '@storybook/react'

import { createTestingDecorator } from '../../testing/testing-provider.js'
import { LiveQueries } from './LiveQueries.js'

const meta: Meta<typeof LiveQueries> = {
  title: 'DevTools Tabs/Queries/LiveQueries',
  component: LiveQueries,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'queries',
        queriesSubtab: 'live-queries',
      },
    }),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {}

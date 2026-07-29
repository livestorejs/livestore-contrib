import type { Meta, StoryObj } from '@storybook/react'

import { createTestingDecorator } from '../testing/testing-provider.js'
import { Sync } from './Sync.js'

const meta: Meta<typeof Sync> = {
  title: 'DevTools Tabs/Sync/Sync',
  component: Sync,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'sync',
      },
    }),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {}

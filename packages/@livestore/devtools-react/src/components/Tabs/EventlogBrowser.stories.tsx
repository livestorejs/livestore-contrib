import type { Meta, StoryObj } from '@storybook/react'

import { createTestingDecorator } from '../testing/testing-provider.js'
import { EventlogBrowser } from './EventlogBrowser.js'

const meta: Meta<typeof EventlogBrowser> = {
  title: 'DevTools Tabs/Events/EventlogBrowser',
  component: EventlogBrowser,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'events',
      },
    }),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {}

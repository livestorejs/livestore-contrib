import type { Meta, StoryObj } from '@storybook/react'

import { createTestingDecorator } from '../testing/testing-provider.js'
import { General } from './General.js'

const meta: Meta<typeof General> = {
  title: 'DevTools Tabs/General/General',
  component: General,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    createTestingDecorator({
      tabConfig: {
        tab: 'general',
      },
    }),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

export const Basic: Story = {}

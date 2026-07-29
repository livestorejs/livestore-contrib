import type { Meta, StoryObj } from '@storybook/react'

import { makeMockDevtoolsApi } from '../testing/testing-provider.js'
import { Sqlite } from './Sqlite.js'

const { createDevtoolsDecorator } = makeMockDevtoolsApi()

const meta: Meta<typeof Sqlite> = {
  title: 'DevTools Tabs/Database/SQLite',
  component: Sqlite,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [createDevtoolsDecorator()],
}

export default meta

const defineStory = (story: StoryObj<Meta<typeof Sqlite>>) => story

export const Basic: StoryObj<typeof meta> = defineStory({})

import type { ReactiveGraph } from '@livestore/livestore/internal'
import type { Meta, StoryObj } from '@storybook/react'

import {
  testNodes,
  testNodes2,
  testNodes3,
  testNodes4,
  testNodes5,
} from '../../../utils/storybook/fixture-snapshots.js'
import { createTestingDecorator } from '../../testing/testing-provider.js'
import { DagNodesPure } from './DagNodes.js'

const meta: Meta<typeof DagNodesPure> = {
  title: 'DevTools Tabs/Queries/DagNodes',
  component: DagNodesPure,
  parameters: {
    backgrounds: { default: 'dark' },
  },
}

export default meta

const defineStory = (snapshot: ReactiveGraph.ReactiveGraphSnapshot): StoryObj<typeof meta> => ({
  args: { snapshot },
  decorators: [
    createTestingDecorator({
      snapshot,
      tabConfig: {
        tab: 'queries',
        queriesSubtab: 'reactivity-graph',
      },
    }),
  ],
})

export const Basic: StoryObj<typeof meta> = defineStory(testNodes)
export const Basic2: StoryObj<typeof meta> = defineStory(testNodes2)
export const Basic3: StoryObj<typeof meta> = defineStory(testNodes3)
export const Basic4: StoryObj<typeof meta> = defineStory(testNodes4)
export const Basic5: StoryObj<typeof meta> = defineStory(testNodes5)

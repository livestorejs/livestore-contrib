import type { Meta, StoryObj } from '@storybook/react'
import type React from 'react'

import { useTestingState } from '../../../utils/storybook/useTestingState.js'
import { createTestingDecorator } from '../../testing/testing-provider.js'
import { DagNodesPaste } from './DagNodes.js'

const TestingDagNodes: React.FC = () => {
  const [state, setState] = useTestingState()

  return <DagNodesPaste state={state} setState={setState} />
}

const meta: Meta<typeof TestingDagNodes> = {
  title: 'DevTools Tabs/Queries/DagNodesPaste',
  component: TestingDagNodes,
  parameters: {
    backgrounds: { default: 'dark' },
  },
}

export default meta

const defineStory = (story: StoryObj<Meta<typeof TestingDagNodes>>) => ({
  ...story,
  decorators: [createTestingDecorator()],
})

export const Paste: StoryObj<typeof meta> = defineStory({ args: {} })

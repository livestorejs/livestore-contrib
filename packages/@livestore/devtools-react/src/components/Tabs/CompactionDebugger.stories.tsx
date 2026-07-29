import { historyDagFromNodes } from '@livestore/common/sync/next'
import type { PartialEvent } from '@livestore/common/sync/next/test'
import { events, toEventNodes } from '@livestore/common/sync/next/test'
import type { Meta, StoryObj } from '@storybook/react'
import type React from 'react'

import { CompactionDebugger } from './CompactionDebugger.js'

const TestComponent: React.FC<{ partialEvents: PartialEvent[] }> = ({ partialEvents }) => {
  return (
    <CompactionDebugger
      dag={historyDagFromNodes(toEventNodes(partialEvents, events, 'client-id', 'session-id'))}
    />
  )
}

const meta: Meta<typeof TestComponent> = {
  title: 'DevTools Tabs/Events/CompactionDebugger',
  component: TestComponent,
  parameters: {
    backgrounds: { default: 'dark' },
  },
}

export default meta

const defineStory = (story: StoryObj<Meta<typeof TestComponent>>) => story

export const Basic: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.todoCompleted({ id: 'A' }),
      events.setReadonlyTodo({ id: 'A', readonly: false }),
      events.setTextTodo({ id: 'A', text: 'buy soy milk' }),
      events.todoCompleted({ id: 'A' }),
      events.setReadonlyTodo({ id: 'A', readonly: false }),
      // mutations.setTextTodo({ id: 'A', text: 'buy soy milk' }),
    ],
  },
})

export const Basic2: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.todoCompleted({ id: 'A' }),
      events.setTextTodo({ id: 'A', text: 'buy soy milk' }),
      events.todoCompleted({ id: 'A' }),
      events.setReadonlyTodo({ id: 'A', readonly: false }),
      events.setTextTodo({ id: 'A', text: 'buy soy milk' }),
    ],
  },
})

export const BasicReadonlyCompaction: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.setReadonlyTodo({ id: 'A', readonly: false }),
      events.setTextTodo({ id: 'A', text: 'buy soy milk' }),
      events.setReadonlyTodo({ id: 'A', readonly: true }),
      // Next mutation isn't valid
      // mutations.setTextTodo({ id: 'A', text: 'buy oat milk' }),
    ],
  },
})

export const Basic2Todos: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.todoCompleted({ id: 'A' }),
      events.setReadonlyTodo({ id: 'A', readonly: false }),
      events.setTextTodo({ id: 'A', text: 'buy soy milk' }),
      events.createTodo({ id: 'B', text: 'buy bread' }),
      events.todoCompleted({ id: 'B' }),
      events.setReadonlyTodo({ id: 'B', readonly: false }),
      events.setTextTodo({ id: 'B', text: 'buy whole wheat bread' }),
    ],
  },
})

export const BasicToggle: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.toggleTodo({ id: 'A' }),
      events.toggleTodo({ id: 'A' }),
      events.todoCompleted({ id: 'A' }),
      events.todoCompleted({ id: 'A' }),
      events.toggleTodo({ id: 'A' }),
    ],
  },
})

export const BasicCompleteTodos: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.createTodo({ id: 'B', text: 'buy bread' }),
      events.createTodo({ id: 'C', text: 'buy cheese' }),
      events.todoCompleteds({ ids: ['A', 'B', 'C'] }),
      events.toggleTodo({ id: 'A' }),
      events.todoCompleted({ id: 'A' }),
    ],
  },
})

export const BasicInputValue: StoryObj<typeof meta> = defineStory({
  args: {
    partialEvents: [
      events.createTodo({ id: 'A', text: 'buy milk' }),
      events.setInputValue({ id: 'input-1', text: 'hello' }),
      events.setInputValue({ id: 'input-1', text: 'hello world' }),
      events.todoCompleted({ id: 'A' }),
    ],
  },
})

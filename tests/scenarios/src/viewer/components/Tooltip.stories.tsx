/* eslint-disable react-perf/jsx-no-new-array-as-prop -- Stories intentionally construct isolated tooltip content. */
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Tooltip } from './Tooltip.tsx'

const meta = {
  title: 'Viewer/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const EventArguments: Story = {
  args: {
    content: {
      title: 'Todo text changed',
      details: [
        { label: 'id', value: 'todo-03' },
        { label: 'text', value: 'Write the reconciliation report' },
      ],
    },
    children: <button type="button">e21</button>,
  },
}

export const PendingEvent: Story = {
  args: {
    content: {
      title: 'Hotel room booked',
      status: 'pending',
      details: [
        { label: 'roomType', value: 'standard' },
        { label: 'bookingId', value: 'booking-client-a' },
      ],
    },
    children: <button type="button">e2′</button>,
  },
}

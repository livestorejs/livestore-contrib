import { describe, expect, test } from 'vitest'

import type { ObservedEvent } from '../model.ts'
import {
  eventArgumentDetails,
  eventTooltipContent,
  humanizeEventName,
  timelineEventTooltipContent,
} from './event-tooltip.ts'

const changedTodo: ObservedEvent = {
  eventRef: 'event-0021',
  name: 'v1.TodoTextChanged',
  args: { id: 'todo-03', text: 'Write the reconciliation report' },
  origin: { clientId: 'client-a', sessionId: 'session-a' },
  position: 'e21',
  parentPosition: 'e20',
  disposition: 'confirmed',
}

describe('Event tooltip content', () => {
  test('shows the Event kind and arguments without trace-capture metadata', () => {
    expect(eventTooltipContent(changedTodo)).toEqual({
      title: 'Todo text changed',
      status: undefined,
      details: [
        { label: 'id', value: 'todo-03' },
        { label: 'text', value: 'Write the reconciliation report' },
      ],
    })
  })

  test('keeps pending status and bounds large values', () => {
    const content = eventTooltipContent({ ...changedTodo, disposition: 'pending', args: { text: 'x'.repeat(300) } })

    expect(content.status).toBe('pending')
    expect(content.details?.[0]?.value).toHaveLength(180)
    expect(content.details?.[0]?.value.endsWith('…')).toBe(true)
  })

  test('humanizes versioned and delimiter-separated Event names', () => {
    expect(humanizeEventName('v1.HotelRoomBooked')).toBe('Hotel room booked')
    expect(humanizeEventName('todo_item-restored')).toBe('Todo item restored')
    expect(eventArgumentDetails(['a', 'b'])).toEqual([{ label: 'value', value: '["a","b"]' }])
  })

  test('summarizes aggregated timeline markers without trace bookkeeping', () => {
    const content = timelineEventTooltipContent([
      changedTodo,
      { ...changedTodo, eventRef: 'event-0022', args: { id: 'todo-04', text: 'Review the report' } },
    ])

    expect(content.title).toBe('2 events')
    expect(content.details).toEqual([
      { label: 'Todo text changed', value: 'id: todo-03 · text: Write the reconciliation report' },
      { label: 'Todo text changed', value: 'id: todo-04 · text: Review the report' },
    ])
  })
})

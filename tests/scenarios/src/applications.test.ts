import { describe, expect, it } from 'vitest'

import { getScenarioApplication } from './applications.ts'
import { hotelBookingApplication, hotelBookingEvents } from './fixtures/hotel-booking-application.ts'
import { todoApplication, todoEvents } from './fixtures/todo-application.ts'

describe('scenario applications', () => {
  it('keeps todo behavior limited to the todo domain', () => {
    expect(Object.values(todoEvents).map(({ name }) => name)).toEqual([
      'v1.TodoCreated',
      'v1.TodoTextChanged',
      'v1.TodoCompletionChanged',
      'v1.TodoDeleted',
    ])
    expect(Object.keys(todoApplication.actions)).toEqual(['createTodo', 'editTodo', 'setTodoCompleted', 'deleteTodo'])
    expect(Object.keys(todoApplication.workloads)).toEqual(['createTodoBurst'])
    expect(Object.keys(todoApplication.inspectors)).toEqual(['todos'])
  })

  it('keeps hotel booking behavior limited to inventory initialization and booking', () => {
    expect(Object.values(hotelBookingEvents).map(({ name }) => name)).toEqual([
      'v1.HotelRoomInventoryInitialized',
      'v1.HotelRoomBooked',
    ])
    expect(Object.keys(hotelBookingApplication.actions)).toEqual(['initializeHotelRoomInventory', 'bookHotelRoom'])
    expect(hotelBookingApplication.workloads).toEqual({})
    expect(hotelBookingApplication.inspectors).toEqual({})
  })

  it('resolves both application definitions by their scenario IDs', () => {
    expect(getScenarioApplication(todoApplication.id).id).toBe('scenario-todo-app')
    expect(getScenarioApplication(hotelBookingApplication.id).id).toBe('scenario-hotel-booking-app')
  })
})

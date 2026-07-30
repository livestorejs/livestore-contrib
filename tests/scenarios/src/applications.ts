import type { LiveStoreSchema } from '@livestore/common/schema'

import type { ApplicationDefinition } from './application.ts'
import { hotelBookingApplication } from './fixtures/hotel-booking-application.ts'
import { todoApplication } from './fixtures/todo-application.ts'

/** Type-erased only at the serialized host boundary; each registry entry retains its matching schema. */
export type RegisteredApplication = ApplicationDefinition<LiveStoreSchema>

const registerApplication = <TSchema extends LiveStoreSchema>(
  application: ApplicationDefinition<TSchema>,
): RegisteredApplication => application as unknown as RegisteredApplication

const applications: ReadonlyMap<string, RegisteredApplication> = new Map([
  [todoApplication.id, registerApplication(todoApplication)],
  [hotelBookingApplication.id, registerApplication(hotelBookingApplication)],
])

/** Runtime registry used by the CLI and serialized participant hosts. */
export const getScenarioApplication = (applicationId: string): RegisteredApplication => {
  const application = applications.get(applicationId)
  if (application !== undefined) return application
  throw new Error(`Unknown scenario application: ${applicationId}`)
}

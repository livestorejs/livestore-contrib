import type { LiveStoreSchema } from '@livestore/common/schema'

import type { ApplicationDefinition } from '../../application/definition.ts'
import { hotelBookingApplication } from './hotel-booking.ts'
import { todoApplication } from './todo.ts'

/** Type-erased only at the serialized host boundary; each registry entry retains its matching schema. */
export type RegisteredApplication = ApplicationDefinition<LiveStoreSchema>

const registerApplication = <TSchema extends LiveStoreSchema>(
  application: ApplicationDefinition<TSchema>,
): RegisteredApplication => application as unknown as RegisteredApplication

export const scenarioApplications: ReadonlyArray<RegisteredApplication> = [
  registerApplication(todoApplication),
  registerApplication(hotelBookingApplication),
]

const applicationsById: ReadonlyMap<string, RegisteredApplication> = new Map(
  scenarioApplications.map((application) => [application.id, application]),
)
const applicationsByScenarioName: ReadonlyMap<string, RegisteredApplication> = new Map(
  scenarioApplications.map((application) => [application.scenarioName, application]),
)

if (
  applicationsById.size !== scenarioApplications.length ||
  applicationsByScenarioName.size !== scenarioApplications.length
) {
  throw new Error('Scenario application IDs and source names must be unique')
}

/** Runtime registry used by the CLI and serialized participant hosts. */
export const getScenarioApplication = (applicationId: string): RegisteredApplication => {
  const application = applicationsById.get(applicationId)
  if (application !== undefined) return application
  throw new Error(`Unknown scenario application: ${applicationId}`)
}

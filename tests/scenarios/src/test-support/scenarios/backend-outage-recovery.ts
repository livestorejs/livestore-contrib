import { normalizeScenario } from '../../scenario.ts'
import source from './backend-outage-recovery.scenario.ts'

export const backendOutageRecovery = normalizeScenario(source, { id: 'backend-outage-recovery' })

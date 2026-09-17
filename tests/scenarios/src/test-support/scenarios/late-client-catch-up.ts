import { normalizeScenario } from '../../scenario.ts'
import source from './late-client-catch-up.scenario.ts'

export const lateClientCatchUp = normalizeScenario(source, { id: 'late-client-catch-up' })

import { uiSyncLoadScenario } from './ui-sync-load.ts'

export default uiSyncLoadScenario({
  remoteCount: 2000,
  pendingCount: 1000,
  seed: 4002,
  about: 'A reconnecting UI Client rebases 1,000 pending Events over 2,000 remote Events while rendering every todo.',
})

import { uiSyncLoadScenario } from './ui-sync-load.ts'

export default uiSyncLoadScenario({
  remoteCount: 2000,
  pendingCount: 0,
  seed: 4001,
  about: 'A reconnecting UI Client with nothing pending catches up on 2,000 remote Events while rendering every todo.',
})

import { createHash } from 'node:crypto'

import { makeThreadReconciliationWorkflowCore } from './workflow-core.ts'

// The portable reconciliation logic lives in `workflow-core.ts` (node-free);
// this module is the Node binding. Re-exported so the barrel surface and every
// existing importer are unchanged.
export * from './workflow-core.ts'

/**
 * Node binding: receipt digests come from node:crypto sha256 — byte-identical
 * receipt ids with the pre-split implementation.
 */
export const makeThreadReconciliationWorkflow =
  (journal: Parameters<typeof makeThreadReconciliationWorkflowCore>[0], observer: Parameters<
    typeof makeThreadReconciliationWorkflowCore
  >[1]): ReturnType<typeof makeThreadReconciliationWorkflowCore> =>
    makeThreadReconciliationWorkflowCore(journal, observer, {
      receiptDigestHex: (material) => createHash('sha256').update(material).digest('hex').slice(0, 20),
    })

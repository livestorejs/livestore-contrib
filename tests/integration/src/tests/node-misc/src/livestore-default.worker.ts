import { getWorkerArgs, makeWorkerEffect } from '@livestore/adapter-node/worker'
import { PlatformNode } from '@livestore/utils/node'

import { schema } from '../../node-sync/schema.ts'

const { extraArgs } = getWorkerArgs()

if (extraArgs !== undefined) {
  throw new Error('Expected default worker arguments to omit extraArgs')
}

makeWorkerEffect({ schema }).pipe(PlatformNode.NodeRuntime.runMain)

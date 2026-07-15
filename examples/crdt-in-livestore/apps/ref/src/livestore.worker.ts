import { makeWorker } from '@livestore/adapter-web/worker'

import { schema } from './livestore.ts'

makeWorker({ schema })

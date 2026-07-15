import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { plainReferenceArm } from '../harness/src/plain-reference-arm.mjs'
import { validateBenchmarkResult, validateTaxRow } from '../harness/src/results.mjs'
import { generateTrace } from '../harness/src/trace.mjs'
import { executeTrace, runCell } from './runner.mjs'

const baseMetadata = {
  technology: 'loro-test-double',
  crdtName: 'loro-test-double',
  crdtVersion: '1.13.6',
  libraryVersion: '1.13.6',
}

test('executeTrace uses one shared bootstrap snapshot and counts every exact delivery occurrence', async () => {
  let bootstrapCalls = 0
  let decodeCalls = 0
  const arm = {
    ...plainReferenceArm,
    id: 'instrumented-reference',
    bootstrap: async (...arguments_) => {
      bootstrapCalls += 1
      return plainReferenceArm.bootstrap(...arguments_)
    },
    decodeSnapshot: async (...arguments_) => {
      decodeCalls += 1
      return plainReferenceArm.decodeSnapshot(...arguments_)
    },
  }
  const trace = generateTrace({ seed: 'runner-execution', docSizeBytes: 256, editCount: 20, concurrency: 3 })
  const execution = await executeTrace(arm, trace)
  const expectedDeliveries = trace.events.flatMap((event) => event.operationIds ?? [])

  assert.equal(bootstrapCalls, 1)
  assert.equal(decodeCalls, trace.actorIds.length)
  assert.deepEqual(execution.deliveries.map(({ operationId }) => operationId), expectedDeliveries)
})

test('runCell publishes paired schema-valid results, verified evidence, and a schema-valid TAX row', async () => {
  assert.equal(typeof globalThis.gc, 'function', 'test requires --expose-gc')
  const directory = await mkdtemp(join(tmpdir(), 'loro-runner-test-'))
  const outputPath = join(directory, 'cell.json')
  const standaloneArm = benchmarkArm('standalone')
  const embeddedArm = benchmarkArm('embedded')
  const document = await runCell({
    standaloneArm,
    embeddedArm,
    config: { seed: 'runner-cell', docSizeBytes: 256, editCount: 20, concurrency: 2 },
    outputPath,
  })

  assert.deepEqual(validateBenchmarkResult(document.results.standalone), { valid: true, errors: [] })
  assert.deepEqual(validateBenchmarkResult(document.results.embedded), { valid: true, errors: [] })
  assert.deepEqual(validateTaxRow(document.tax), { valid: true, errors: [] })
  assert.equal(document.countability._tag, 'countable')
  assert.equal(document.results.standalone.provenance.trace.deliveryCount, document.results.embedded.provenance.trace.deliveryCount)
  assert.equal(document.results.embedded.embedded.orderingEffect.value.serializedOperationCount, 20)
  assert.equal(document.results.embedded.embedded.logGrowth.checkpoints.at(-1).editCount, 20)
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), document)
})

const benchmarkArm = (axis) => ({
  ...plainReferenceArm,
  id: `loro-test-${axis}`,
  benchmarkable: true,
  benchmarkMetadata: {
    ...baseMetadata,
    axis,
    wireProtocol: {
      boundary: axis === 'embedded' ? 'LiveStore JSON event update bytes' : 'native Loro update bytes',
      encoding: axis === 'embedded' ? 'UTF-8 JSON' : 'native binary',
      framing: 'one update payload per operationId occurrence',
    },
    ...(axis === 'embedded' ? { liveStore: { version: 'test', commit: 'test-commit' } } : {}),
  },
  embeddedEvidence:
    axis === 'embedded'
      ? ({ execution, trace }) => {
          const nativeBytes = [...execution.updates.values()].reduce((total, update) => total + update.byteLength, 0)
          const base64Bytes = Math.ceil(nativeBytes / 3) * 4
          const jsonBytes = base64Bytes + trace.operations.length * 16
          const ordering = trace.operations.map(({ id }) => id)
          return {
            payloadInflation: { nativeBytes, base64Bytes, jsonBytes },
            orderingEffect: {
              _tag: 'measured',
              value: {
                mode: 'single-writer-total-order',
                serializedOperationCount: trace.operations.length,
                evidence: {
                  _tag: 'summary',
                  hash: sha256(JSON.stringify(ordering)),
                  count: ordering.length,
                  reference: 'test://ordering',
                },
              },
            },
            logGrowth: {
              withoutCompaction: true,
              checkpoints: [{ editCount: trace.operations.length, historyBytes: jsonBytes }],
            },
          }
        }
      : undefined,
})

const sha256 = (material) => `sha256:${createHash('sha256').update(material).digest('hex')}`

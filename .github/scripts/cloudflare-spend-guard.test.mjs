import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assessUsage, completedWindow, readConfig } from './cloudflare-spend-guard.mjs'

const payload = (production = 165, account = 201) => ({
  data: {
    viewer: {
      accounts: [{ production: [{ sum: { duration: production } }], account: [{ sum: { duration: account } }] }],
    },
  },
})

test('uses a complete 24-hour window with one hour for reporting', () => {
  assert.deepEqual(completedWindow(Date.parse('2026-11-16T12:37:45Z')), {
    start: '2026-11-15T11:00:00.000Z',
    end: '2026-11-16T11:00:00.000Z',
  })
})

test('passes the measured fixed baseline and fails the former always-on production usage', () => {
  assert.equal(assessUsage(payload()).healthy, true)
  assert.equal(assessUsage(payload(11048, 11200)).healthy, false)
  assert.equal(assessUsage(payload(501, 600)).healthy, false)
  assert.equal(assessUsage(payload(165, 1001)).healthy, false)
  assert.equal(assessUsage(payload(500, 1000)).healthy, true)
  assert.equal(assessUsage(payload(), 1).healthy, false)
})

test('never reports healthy for API errors, missing samples or invalid meter values', () => {
  for (const value of [
    undefined,
    {},
    { errors: [{ message: 'denied' }], ...payload() },
    { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [{ production: [], account: [] }] } } },
    { errors: {}, ...payload() },
    payload(undefined, null),
    payload(-1, 200),
    payload(Number.NaN, 200),
    payload(165, 100),
  ])
    assert.throws(() => assessUsage(value))
})

test('fails before an API call when credentials or identity are missing', () => {
  assert.throws(() => readConfig({}))
  assert.throws(() => readConfig({ CLOUDFLARE_API_TOKEN: 'redacted', CLOUDFLARE_ACCOUNT_ID: 'invalid' }))
})

test('allows a lower verification threshold but refuses to raise the scheduled guard', () => {
  const env = {
    CLOUDFLARE_API_TOKEN: 'redacted',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CF_BOT_STATE_NAMESPACE_ID: 'b'.repeat(32),
  }
  assert.equal(readConfig({ ...env, CF_PRODUCTION_DURATION_LIMIT: '1' }).productionLimit, 1)
  for (const value of ['0', '-1', 'NaN', '501'])
    assert.throws(() => readConfig({ ...env, CF_PRODUCTION_DURATION_LIMIT: value }))
})

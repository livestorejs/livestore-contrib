import { setTimeout } from 'node:timers/promises'

const { CF_WORKER_URL, RELEASE_ID, EXPECTED_WORKER_VERSION } = process.env
if (
  [CF_WORKER_URL, RELEASE_ID, EXPECTED_WORKER_VERSION].some((value) => value === undefined || value === '') === true
) {
  throw new Error('CF_WORKER_URL, RELEASE_ID, and EXPECTED_WORKER_VERSION are required')
}
const url = new URL('/readyz', CF_WORKER_URL)
if (url.protocol !== 'https:') throw new Error('CF_WORKER_URL must use HTTPS')

const checks = ['journalCurrent', 'supervisorReady', 'sessionPresent', 'gatewayHealthy', 'errorFree']
const observe = async (timeoutMs, accept) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(5_000, remaining)) })
      if (
        (response.status === 200 || response.status === 503) &&
        accept(response.status, await response.json()) === true
      ) {
        return true
      }
    } catch (error) {
      console.log('Gateway probe failed:', error instanceof Error ? error.message : String(error))
    }
    await setTimeout(Math.min(5_000, Math.max(0, deadline - Date.now())))
  }
  return false
}

const adopted = (report) => report?.workerVersionId === EXPECTED_WORKER_VERSION && report.releaseId === RELEASE_ID
// Cloudflare can defer an active DO update by up to 300 seconds. Allow time
// for adoption to become observable, then start the existing readiness budget.
if ((await observe(420_000, (_status, report) => adopted(report))) === false) {
  throw new Error('Gateway did not adopt the deployed Cloudflare version within 420 seconds')
}
console.log('Gateway adopted deployed version', EXPECTED_WORKER_VERSION)
if (
  (await observe(
    120_000,
    (status, report) =>
      status === 200 &&
      adopted(report) === true &&
      report.ready === true &&
      checks.every((key) => report.checks?.[key] === true),
  )) === false
) {
  throw new Error('Gateway did not become ready within 120 seconds of adoption')
}
console.log('Gateway ready at expected release', RELEASE_ID)

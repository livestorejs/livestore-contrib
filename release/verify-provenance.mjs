import { setTimeout as delay } from 'node:timers/promises'

export class PendingRegistryVerification extends Error {}

export const waitForRegistryVerification = async (
  verify,
  { attempts = 21, timeoutMs = 300_000, wait = delay } = {},
) => {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await verify()
    } catch (error) {
      if (!(error instanceof PendingRegistryVerification)) throw error
      const remainingMs = deadline - Date.now()
      if (attempt === attempts || remainingMs <= 0) {
        throw new Error(`Registry verification did not converge: ${error.message}`, { cause: error })
      }
      const delayMs = Math.min(attempt * 5_000, 15_000, remainingMs)
      console.log(`${error.message}; retrying in ${delayMs / 1_000}s (${attempt}/${attempts})`)
      await wait(delayMs)
    }
  }
}

export const verifyProvenance = async (pkg, metadata, fetchAttestation = fetch) => {
  const label = `${pkg.name}@${pkg.version}`
  const attestations = metadata?.dist?.attestations
  if (
    attestations !== undefined &&
    (attestations === null || typeof attestations !== 'object' || Array.isArray(attestations))
  ) {
    throw new Error(`${label} has malformed npm provenance metadata`)
  }
  if (attestations === undefined || attestations.provenance === undefined || attestations.url === undefined) {
    throw new PendingRegistryVerification(`${label} is missing npm provenance attestation metadata`)
  }
  if (
    attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
    typeof attestations.url !== 'string' ||
    !attestations.url.startsWith('https://registry.npmjs.org/-/npm/v1/attestations/')
  ) {
    throw new Error(`${label} has malformed npm provenance metadata or an unexpected endpoint`)
  }
  const response = await fetchAttestation(attestations.url, { signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) throw new PendingRegistryVerification(`${label} provenance endpoint returned HTTP 404`)
  if (!response.ok) throw new Error(`Cannot retrieve provenance for ${label}: HTTP ${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body?.attestations)) throw new Error(`${label} has a malformed npm attestation response`)
  if (
    body.attestations.some(
      (entry) => entry === null || typeof entry !== 'object' || typeof entry.predicateType !== 'string',
    )
  ) {
    throw new Error(`${label} has a malformed npm attestation response`)
  }
  const provenance = body.attestations.find((entry) => entry?.predicateType === 'https://slsa.dev/provenance/v1')
  for (const value of [provenance?.bundle, provenance?.bundle?.dsseEnvelope]) {
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`${label} has a malformed provenance bundle`)
    }
  }
  const payload = provenance?.bundle?.dsseEnvelope?.payload
  if (payload === undefined || payload === '') {
    throw new PendingRegistryVerification(`${label} provenance attestation is missing from the registry bundle`)
  }
  if (typeof payload !== 'string') throw new Error(`${label} has a malformed provenance payload`)
}

export const verifyProvenance = async (pkg, metadata, fetchAttestation = fetch) => {
  const attestations = metadata?.dist?.attestations
  if (
    attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
    typeof attestations?.url !== 'string' ||
    !attestations.url.startsWith('https://registry.npmjs.org/-/npm/v1/attestations/')
  ) {
    throw new Error(`${pkg.name}@${pkg.version} is missing npm provenance attestation metadata`)
  }
  const response = await fetchAttestation(attestations.url)
  if (!response.ok)
    throw new Error(`Cannot retrieve provenance for ${pkg.name}@${pkg.version}: HTTP ${response.status}`)
  const body = await response.json()
  const provenance = body.attestations?.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1')
  if (!provenance?.bundle?.dsseEnvelope?.payload) {
    throw new Error(`${pkg.name}@${pkg.version} provenance attestation is missing from the registry bundle`)
  }
}

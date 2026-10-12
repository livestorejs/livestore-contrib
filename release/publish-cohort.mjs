export const publishCohort = async ({ packed, isPublished, preflightExisting, publishPackage, verifyPackage }) => {
  const existingNames = new Set()
  // Complete the entire immutable-artifact preflight before the first irreversible publish.
  for (const candidate of packed) {
    if (await isPublished(candidate.pkg)) {
      await preflightExisting(candidate)
      existingNames.add(candidate.pkg.name)
    }
  }
  for (const candidate of packed) {
    if (!existingNames.has(candidate.pkg.name)) await publishPackage(candidate)
  }
  const verifiedMetadata = new Map()
  for (const candidate of packed) {
    const metadata = await verifyPackage(candidate, { newlyPublished: !existingNames.has(candidate.pkg.name) })
    verifiedMetadata.set(candidate.pkg.name, metadata)
  }
  return verifiedMetadata
}

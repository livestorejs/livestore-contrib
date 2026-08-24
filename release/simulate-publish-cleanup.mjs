/** Restore temporary pack rewrites while keeping a successfully published release projection intact. */
export const cleanupPackedRun = ({ publish, restoreManifests, restoreGeneratedProjection }) => {
  restoreManifests()
  if (publish === false) restoreGeneratedProjection()
}

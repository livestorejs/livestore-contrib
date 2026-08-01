export interface SourceRevisionDisplay {
  readonly compact: string
  readonly detail: string
}

const liveStoreSourceRevision = /^livestore@([0-9a-f]{7,64})(?:\+dirty\.([0-9a-f]{7,64}))?$/i
const gitRevision = /^[0-9a-f]{7,64}$/i

export const displaySourceRevision = (sourceRevision: string): SourceRevisionDisplay => {
  const liveStoreMatch = liveStoreSourceRevision.exec(sourceRevision)
  if (liveStoreMatch !== null) {
    const commit = liveStoreMatch[1] ?? sourceRevision
    const dirtyHash = liveStoreMatch[2]
    return {
      compact: `${commit.slice(0, 8)}${dirtyHash === undefined ? '' : '+dirty'}`,
      detail: `LiveStore source ${commit}${dirtyHash === undefined ? '' : ` · dirty ${dirtyHash}`}`,
    }
  }

  if (gitRevision.test(sourceRevision) === true) {
    return {
      compact: sourceRevision.slice(0, 8),
      detail: `LiveStore source ${sourceRevision}`,
    }
  }

  const readableRevision = sourceRevision === 'working-tree' ? 'working tree' : sourceRevision
  return {
    compact: truncate(readableRevision, 24),
    detail: `LiveStore source ${readableRevision}`,
  }
}

const truncate = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length - 1)}…`

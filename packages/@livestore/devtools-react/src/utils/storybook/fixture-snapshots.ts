import type { ReactiveGraph } from '@livestore/livestore/internal'

type SyntheticPreviousResult = { _tag: 'Some'; value: string } | { _tag: 'None' }

type SyntheticAtom = {
  _tag: 'thunk' | 'ref'
  id: string
  label: string
  meta?: { liveStoreThunkType: string }
  isDirty: boolean
  sub: string[]
  super: string[]
  isDestroyed: boolean
  previousResult: SyntheticPreviousResult
  recomputations?: number
  refreshes?: number
}

type SyntheticEffect = {
  _tag: 'effect'
  id: string
  label: string
  sub: string[]
  isDestroyed: boolean
  invocations: number
}

type SyntheticNode = SyntheticAtom | SyntheticEffect

type SyntheticSnapshotConfig = {
  fixture: number
  seed: number
  atoms: number
  thunks: number
  effects: number
  edges: number
  connectedSources: number
  connectedTargets: number
  maxFanIn: number
  maxFanOut: number
  dirtyAtoms: number
  stringResults: number
  recomputedThunks: number
  refreshedRefs: number
}

const addSyntheticEdges = ({
  nodes,
  atomCount,
  edgeCount,
  connectedSources,
  connectedTargets,
  maxFanIn,
  maxFanOut,
  seed,
}: {
  nodes: SyntheticNode[]
  atomCount: number
  edgeCount: number
  connectedSources: number
  connectedTargets: number
  maxFanIn: number
  maxFanOut: number
  seed: number
}): void => {
  const sourceIndexes = Array.from(
    { length: connectedSources },
    (_, index) => nodes.length - connectedSources + index,
  )
  const targetIndexes = Array.from({ length: connectedTargets }, (_, index) => index)
  const edges = new Set<string>()
  const fanIn = Array.from({ length: nodes.length }, () => 0)
  const fanOut = Array.from({ length: nodes.length }, () => 0)

  const addEdge = (sourceIndex: number, targetIndex: number): boolean => {
    const key = `${sourceIndex}:${targetIndex}`
    if (
      sourceIndex <= targetIndex ||
      targetIndex >= atomCount ||
      edges.has(key) ||
      fanIn[targetIndex]! >= maxFanIn ||
      fanOut[sourceIndex]! >= maxFanOut
    ) {
      return false
    }

    edges.add(key)
    fanIn[targetIndex]! += 1
    fanOut[sourceIndex]! += 1
    nodes[sourceIndex]!.sub.push(nodes[targetIndex]!.id)
    ;(nodes[targetIndex] as SyntheticAtom).super.push(nodes[sourceIndex]!.id)
    return true
  }

  // Make the intended high-fan-in and high-fan-out cases explicit so the graph
  // view continues to exercise crowded dependency rows.
  for (const sourceIndex of sourceIndexes.slice(-maxFanIn)) {
    addEdge(sourceIndex, targetIndexes[0]!)
  }
  for (const targetIndex of targetIndexes.slice(0, maxFanOut)) {
    addEdge(sourceIndexes.at(-1)!, targetIndex)
  }

  // Every selected target has a dependent and every selected source has a
  // dependency. Rotating by the fixture seed gives the five stories distinct,
  // deliberately constructed topologies.
  for (const [targetOffset, targetIndex] of targetIndexes.entries()) {
    if (fanIn[targetIndex]! > 0) continue
    const candidateGroups = [
      sourceIndexes.filter((sourceIndex) => fanOut[sourceIndex] === 0),
      sourceIndexes.filter((sourceIndex) => fanOut[sourceIndex]! > 0),
    ]
    let added = false
    for (const sourceCandidates of candidateGroups) {
      for (let offset = 0; offset < sourceCandidates.length; offset++) {
        const sourceIndex =
          sourceCandidates[(targetOffset + offset + seed) % sourceCandidates.length]!
        if (addEdge(sourceIndex, targetIndex)) {
          added = true
          break
        }
      }
      if (added) break
    }
  }

  for (const [sourceOffset, sourceIndex] of sourceIndexes.entries()) {
    if (fanOut[sourceIndex]! > 0) continue
    for (let offset = 0; offset < targetIndexes.length; offset++) {
      const targetIndex = targetIndexes[(sourceOffset + offset + seed) % targetIndexes.length]!
      if (addEdge(sourceIndex, targetIndex)) break
    }
  }

  for (let round = 0; edges.size < edgeCount; round++) {
    let addedInRound = false
    for (const [sourceOffset, sourceIndex] of sourceIndexes.entries()) {
      const targetIndex = targetIndexes[(sourceOffset * 7 + round * 11 + seed) % targetIndexes.length]!
      if (addEdge(sourceIndex, targetIndex)) addedInRound = true
      if (edges.size === edgeCount) break
    }

    if (!addedInRound) {
      throw new Error('Synthetic reactive-graph configuration cannot satisfy its edge constraints')
    }
  }
}

const makeSyntheticSnapshot = (
  config: SyntheticSnapshotConfig,
): ReactiveGraph.ReactiveGraphSnapshot => {
  const refCount = config.atoms - config.thunks
  const nodes: SyntheticNode[] = []

  for (let index = 0; index < config.atoms; index++) {
    const isThunk = index < config.thunks
    const updateIndex = isThunk ? index : index - config.thunks
    const previousResult: SyntheticPreviousResult =
      index < config.stringResults
        ? {
            _tag: 'Some',
            value: JSON.stringify({
              fixture: `synthetic-${config.fixture}`,
              node: index + 1,
              status: index % 2 === 0 ? 'ready' : 'pending',
              endpoint: 'https://example.com/devtools-fixture',
              records: [{ id: `example-record-${config.fixture}-${index + 1}`, value: index * 10 }],
            }),
          }
        : { _tag: 'None' }

    nodes.push(
      isThunk
        ? {
            _tag: 'thunk',
            id: `node-${config.fixture}-${index + 1}`,
            label: `SyntheticQuery${config.fixture}:${index + 1}`,
            meta: {
              liveStoreThunkType: index % 2 === 0 ? 'synthetic.query' : 'synthetic.result',
            },
            isDirty: index < config.dirtyAtoms,
            sub: [],
            super: [],
            isDestroyed: false,
            recomputations:
              updateIndex === 0 ? 4 : updateIndex < config.recomputedThunks ? 1 : 0,
            previousResult,
          }
        : {
            _tag: 'ref',
            id: `node-${config.fixture}-${index + 1}`,
            label: `SyntheticSignal${config.fixture}:${updateIndex + 1}`,
            isDirty: index < config.dirtyAtoms,
            sub: [],
            super: [],
            isDestroyed: false,
            refreshes: updateIndex === 0 ? 3 : updateIndex < config.refreshedRefs ? 1 : 0,
            previousResult,
          },
    )
  }

  for (let index = 0; index < config.effects; index++) {
    nodes.push({
      _tag: 'effect',
      id: `node-${config.fixture}-${config.atoms + index + 1}`,
      label: `SyntheticObserver${config.fixture}:${index + 1}`,
      sub: [],
      isDestroyed: false,
      invocations: index === 0 ? 4 : 1,
    })
  }

  addSyntheticEdges({
    nodes,
    atomCount: config.atoms,
    edgeCount: config.edges,
    connectedSources: config.connectedSources,
    connectedTargets: config.connectedTargets,
    maxFanIn: config.maxFanIn,
    maxFanOut: config.maxFanOut,
    seed: config.seed,
  })

  const atoms = nodes.slice(0, config.atoms) as SyntheticAtom[]
  const effects = nodes.slice(config.atoms) as SyntheticEffect[]
  const actualEdges = nodes.reduce((total, node) => total + node.sub.length, 0)
  const actualSources = nodes.filter((node) => node.sub.length > 0).length
  const actualTargets = atoms.filter((node) => node.super.length > 0).length
  const actualMaxFanIn = Math.max(...atoms.map((node) => node.super.length))
  const actualMaxFanOut = Math.max(...nodes.map((node) => node.sub.length))

  if (
    atoms.length !== config.atoms ||
    effects.length !== config.effects ||
    atoms.filter((node) => node._tag === 'thunk').length !== config.thunks ||
    atoms.filter((node) => node._tag === 'ref').length !== refCount ||
    actualEdges !== config.edges ||
    actualSources !== config.connectedSources ||
    actualTargets !== config.connectedTargets ||
    actualMaxFanIn !== config.maxFanIn ||
    actualMaxFanOut !== config.maxFanOut
  ) {
    throw new Error(
      `Synthetic reactive-graph fixture ${config.fixture} does not match its declared shape: ` +
        JSON.stringify({
          atoms: atoms.length,
          effects: effects.length,
          edges: actualEdges,
          sources: actualSources,
          targets: actualTargets,
          maxFanIn: actualMaxFanIn,
          maxFanOut: actualMaxFanOut,
        }),
    )
  }

  return { atoms, effects } as unknown as ReactiveGraph.ReactiveGraphSnapshot
}

export const testNodes = makeSyntheticSnapshot({
  fixture: 1,
  seed: 3,
  atoms: 68,
  thunks: 37,
  effects: 49,
  edges: 110,
  connectedSources: 74,
  connectedTargets: 54,
  maxFanIn: 13,
  maxFanOut: 10,
  dirtyAtoms: 17,
  stringResults: 62,
  recomputedThunks: 31,
  refreshedRefs: 2,
})

export const testNodes2 = makeSyntheticSnapshot({
  fixture: 2,
  seed: 7,
  atoms: 66,
  thunks: 35,
  effects: 46,
  edges: 98,
  connectedSources: 69,
  connectedTargets: 50,
  maxFanIn: 13,
  maxFanOut: 10,
  dirtyAtoms: 17,
  stringResults: 58,
  recomputedThunks: 27,
  refreshedRefs: 2,
})

export const testNodes3 = makeSyntheticSnapshot({
  fixture: 3,
  seed: 13,
  atoms: 68,
  thunks: 37,
  effects: 49,
  edges: 110,
  connectedSources: 74,
  connectedTargets: 54,
  maxFanIn: 13,
  maxFanOut: 10,
  dirtyAtoms: 17,
  stringResults: 62,
  recomputedThunks: 31,
  refreshedRefs: 2,
})

export const testNodes4 = makeSyntheticSnapshot({
  fixture: 4,
  seed: 17,
  atoms: 68,
  thunks: 37,
  effects: 230,
  edges: 286,
  connectedSources: 255,
  connectedTargets: 54,
  maxFanIn: 196,
  maxFanOut: 10,
  dirtyAtoms: 15,
  stringResults: 0,
  recomputedThunks: 31,
  refreshedRefs: 2,
})

export const testNodes5 = makeSyntheticSnapshot({
  fixture: 5,
  seed: 23,
  atoms: 66,
  thunks: 35,
  effects: 227,
  edges: 277,
  connectedSources: 250,
  connectedTargets: 51,
  maxFanIn: 196,
  maxFanOut: 10,
  dirtyAtoms: 15,
  stringResults: 0,
  recomputedThunks: 29,
  refreshedRefs: 4,
})

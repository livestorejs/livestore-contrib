/* eslint-disable react-perf/jsx-no-new-function-as-prop -- Fixture render props intentionally bind the asynchronously loaded artifact. */
import { useEffect, useState, type ReactNode } from 'react'

import type { ScenarioRunArtifact } from '../../model.ts'
import { decodeArtifactJson, fetchArtifactJson } from '../../viewer/artifact-io.ts'

export type ReferenceArtifactName =
  | 'reference-browser-multi-session-recovery-browser.json.gz'
  | 'reference-offline-writer-recovery-browser-failure.json.gz'
  | 'reference-shared-todo-workday-browser-failure.json.gz'

const cache = new Map<ReferenceArtifactName, Promise<ScenarioRunArtifact>>()

export const loadReferenceArtifact = (name: ReferenceArtifactName): Promise<ScenarioRunArtifact> => {
  const existing = cache.get(name)
  if (existing !== undefined) return existing
  const loading = fetchArtifactJson(name).then(decodeArtifactJson)
  cache.set(name, loading)
  return loading
}

export const ReferenceFixture = ({
  name,
  children,
}: {
  readonly name: ReferenceArtifactName
  readonly children: (artifact: ScenarioRunArtifact) => ReactNode
}) => {
  const [artifact, setArtifact] = useState<ScenarioRunArtifact>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    void loadReferenceArtifact(name)
      .then((loaded) => {
        if (active === true) setArtifact(loaded)
      })
      .catch((cause: unknown) => {
        if (active === true) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [name])
  if (error !== undefined) return <div className="empty-state">{error}</div>
  if (artifact === undefined) return <div className="empty-state">Loading reference artifact…</div>
  return children(artifact)
}

import { type ReactNode, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { queryDb, type Store } from '@livestore/livestore'
import { useQuery } from '@livestore/react'

import { todosTable } from '../../../corpus/applications/todo.ts'

/**
 * A small application UI over the Scenario state, so frame measurements include what a real React app pays when
 * LiveStore refreshes queries: query reruns, React renders and DOM updates. Views are keyed by application ID and
 * stay in the browser fixture, so the Node hosts never load React.
 */
export const mountScenarioApp = (args: {
  readonly applicationId: string
  readonly store: Store
  readonly label: string
}): { readonly unmount: () => void } => {
  const container = document.querySelector('#app')
  if (container === null) throw new Error('Browser fixture is missing #app')
  const root: Root = createRoot(container)
  const View = applicationViews[args.applicationId] ?? NoApplicationView
  root.render(
    <main>
      <header>
        <strong>{args.label}</strong> <FpsMeter />
      </header>
      <View store={args.store} />
    </main>,
  )
  return { unmount: () => root.unmount() }
}

type ApplicationView = (props: { readonly store: Store }) => ReactNode

const NoApplicationView: ApplicationView = () => <p>No UI for this application.</p>

/** Number of independent aggregate queries next to the list. Each reruns when a refresh touches `todos`. */
const BUCKET_COUNT = 8

const allTodos$ = queryDb(todosTable.orderBy('id', 'asc'), { label: 'ui:todos' })
const completedCount$ = queryDb(todosTable.count().where({ completed: true }), { label: 'ui:completed' })
const bucketCounts$ = Array.from({ length: BUCKET_COUNT }, (_, bucket) =>
  queryDb(todosTable.count().where({ id: { op: 'LIKE', value: `%${bucket}` } }), { label: `ui:bucket-${bucket}` }),
)

const TodoView: ApplicationView = ({ store }) => {
  const todos = useQuery(allTodos$, { store })
  const completed = useQuery(completedCount$, { store })
  return (
    <section>
      <p>
        {todos.length} todos · {completed} completed
      </p>
      <p>
        {bucketCounts$.map((query, bucket) => (
          <BucketCount key={bucket} bucket={bucket} query={query} store={store} />
        ))}
      </p>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <input type="checkbox" checked={todo.completed} readOnly /> {todo.text}
          </li>
        ))}
      </ul>
    </section>
  )
}

const BucketCount = (props: {
  readonly bucket: number
  readonly query: (typeof bucketCounts$)[number]
  readonly store: Store
}) => {
  const count = useQuery(props.query, { store: props.store })
  return (
    <span>
      {' '}
      *{props.bucket}: {count}
    </span>
  )
}

const applicationViews: Readonly<Record<string, ApplicationView>> = {
  'scenario-todo-app': TodoView,
}

/** Visible frame rate for headed runs; the measured numbers come from the frame monitor, not from this meter. */
const FpsMeter = () => {
  const [fps, setFps] = useState(0)
  useEffect(() => {
    let frames = 0
    let handle = requestAnimationFrame(function count() {
      frames += 1
      handle = requestAnimationFrame(count)
    })
    const interval = setInterval(() => {
      setFps(frames * 2)
      frames = 0
    }, 500)
    return () => {
      cancelAnimationFrame(handle)
      clearInterval(interval)
    }
  }, [])
  return <span>· {fps} fps</span>
}

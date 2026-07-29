// TODO this file is currently not used / working properly as we'd need to mock the devtools bridge
// in order to actually hook up the correct mock data
import { makeSchema, State } from '@livestore/livestore'
import type { Meta, StoryObj } from '@storybook/react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'

// import type { DevtoolsBridge } from '../adapter-bridges/devtools-bridge.js'
import { RootContext } from '../root-context.js'
import { routeTree } from '../routeTree.gen.js'
import { ClientSessionList } from './ClientSessionList.js'

const memoryHistory = createMemoryHistory({ initialEntries: ['/web/not-found'] })

const router = createRouter({ routeTree, history: memoryHistory })

const appSchema = makeSchema({
  events: {},
  state: State.SQLite.makeState({ tables: [], materializers: {} }),
})

// const makeMockBridge = (): DevtoolsBridge => {
//   return {
//     connect: () => Effect.dieMessage('Not implemented'),
//     clientLeaderSessionId: Subscribable.make({
//       get: Effect.succeed(Option.none()),
//       changes: Stream.never,
//     }),
//     clientSessions: Subscribable.make({
//       get: Effect.succeed(new Set()),
//       changes: Stream.never,
//     }),
//     copyToClipboard: () => Effect.dieMessage('Not implemented'),
//     sendEscapeKey: Effect.dieMessage('Not implemented'),
//   }
// }

const meta: Meta<typeof ClientSessionList> = {
  title: 'Application Routes/ClientSessionList',
  component: ClientSessionList,
  parameters: {
    backgrounds: { default: 'dark' },
  },
  decorators: [
    (Story) => (
      <div className="h-full bg-devtools-background">
        <RouterProvider
          router={router}
          InnerWrap={({ children }) => (
            <RootContext
              value={{
                appSchemas: [appSchema],
                mode: undefined,
                license: undefined,
                options: undefined,
                sharedWorker: {} as any,
                mountPath: '/',
                triggerReload: () => window.location.reload(),
              }}
            >
              {children}
            </RootContext>
          )}
          defaultNotFoundComponent={() => <Story />}
          // defaultComponent={() => <Story />}
        />
      </div>
    ),
  ],
} satisfies Meta<typeof ClientSessionList>

export default meta

const defineStory = (story: StoryObj<Meta<typeof ClientSessionList>>) => story

export const Basic: StoryObj<typeof meta> = defineStory({
  args: {
    clientSessions: [
      {
        storeId: 'store1',
        clientId: 'client1',
        sessionId: 'session1',
      },
      {
        storeId: 'store1',
        clientId: 'client2',
        sessionId: 'session2',
      },
    ],
  },
})

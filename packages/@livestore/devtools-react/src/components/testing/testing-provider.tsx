import { makeInMemoryAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { Devtools, liveStoreVersion, provideOtel } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import type { Store } from '@livestore/livestore'
import {
  createStore,
  EventSequenceNumber,
  makeSchema,
  Schema,
  SessionIdSymbol,
  State,
  StoreInternalsSymbol,
} from '@livestore/livestore'
import type { ReactiveGraph } from '@livestore/livestore/internal'
import { shouldNeverHappen } from '@livestore/utils'
import { Effect, HashSet, Stream, Subscribable, SubscriptionRef } from '@livestore/utils/effect'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type React from 'react'

import type { DevtoolsApi, DevtoolsApiSession } from '../../devtools-api.js'
import { tables } from '../../livestore/tables.js'
import { RootContext } from '../../root-context.js'
import { routeTree } from '../../routeTree.gen.js'
import { ThemeProvider } from '../../theme/mod.js'

/**
 * DevTools tab configuration for type-safe routing
 */
export interface TabConfig {
  /** Main tab to display */
  tab: 'database' | 'queries' | 'events' | 'sync' | 'general'
  /** Sub-tab for queries tab */
  queriesSubtab?: 'live-queries' | 'slow-queries' | 'reactivity-graph'
  /** Tab-specific state configuration */
  tabState?: {
    /** For database tab: expand LiveStore internals section */
    livestoreInternalsExpanded?: boolean
    /** For database tab: which tables to show as expanded */
    expandedTables?: string[]
    /** Custom tab index override */
    tabIndex?: number
    /** Custom queries sub-tab index override */
    queriesTabIndex?: number
  }
}

/**
 * Configuration for the testing provider
 */
export interface TestingConfig {
  /** Static snapshot for signalSnapshots() */
  snapshot?: ReactiveGraph.ReactiveGraphSnapshot
  /** Override for copyToClipboard behavior */
  copyToClipboard?: (text: string) => Effect.Effect<void>
  /** Custom store/client configuration */
  storeConfig?: {
    storeId?: string
    clientId?: string
    sessionId?: string
    schemaAlias?: string
  }
  /** Initial route path (overrides tabConfig) */
  initialRoute?: string
  /** Type-safe tab configuration */
  tabConfig?: TabConfig
  /** Custom app schemas */
  appSchemas?: ReadonlyArray<LiveStoreSchema>
  /** Override specific API session methods */
  apiSessionOverrides?: Partial<DevtoolsApiSession>
  /** Override specific API methods */
  apiOverrides?: Partial<DevtoolsApi>
}

/**
 * Creates a comprehensive testing decorator for all LiveStore DevTools components.
 *
 * Always includes:
 * - RouterProvider with memory history
 * - Real in-memory store with sync simulation
 * - Live queries data
 * - Multiple client sessions
 * - Full DevtoolsApi implementation
 *
 * @param config Configuration for the testing environment
 * @returns Storybook decorator function
 */
export const createTestingDecorator = (config: TestingConfig = {}) => {
  const {
    snapshot,
    copyToClipboard = () => Effect.die(new Error('Not implemented: copyToClipboard')),
    storeConfig = {},
    initialRoute,
    tabConfig,
    appSchemas = [],
    apiSessionOverrides = {},
    apiOverrides = {},
  } = config

  // Store configuration
  const storeId = storeConfig.storeId ?? 'storeId'
  const clientId = storeConfig.clientId ?? 'clientIdA'
  const sessionId = storeConfig.sessionId ?? 'sessionId1'
  const schemaAlias = storeConfig.schemaAlias ?? 'default'

  // Router configuration - prioritize explicit initialRoute, then tabConfig, then default
  const defaultRoute = `/mock/${storeId}/${clientId}/${sessionId}/${schemaAlias}`

  let computedRoute = defaultRoute
  if (initialRoute) {
    computedRoute = initialRoute
  } else if (tabConfig) {
    // Use base route since tab state is handled via LiveStore state, not URL
    computedRoute = defaultRoute
  }

  const memoryHistory = createMemoryHistory({
    initialEntries: [computedRoute],
  })

  // Create comprehensive app schema with multiple table types
  const userTable = State.SQLite.table({
    name: 'user',
    columns: {
      id: State.SQLite.text(),
      name: State.SQLite.text(),
      email: State.SQLite.text(),
      createdAt: State.SQLite.integer(),
      isActive: State.SQLite.integer(), // boolean as integer
    },
  })

  const postTable = State.SQLite.table({
    name: 'post',
    columns: {
      id: State.SQLite.text(),
      userId: State.SQLite.text(),
      title: State.SQLite.text(),
      content: State.SQLite.text(),
      publishedAt: State.SQLite.integer(),
      status: State.SQLite.text(), // 'draft' | 'published' | 'archived'
    },
  })

  const commentTable = State.SQLite.table({
    name: 'comment',
    columns: {
      id: State.SQLite.text(),
      postId: State.SQLite.text(),
      userId: State.SQLite.text(),
      content: State.SQLite.text(),
      createdAt: State.SQLite.integer(),
    },
  })

  // Client document schemas
  const UserPreferencesSchema = Schema.Struct({
    userId: Schema.String,
    theme: Schema.Literals(['light', 'dark', 'auto']),
    language: Schema.String,
    notificationsEnabled: Schema.Boolean,
    lastLoginAt: Schema.Finite,
    searchFilter: Schema.optional(Schema.String.check(Schema.isMinLength(3))),
    volumeLevel: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  })

  const SessionDataSchema = Schema.Struct({
    sessionId: Schema.String,
    currentPage: Schema.String,
    scrollPosition: Schema.Finite,
    selectedItems: Schema.String, // JSON string of selected IDs
    filters: Schema.String, // JSON string of active filters
    lastActiveAt: Schema.Finite,
  })

  // Client document tables (for per-client state)
  const userPreferencesClientDoc = State.SQLite.clientDocument({
    name: 'user_preferences',
    schema: UserPreferencesSchema,
    default: {
      value: {
        userId: 'user-1',
        theme: 'dark' as const,
        language: 'en',
        notificationsEnabled: true,
        lastLoginAt: Date.now(),
        searchFilter: 'news',
        volumeLevel: 5,
      },
      id: SessionIdSymbol,
    },
  })

  const sessionDataClientDoc = State.SQLite.clientDocument({
    name: 'session_data',
    schema: SessionDataSchema,
    default: {
      value: {
        sessionId: sessionId,
        currentPage: '/posts',
        scrollPosition: 0,
        selectedItems: '[]',
        filters: '{}',
        lastActiveAt: Date.now(),
      },
      id: SessionIdSymbol,
    },
  })

  const appSchema = makeSchema({
    events: {
      userPreferencesSet: userPreferencesClientDoc.set,
    },
    state: State.SQLite.makeState({
      tables: [
        userTable,
        postTable,
        commentTable,
        userPreferencesClientDoc,
        sessionDataClientDoc,
        // All DevTools schemas (using originals, will set values via commit)
        tables.stateSchemaTabsContainer,
        tables.stateSchemaQueriesTab,
        tables.dataBrowserStaticSchema,
        tables.eventlogBrowserSchema,
        tables.dataBrowserDynamicSchema,
        tables.stateSchemaLiveQueriesTab,
        tables.networkState,
        tables.sqlitePlaygroundState,
        tables.stateSchemaAtomsTab,
      ],
      materializers: {},
    }),
  })

  const router = createRouter({ routeTree, history: memoryHistory })

  // Client info setup
  const clientInfo = Devtools.SessionInfo.SessionInfo.make({
    storeId,
    clientId,
    sessionId,
    schemaAlias,
    isLeader: true,
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  })

  const otherClientInfo1 = Devtools.SessionInfo.SessionInfo.make({
    storeId,
    clientId: 'clientIdA',
    sessionId: 'sessionId2',
    schemaAlias,
    isLeader: false,
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  })

  const otherClientInfo2 = Devtools.SessionInfo.SessionInfo.make({
    storeId,
    clientId: 'clientIdA',
    sessionId: 'sessionId3',
    schemaAlias,
    isLeader: false,
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  })

  const onBoot = (store: Store) => {
    // Set tab state based on tabConfig using the API you suggested
    if (tabConfig) {
      const tabMapping = { database: 0, queries: 1, events: 2, sync: 3, general: 4 }
      const targetTabIndex = tabConfig.tabState?.tabIndex ?? tabMapping[tabConfig.tab]

      store.commit(
        tables.stateSchemaTabsContainer.set({
          tabIndex: targetTabIndex,
          showMeters: true,
        }),
      )

      // Set queries sub-tab if specified
      if (tabConfig.tab === 'queries' && tabConfig.queriesSubtab) {
        const queriesTabMapping = { 'live-queries': 0, 'slow-queries': 1, 'reactivity-graph': 2 }
        const targetQueriesTabIndex =
          tabConfig.tabState?.queriesTabIndex ?? queriesTabMapping[tabConfig.queriesSubtab]

        store.commit(
          tables.stateSchemaQueriesTab.set({
            tabIndex: targetQueriesTabIndex,
          }),
        )
      }

      // Set database tab state if specified
      if (
        tabConfig.tab === 'database' &&
        tabConfig.tabState?.livestoreInternalsExpanded !== undefined
      ) {
        store.commit(
          tables.dataBrowserStaticSchema.set({
            activeTableName:
              tabConfig.tabState?.expandedTables?.[0] ?? SystemTables.SCHEMA_META_TABLE,
            livestoreInternalsExpanded: tabConfig.tabState.livestoreInternalsExpanded,
          }),
        )
      }
    }
  }

  const makeDevtoolsApi = (): DevtoolsApi => {
    return {
      connect: Effect.fn(function* (clientInfo) {
        const leaderEventSequenceNumberSubRef = yield* SubscriptionRef.make(
          EventSequenceNumber.Client.Composite.make({ global: 0, client: 0 }),
        )
        const syncBackendEventSequenceNumberSubRef = yield* SubscriptionRef.make(
          EventSequenceNumber.Global.make(0),
        )
        const eventInputSchema = LiveStoreEvent.Input.makeSchema(appSchema)
        const eventClientSchema = LiveStoreEvent.Client.makeSchemaMemo(appSchema)

        const mockStore = yield* createStore({
          adapter: makeInMemoryAdapter(),
          schema: appSchema,
          storeId,
          // Seed client document tables with sample data for Storybook (single transaction)
          boot: (store) =>
            store.commit(
              userPreferencesClientDoc.set(
                {
                  userId: 'user-1',
                  theme: 'dark',
                  language: 'en',
                  notificationsEnabled: true,
                  lastLoginAt: Date.now() - 1_000 * 60 * 60,
                  searchFilter: 'recent',
                  volumeLevel: 7,
                },
                clientInfo.sessionId,
              ),
              userPreferencesClientDoc.set(
                {
                  userId: 'user-2',
                  theme: 'light',
                  language: 'de',
                  notificationsEnabled: false,
                  lastLoginAt: Date.now() - 1_000 * 60 * 60 * 24,
                  searchFilter: 'posts',
                  volumeLevel: 3,
                },
                otherClientInfo1.sessionId,
              ),
              userPreferencesClientDoc.set(
                {
                  userId: 'user-3',
                  theme: 'auto',
                  language: 'fr',
                  notificationsEnabled: true,
                  lastLoginAt: Date.now() - 1_000 * 60 * 5,
                  searchFilter: 'alerts',
                  volumeLevel: 9,
                },
                otherClientInfo2.sessionId,
              ),
              sessionDataClientDoc.set(
                {
                  sessionId,
                  currentPage: '/posts',
                  scrollPosition: 320,
                  selectedItems: '["post-1","post-2"]',
                  filters: '{"status":"published"}',
                  lastActiveAt: Date.now(),
                },
                clientInfo.sessionId,
              ),
              sessionDataClientDoc.set(
                {
                  sessionId: otherClientInfo1.sessionId,
                  currentPage: '/comments',
                  scrollPosition: 120,
                  selectedItems: '[]',
                  filters: '{"status":"draft"}',
                  lastActiveAt: Date.now() - 1_000 * 60 * 10,
                },
                otherClientInfo1.sessionId,
              ),
              sessionDataClientDoc.set(
                {
                  sessionId: otherClientInfo2.sessionId,
                  currentPage: '/settings',
                  scrollPosition: 0,
                  selectedItems: '["setting-privacy"]',
                  filters: '{}',
                  lastActiveAt: Date.now() - 1_000 * 60 * 20,
                },
                otherClientInfo2.sessionId,
              ),
            ),
        }).pipe(provideOtel({}))

        // Start sync simulation
        yield* Effect.gen(function* () {
          yield* Effect.sleep(1000)
          yield* SubscriptionRef.getAndUpdate(leaderEventSequenceNumberSubRef, (eventNum) => {
            const incrementGlobal = Math.random() > 0.5
            return EventSequenceNumber.Client.Composite.make({
              global: incrementGlobal ? eventNum.global + 1 : eventNum.global,
              client: incrementGlobal ? 0 : eventNum.client + 1,
            })
          })

          yield* SubscriptionRef.getAndUpdate(syncBackendEventSequenceNumberSubRef, (eventNum) => {
            const incrementGlobal = Math.random() > 0.6
            return EventSequenceNumber.Global.make(incrementGlobal ? eventNum + 1 : eventNum)
          })
        }).pipe(Effect.forever, Effect.forkScoped)

        const apiSession: DevtoolsApiSession = {
          clientInfo,
          isLeader: true,
          status: Stream.make({ _tag: 'connected' as const }),
          copyToClipboard,
          sendEscapeKey: Effect.void,

          // Snapshot handling - return provided snapshot if available, otherwise never
          signalSnapshots: () => {
            if (snapshot) {
              return Stream.succeed(snapshot)
            }
            return Stream.never
          },

          // Store methods
          snapshot: mockStore[StoreInternalsSymbol].clientSession.leaderThread.export.pipe(
            Effect.orDie,
          ),
          eventlog: Effect.never,
          loadDatabaseFile: () => Effect.void,
          resetAllData: () => Effect.die(new Error('Not implemented: resetAllData')),

          // Sync methods
          syncingInfo: Effect.succeed({
            enabled: true,
            metadata: { name: '@livestore/mock-sync', description: 'Just a mock sync backend' },
          }),
          networkStatus: Stream.make(
            Devtools.NetworkStatus.make({
              isConnected: false,
              timestampMs: Date.now() - 30000,
              devtools: { latchClosed: false },
            }),
            Devtools.NetworkStatus.make({
              isConnected: true,
              timestampMs: Date.now() - 10000,
              devtools: { latchClosed: false },
            }),
          ),
          syncHistory: Stream.make(),
          syncHeadLeader: Stream.zipLatest(
            SubscriptionRef.changes(leaderEventSequenceNumberSubRef),
            SubscriptionRef.changes(syncBackendEventSequenceNumberSubRef),
          ).pipe(
            Stream.map(([leaderEventSequenceNumber, syncBackendEventSequenceNumber]) =>
              Devtools.Leader.SyncHeadRes.make({
                clientId,
                local: leaderEventSequenceNumber,
                upstream: EventSequenceNumber.Client.Composite.make({
                  global: syncBackendEventSequenceNumber,
                  client: 0,
                }),
                subscriptionId: 'subscriptionId',
                requestId: 'requestId',
                liveStoreVersion,
              }),
            ),
          ),
          syncHeadClientSession: SubscriptionRef.changes(leaderEventSequenceNumberSubRef).pipe(
            Stream.map((eventNum) =>
              Devtools.ClientSession.SyncHeadRes.make({
                clientId,
                local: eventNum,
                upstream: eventNum,
                liveStoreVersion,
                requestId: 'requestId',
                sessionId,
                subscriptionId: 'subscriptionId',
              }),
            ),
          ),
          setSyncLatch: () => Effect.void,
          syncPull: Stream.never,

          // Live queries
          liveQueries: () =>
            Stream.make([
              Devtools.ClientSession.SerializedLiveQuery.make({
                _tag: 'db',
                label: 'SELECT * FROM user WHERE isActive = 1',
                id: 1,
                hash: 'user_active_123',
                runs: 5,
                executionTimes: [45, 52, 38, 61, 44],
                lastestResult: {
                  users: [
                    {
                      id: 'user-1',
                      name: 'John Doe',
                      email: 'john@example.com',
                      isActive: 1,
                      createdAt: 1640995200000,
                    },
                    {
                      id: 'user-2',
                      name: 'Jane Smith',
                      email: 'jane@example.com',
                      isActive: 1,
                      createdAt: 1641081600000,
                    },
                  ],
                },
                activeSubscriptions: [],
              }),
              Devtools.ClientSession.SerializedLiveQuery.make({
                _tag: 'db',
                label:
                  'SELECT p.*, u.name as authorName FROM post p JOIN user u ON p.userId = u.id WHERE p.status = "published"',
                id: 2,
                hash: 'published_posts_456',
                runs: 3,
                executionTimes: [120, 95, 108],
                lastestResult: {
                  posts: [
                    {
                      id: 'post-1',
                      userId: 'user-1',
                      title: 'Getting Started with LiveStore',
                      content: 'LiveStore is a...',
                      status: 'published',
                      authorName: 'John Doe',
                      publishedAt: 1642032000000,
                    },
                    {
                      id: 'post-2',
                      userId: 'user-2',
                      title: 'Advanced ReactFlow Patterns',
                      content: 'In this post...',
                      status: 'published',
                      authorName: 'Jane Smith',
                      publishedAt: 1642118400000,
                    },
                  ],
                },
                activeSubscriptions: [],
              }),
              Devtools.ClientSession.SerializedLiveQuery.make({
                _tag: 'computed',
                label: 'filterPostsByDateRange',
                id: 3,
                hash: 'date_filter_789',
                runs: 12,
                executionTimes: [25, 30, 22, 28, 35, 20, 33, 29, 31, 24, 27, 26],
                lastestResult: {
                  filteredPosts: [
                    {
                      id: 'post-1',
                      title: 'Getting Started with LiveStore',
                      publishedAt: 1642032000000,
                    },
                  ],
                },
                activeSubscriptions: [],
              }),
              Devtools.ClientSession.SerializedLiveQuery.make({
                _tag: 'db',
                label: 'SELECT * FROM user_preferences WHERE userId = ?',
                id: 4,
                hash: 'user_prefs_abc',
                runs: 2,
                executionTimes: [15, 18],
                lastestResult: {
                  preferences: [
                    {
                      userId: 'user-1',
                      theme: 'dark',
                      language: 'en',
                      notificationsEnabled: 1,
                      lastLoginAt: 1642204800000,
                    },
                  ],
                },
                activeSubscriptions: [],
              }),
              Devtools.ClientSession.SerializedLiveQuery.make({
                _tag: 'computed',
                label: 'getCurrentUserSession',
                id: 5,
                hash: 'session_computed_def',
                runs: 8,
                executionTimes: [12, 10, 15, 11, 13, 9, 14, 12],
                lastestResult: {
                  session: {
                    sessionId: sessionId,
                    currentPage: '/posts',
                    scrollPosition: 340,
                    selectedItems: '["post-1", "post-2"]',
                    filters: '{"status":"published","dateRange":"last30days"}',
                    lastActiveAt: Date.now(),
                  },
                },
                activeSubscriptions: [],
              }),
            ]),

          // Database info
          databaseFileInfo: Effect.succeed({
            _tag: 'LSD.Leader.DatabaseFileInfoRes',
            clientId,
            liveStoreVersion,
            requestId: 'requestId',
            state: {
              fileSize: 1000,
              persistenceInfo: { fileName: 'database.db' },
            },
            eventlog: {
              fileSize: 1000,
              persistenceInfo: { fileName: 'eventlog.db' },
            },
          }),

          // Debug methods
          debugInfo: Effect.never,
          debugInfoHistory: Stream.never,
          debugInfoReset: Effect.void,
          debugInfoRerunQuery: () => Effect.void,

          // Other methods
          commitEvent: Effect.fn('@livestore/devtools-react/testing/commitEvent')(
            function* (eventEncoded) {
              const decodedInput: LiveStoreEvent.Input.Decoded = yield* Schema.decodeUnknownEffect(
                eventInputSchema,
              )(eventEncoded).pipe(Effect.orDie)
              const eventDef = appSchema.eventsDefsMap.get(decodedInput.name)
              if (eventDef === undefined) {
                return shouldNeverHappen(`Unknown event name: ${decodedInput.name}`)
              }

              const head = yield* SubscriptionRef.get(leaderEventSequenceNumberSubRef)
              const nextPair = EventSequenceNumber.Client.nextPair({
                seqNum: head,
                isClientOnly: eventDef.options.clientOnly,
                rebaseGeneration: head.rebaseGeneration,
              })

              const clientEventEncoded = yield* Schema.encodeUnknownEffect(eventClientSchema)({
                name: decodedInput.name,
                args: decodedInput.args,
                seqNum: nextPair.seqNum,
                parentSeqNum: nextPair.parentSeqNum,
                clientId: clientInfo.clientId,
                sessionId: clientInfo.sessionId,
              }).pipe(Effect.orDie)

              const clientEventDecoded = yield* Schema.decodeUnknownEffect(
                mockStore[StoreInternalsSymbol].eventSchema,
              )(clientEventEncoded).pipe(Effect.orDie)
              mockStore.commit(clientEventDecoded)

              yield* SubscriptionRef.set(leaderEventSequenceNumberSubRef, nextPair.seqNum)
              yield* SubscriptionRef.set(
                syncBackendEventSequenceNumberSubRef,
                EventSequenceNumber.Global.make(nextPair.seqNum.global),
              )
            },
          ),
          disconnected: Effect.never,

          // Version mismatch - always compatible in testing mode
          versionMismatch: Stream.make({ _tag: 'compatible' as const }),

          ...apiSessionOverrides,
        }

        return apiSession
      }),
      clientSessions: Subscribable.make({
        get: Effect.succeed(HashSet.fromIterable([clientInfo, otherClientInfo1, otherClientInfo2])),
        changes: Stream.never,
      }),
      copyToClipboard,
      sendEscapeKey: Effect.die(new Error('Not implemented: sendEscapeKey')),
      ...apiOverrides,
    }
  }

  return (Story: React.FC) => (
    <ThemeProvider>
      <div className="h-full bg-devtools-background">
        <RouterProvider
          router={router}
          InnerWrap={({ children }) => (
            <RootContext.Provider
              value={{
                appSchemas: [appSchema, ...appSchemas],
                mode: { _tag: 'mock', api: makeDevtoolsApi() },
                license: undefined,
                options: undefined,
                sharedWorker: LiveStoreSharedWorker,
                mountPath: '/',
                triggerReload: () => window.location.reload(),
                onBoot,
              }}
            >
              {children}
            </RootContext.Provider>
          )}
          defaultComponent={() => <Story />}
        />
      </div>
    </ThemeProvider>
  )
}

// Legacy compatibility functions
export const makeMockDevtoolsApi = () => ({
  createDevtoolsDecorator: () => createTestingDecorator(),
})

export const createDagNodesTestingDecorator = (
  config: { snapshot?: ReactiveGraph.ReactiveGraphSnapshot } = {},
) => createTestingDecorator(config)

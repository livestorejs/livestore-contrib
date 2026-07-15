import './styles.css'
import 'prosemirror-view/style/prosemirror.css'

import { makeSingleTabAdapter } from '@livestore/adapter-web'
import { createStorePromise, liveStoreVersion, type Store } from '@livestore/livestore'
import { LoroDoc } from 'loro-crdt'
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  redo,
  undo,
  updateLoroToPmState,
  type LoroDocType,
} from 'loro-prosemirror'
import { baseKeymap, setBlockType, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { Schema as ProseMirrorSchema } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { addListNodes, liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { EditorState, type Command } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import LiveStoreWorker from './livestore.worker.ts?worker'
import { documentId, events, refsForDocument, schema, type RefRow } from './livestore.ts'

type DemoStore = Store<typeof schema>

type ActorId = 'client-a' | 'client-b'

type RelayEnvelope =
  | { readonly type: 'hello'; readonly clientId: ActorId; readonly snapshotBase64?: string }
  | { readonly type: 'snapshot'; readonly source: ActorId; readonly snapshotBase64: string }
  | { readonly type: 'update'; readonly source: ActorId; readonly updateId: string; readonly updateBase64: string }
  | { readonly type: 'sync-info'; readonly peers: number; readonly updatesStored: number; readonly hasSnapshot: boolean }
  | { readonly type: 'error'; readonly message: string }

type SideChannelRecord = {
  readonly direction: 'sent' | 'received'
  readonly kind: 'update' | 'snapshot'
  readonly source: string
  readonly updateId: string
  readonly bytes: number
  readonly preview: string
  readonly at: string
}

const editorSchema = new ProseMirrorSchema({
  nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
  marks: basicSchema.spec.marks,
})
const bootstrapUpdate = createBootstrapUpdate()
const sideChannelId = 'loro://reference-only-document/native-updates'
const url = new URL(window.location.href)
const actorId = normalizeActorId(url.searchParams.get('client'))
const room = sanitizeRoom(url.searchParams.get('room') ?? 'reference-only-demo')
const relayUrl = resolveRelayUrl(room)
const localRecords: SideChannelRecord[] = []
const importedUpdateIds = new Set<string>()

const globalStatus = requiredElement('global-status')
const connectionStatus = requiredElement('connection-status')
const livestoreCount = requiredElement('livestore-count')
const sideChannelCount = requiredElement('side-channel-count')
const sideChannelBytes = requiredElement('side-channel-bytes')
const relayUrlLabel = requiredElement('relay-url')
const roomLabel = requiredElement('room-name')
const clientLabel = requiredElement('client-name')
const editorMount = requiredElement('editor')
const toolbar = requiredElement('toolbar')
const syncButton = requiredElement<HTMLButtonElement>('sync-now')
const devtoolsRoot = requiredElement('devtools')

clientLabel.textContent = actorId
roomLabel.textContent = room
relayUrlLabel.textContent = relayUrl

const store = (await createStorePromise({
  adapter: makeSingleTabAdapter({
    worker: LiveStoreWorker,
    storage: { type: 'opfs' },
    clientId: actorId,
  }),
  schema,
  storeId: `ref-${room}-${actorId}`,
  disableDevtools: true,
})) as DemoStore

store.commit(
  events.documentReferenced({
    docId: documentId,
    loroChannel: sideChannelId,
  }),
)

const loro = new LoroDoc()
loro.setPeerId(actorId === 'client-a' ? '101' : '202')
const persistedSnapshot = await readOpfsBytes(loroSnapshotPath(room, actorId))
if (persistedSnapshot === undefined) {
  loro.importBatch([bootstrapUpdate])
} else {
  loro.importBatch([persistedSnapshot])
}

const view = new EditorView(editorMount, {
  state: EditorState.create({
    schema: editorSchema,
    plugins: [
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
        Enter: splitListItem(editorSchema.nodes.list_item),
        Tab: sinkListItem(editorSchema.nodes.list_item),
        'Shift-Tab': liftListItem(editorSchema.nodes.list_item),
      }),
      keymap(baseKeymap),
      LoroSyncPlugin({ doc: loro as LoroDocType }),
      LoroUndoPlugin({ doc: loro }),
    ],
  }),
  attributes: { 'data-editor': actorId, 'data-testid': `${actorId}-editor` },
  dispatchTransaction(transaction) {
    const nextState = view.state.apply(transaction)
    view.updateState(nextState)
    renderDevtools()
  },
})

bindToolbar()
store.subscribe(refsForDocument, (rows) => {
  updateReplicaRefs(rows as ReadonlyArray<RefRow>)
  renderDevtools()
})
updateReplicaRefs(store.query(refsForDocument) as ReadonlyArray<RefRow>)

let socket: WebSocket | undefined
let localSequence = Number(window.localStorage.getItem(sequenceStorageKey(room, actorId)) ?? '0')
let reconnectTimer: number | undefined
let lastRelayInfo: Extract<RelayEnvelope, { type: 'sync-info' }> | undefined
let applyingRemote = false

loro.subscribeLocalUpdates((nativeUpdate) => {
  if (applyingRemote) return
  const updateId = `${actorId}:${localSequence++}`
  window.localStorage.setItem(sequenceStorageKey(room, actorId), String(localSequence))
  importedUpdateIds.add(updateId)
  recordSideChannel('sent', 'update', actorId, updateId, nativeUpdate)
  persistAndPublish(updateId, nativeUpdate).catch((error: unknown) => {
    globalStatus.textContent = `Failed to persist local Loro update: ${String(error)}`
  })
})

syncButton.addEventListener('click', () => {
  if (socket?.readyState === WebSocket.OPEN) {
    publishSnapshot()
    globalStatus.textContent = 'Published a fresh Loro snapshot to the relay for late joiners.'
  } else {
    connectRelay()
  }
})

connectRelay()
updateGlobalMetrics()
renderDevtools()
globalStatus.textContent = `Ready - LiveStore ${liveStoreVersion} stores one ref; Loro syncs through its own relay.`
document.body.dataset.ready = 'true'

Object.assign(window, {
  __REF_DEMO__: {
    actorId,
    room,
    relayUrl,
    getMetrics: () => ({
      actorId,
      room,
      relayUrl,
      text: editorMount.textContent ?? '',
      refCount: Number(livestoreCount.textContent ?? '0'),
      sideChannelUpdates: localRecords.filter((record) => record.kind === 'update').length,
      sideChannelBytes: Number(sideChannelBytes.textContent ?? '0'),
      connection: connectionStatus.textContent,
      loro: inspectLoro(),
      proseMirror: view.state.doc.toJSON(),
    }),
  },
})

function bindToolbar(): void {
  const commands: Record<string, Command> = {
    bold: toggleMark(editorSchema.marks.strong),
    italic: toggleMark(editorSchema.marks.em),
    heading: setBlockType(editorSchema.nodes.heading, { level: 2 }),
    'bullet-list': wrapInList(editorSchema.nodes.bullet_list),
    'ordered-list': wrapInList(editorSchema.nodes.ordered_list),
  }
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      commands[button.dataset.command!]!(view.state, view.dispatch, view)
      view.focus()
    })
  }
}

function connectRelay(): void {
  if (relayUrl === 'disabled') {
    connectionStatus.textContent = 'disabled for local check'
    return
  }
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
  if (socket !== undefined && socket.readyState < WebSocket.CLOSING) return

  connectionStatus.textContent = 'connecting'
  socket = new WebSocket(relayUrl)
  socket.addEventListener('open', () => {
    connectionStatus.textContent = 'connected'
    sendRelay({
      type: 'hello',
      clientId: actorId,
      snapshotBase64: encodeBase64(loro.export({ mode: 'snapshot' })),
    })
    publishSnapshot()
  })
  socket.addEventListener('message', (event) => {
    handleRelayMessage(String(event.data)).catch((error: unknown) => {
      globalStatus.textContent = `Relay message failed: ${String(error)}`
    })
  })
  socket.addEventListener('close', () => {
    connectionStatus.textContent = 'disconnected'
    reconnectTimer = window.setTimeout(connectRelay, 1200)
  })
  socket.addEventListener('error', () => {
    connectionStatus.textContent = 'relay error'
  })
}

async function handleRelayMessage(raw: string): Promise<void> {
  const envelope = JSON.parse(raw) as RelayEnvelope
  if (envelope.type === 'error') {
    globalStatus.textContent = envelope.message
    return
  }
  if (envelope.type === 'sync-info') {
    lastRelayInfo = envelope
    renderDevtools()
    return
  }
  if (envelope.type === 'snapshot') {
    const bytes = decodeBase64(envelope.snapshotBase64)
    applyingRemote = true
    try {
      loro.importBatch([bytes])
    } finally {
      applyingRemote = false
    }
    recordSideChannel('received', 'snapshot', envelope.source, `${envelope.source}:snapshot`, bytes)
    await persistLoroSnapshot()
    updateGlobalMetrics()
    renderDevtools()
    return
  }
  if (envelope.type === 'update') {
    if (envelope.source === actorId || importedUpdateIds.has(envelope.updateId)) return
    const bytes = decodeBase64(envelope.updateBase64)
    importedUpdateIds.add(envelope.updateId)
    applyingRemote = true
    try {
      loro.importBatch([bytes])
    } finally {
      applyingRemote = false
    }
    recordSideChannel('received', 'update', envelope.source, envelope.updateId, bytes)
    await persistLoroSnapshot()
    publishSnapshot()
    updateGlobalMetrics()
    renderDevtools()
  }
}

async function persistAndPublish(updateId: string, nativeUpdate: Uint8Array): Promise<void> {
  await persistLoroSnapshot()
  sendRelay({ type: 'update', source: actorId, updateId, updateBase64: encodeBase64(nativeUpdate) })
  publishSnapshot()
  updateGlobalMetrics()
  renderDevtools()
}

function publishSnapshot(): void {
  sendRelay({ type: 'snapshot', source: actorId, snapshotBase64: encodeBase64(loro.export({ mode: 'snapshot' })) })
}

function sendRelay(envelope: RelayEnvelope): void {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(envelope))
}

async function persistLoroSnapshot(): Promise<void> {
  await writeOpfsBytes(loroSnapshotPath(room, actorId), loro.export({ mode: 'snapshot' }))
  document.body.dataset.persisted = 'true'
}

function updateReplicaRefs(rows: ReadonlyArray<RefRow>): void {
  livestoreCount.textContent = String(rows.length)
  document.body.dataset.refCount = String(rows.length)
}

function recordSideChannel(
  direction: SideChannelRecord['direction'],
  kind: SideChannelRecord['kind'],
  source: string,
  updateId: string,
  bytes: Uint8Array,
): void {
  localRecords.push({
    direction,
    kind,
    source,
    updateId,
    bytes: bytes.byteLength,
    preview: encodeBase64(bytes).slice(0, 80),
    at: new Date().toISOString(),
  })
  updateGlobalMetrics()
}

function updateGlobalMetrics(): void {
  sideChannelCount.textContent = String(localRecords.filter((record) => record.kind === 'update').length)
  sideChannelBytes.textContent = String(localRecords.reduce((total, record) => total + record.bytes, 0))
}

function renderDevtools(): void {
  const refs = store.query(refsForDocument) as ReadonlyArray<RefRow>
  const loroState = inspectLoro()
  const pmJson = view.state.doc.toJSON()
  devtoolsRoot.innerHTML = `
    <section class="devtools-panel">
      <h2>LiveStore log</h2>
      <p><b>${refs.length}</b> ref event; no document text is in LiveStore.</p>
      <details open>
        <summary>DocumentReferenced rows</summary>
        <pre>${escapeHtml(JSON.stringify(refs, null, 2))}</pre>
      </details>
    </section>
    <section class="devtools-panel">
      <h2>Loro side-channel</h2>
      <p><b>${localRecords.length}</b> relay messages observed by this client; text bytes are off-log.</p>
      <div class="event-list">
        ${localRecords
          .slice()
          .reverse()
          .map(
            (record) => `
              <details>
                <summary>${record.direction} ${record.kind} ${record.updateId} - ${record.bytes} bytes</summary>
                <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
              </details>
            `,
          )
          .join('')}
      </div>
    </section>
    <section class="devtools-panel">
      <h2>Loro document</h2>
      <p>Version/frontiers/oplog are decoded from Loro, not LiveStore.</p>
      <pre>${escapeHtml(JSON.stringify(loroState, null, 2))}</pre>
    </section>
    <section class="devtools-panel">
      <h2>ProseMirror state</h2>
      <pre>${escapeHtml(JSON.stringify(pmJson, null, 2))}</pre>
    </section>
    <section class="devtools-panel">
      <h2>Relay sync flow</h2>
      <p>Room ${escapeHtml(room)} on ${escapeHtml(relayUrl)}.</p>
      <pre>${escapeHtml(JSON.stringify(lastRelayInfo ?? { peers: 'unknown', updatesStored: 'unknown' }, null, 2))}</pre>
    </section>
  `
}

function inspectLoro(): unknown {
  const textContainer = (loro as unknown as { getText?: (id: string) => { toDelta?: () => unknown } }).getText?.('text')
  return {
    version: stringifyVersionVector(loro.version()),
    frontiers: loro.frontiers(),
    oplogVersion: stringifyVersionVector(loro.oplogVersion()),
    oplogFrontiers: loro.oplogFrontiers(),
    opCount: Array.from(loro.oplogVersion().toJSON().values()).reduce((total: number, value) => total + Number(value), 0),
    json: loro.toJSON(),
    textDelta: textContainer?.toDelta?.() ?? null,
  }
}

function stringifyVersionVector(vector: { toJSON: () => Map<unknown, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Array.from(vector.toJSON().entries(), ([key, value]) => [String(key), value]))
}

async function readOpfsBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    const root = await navigator.storage.getDirectory()
    const file = await root.getFileHandle(path)
    return new Uint8Array(await (await file.getFile()).arrayBuffer())
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
    return undefined
  }
}

async function writeOpfsBytes(path: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const file = await root.getFileHandle(path, { create: true })
  const writable = await file.createWritable()
  await writable.write(new Uint8Array(bytes))
  await writable.close()
}

function loroSnapshotPath(roomName: string, client: ActorId): string {
  return `loro-${roomName}-${client}.snapshot`
}

function sequenceStorageKey(roomName: string, client: ActorId): string {
  return `ref-demo:${roomName}:${client}:sequence`
}

function resolveRelayUrl(roomName: string): string {
  const configured =
    url.searchParams.get('relay') ??
    (import.meta.env.VITE_LORO_RELAY_URL as string | undefined) ??
    'ws://127.0.0.1:8788/loro'
  if (configured === 'disabled') return configured
  const base = configured.endsWith('/') ? configured.slice(0, -1) : configured
  return `${base}/${encodeURIComponent(roomName)}`
}

function normalizeActorId(value: string | null): ActorId {
  return value === 'client-b' ? 'client-b' : 'client-a'
}

function sanitizeRoom(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'reference-only-demo'
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function createBootstrapUpdate(): Uint8Array {
  const seed = new LoroDoc()
  seed.setPeerId('1')
  let nativeUpdate: Uint8Array | undefined
  seed.subscribeLocalUpdates((update) => {
    nativeUpdate = update
  })
  updateLoroToPmState(seed as LoroDocType, new Map(), EditorState.create({ schema: editorSchema }))
  if (nativeUpdate === undefined) throw new Error('Loro did not emit the shared bootstrap update')
  seed.free()
  return nativeUpdate
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing #${id}`)
  return element as T
}

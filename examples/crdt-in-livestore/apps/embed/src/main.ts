import "./styles.css";
import "prosemirror-view/style/prosemirror.css";

import { makePersistedAdapter } from "@livestore/adapter-web";
import LiveStoreSharedWorker from "@livestore/adapter-web/shared-worker?sharedworker";
import { createStorePromise, liveStoreVersion, type Store, type SyncStatus } from "@livestore/livestore";
import { Effect, Stream } from "effect";
import { LoroDoc, LoroText } from "loro-crdt";
import { LoroSyncPlugin, LoroUndoPlugin, redo, undo, updateLoroToPmState, type LoroDocType } from "loro-prosemirror";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Schema as ProseMirrorSchema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes, liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import LiveStoreWorker from "./livestore.worker.ts?worker";
import { events, schema, updatesForDocument, type UpdateRow } from "./livestore.ts";

type DemoStore = Store<typeof schema>;
type ConfirmedEvent = {
  readonly args: {
    readonly createdAt: number;
    readonly docId: string;
    readonly originReplica: string;
    readonly originSequence: number;
    readonly updateBase64: string;
    readonly updateId: string;
  };
  readonly clientId: string;
  readonly seqNum: { readonly client: number; readonly global: number; readonly rebaseGeneration: number };
};

const editorSchema = new ProseMirrorSchema({
  nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block"),
  marks: basicSchema.spec.marks,
});
const documentId = readIdentifier("doc", "flagship-document");
const replicaId = readIdentifier("client", crypto.randomUUID());
const storeId = `crdt-demo-${documentId}`;
const confirmedEvents: ConfirmedEvent[] = [];
let materializedRows: ReadonlyArray<UpdateRow> = [];
let syncStatus: SyncStatus = { isSynced: false, localHead: "e0", pendingCount: 0, upstreamHead: "e0" };
let editorView: EditorView | undefined;

if (globalThis.crossOriginIsolated !== true) {
  throw new Error("Cross-origin isolation is required for OPFS and SharedWorker persistence");
}

requiredElement("client-id").textContent = replicaId;
const adapter = makePersistedAdapter({
  storage: { type: "opfs" },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
});
const store = (await createStorePromise({ adapter, schema, storeId, disableDevtools: true })) as DemoStore;
const initialUpstreamGlobal = parseGlobalHead(store.syncStatus().upstreamHead);
let networkConnected = (await Effect.runPromise(store.networkStatus)).isConnected;
const loro = new LoroDoc();
loro.setPeerId(readPeerId(replicaId));

const updatesQuery = updatesForDocument(documentId);
if ((store.query(updatesQuery) as ReadonlyArray<UpdateRow>).length === 0) {
  const bootstrapUpdate = createBootstrapUpdate();
  store.commit(
    events.loroUpdate({
      createdAt: 0,
      docId: documentId,
      originReplica: "bootstrap",
      originSequence: 0,
      updateBase64: encodeBase64(bootstrapUpdate),
      updateId: "seed:0",
    }),
  );
}

const importedUpdateIds = new Set<string>();
for (const row of store.query(updatesQuery) as ReadonlyArray<UpdateRow>) importRow(row);

let localSequence = (store.query(updatesQuery) as ReadonlyArray<UpdateRow>).filter(
  (row) => row.origin_replica === replicaId,
).length;
loro.subscribeLocalUpdates((nativeUpdate) => {
  const updateId = `${replicaId}:${crypto.randomUUID()}`;
  importedUpdateIds.add(updateId);
  store.commit(
    events.loroUpdate({
      createdAt: Date.now(),
      docId: documentId,
      originReplica: replicaId,
      originSequence: ++localSequence,
      updateBase64: encodeBase64(nativeUpdate),
      updateId,
    }),
  );
});

editorView = new EditorView(requiredElement("editor"), {
  state: EditorState.create({
    schema: editorSchema,
    plugins: [
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
        Enter: splitListItem(editorSchema.nodes.list_item),
        Tab: sinkListItem(editorSchema.nodes.list_item),
        "Shift-Tab": liftListItem(editorSchema.nodes.list_item),
      }),
      keymap(baseKeymap),
      LoroSyncPlugin({ doc: loro as LoroDocType }),
      LoroUndoPlugin({ doc: loro }),
    ],
  }),
  attributes: { "data-editor": replicaId },
  dispatchTransaction(transaction) {
    if (editorView === undefined) return;
    editorView.updateState(editorView.state.apply(transaction));
    renderDevtools();
  },
});

bindToolbar(editorView);
loro.subscribe(() => renderDevtools());
store.subscribe(updatesQuery, (rows) => {
  materializedRows = rows as ReadonlyArray<UpdateRow>;
  for (const row of materializedRows) importRow(row);
  renderDevtools();
});
store.subscribeSyncStatus((status) => {
  syncStatus = status;
  renderDevtools();
});
Effect.runFork(
  store.networkStatus.changes.pipe(
    Stream.runForEach((status) =>
      Effect.sync(() => {
        networkConnected = status.isConnected;
        renderDevtools();
      }),
    ),
  ),
);
void consumeConfirmedEvents(store);
bindShareActions();

materializedRows = store.query(updatesQuery) as ReadonlyArray<UpdateRow>;
renderDevtools();
document.body.dataset.ready = "true";
document.body.dataset.crossOriginIsolated = String(globalThis.crossOriginIsolated);

async function consumeConfirmedEvents(currentStore: DemoStore): Promise<void> {
  for await (const event of currentStore.events({ filter: ["LoroUpdate"] })) {
    const confirmed = event as ConfirmedEvent;
    if (confirmed.args.docId !== documentId) continue;
    const key = `${confirmed.seqNum.global}:${confirmed.seqNum.client}:${confirmed.seqNum.rebaseGeneration}`;
    if (
      confirmedEvents.some(
        (existing) => `${existing.seqNum.global}:${existing.seqNum.client}:${existing.seqNum.rebaseGeneration}` === key,
      )
    ) {
      continue;
    }
    confirmedEvents.push(confirmed);
    renderDevtools();
  }
}

function bindToolbar(view: EditorView): void {
  const commands: Record<string, Command> = {
    bold: toggleMark(editorSchema.marks.strong),
    italic: toggleMark(editorSchema.marks.em),
    heading: setBlockType(editorSchema.nodes.heading, { level: 2 }),
    "bullet-list": wrapInList(editorSchema.nodes.bullet_list),
    "ordered-list": wrapInList(editorSchema.nodes.ordered_list),
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-command]")) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      commands[button.dataset.command!]!(view.state, view.dispatch, view);
      view.focus();
    });
  }
}

function bindShareActions(): void {
  const secondClientUrl = new URL(globalThis.location.href);
  secondClientUrl.searchParams.set("doc", documentId);
  secondClientUrl.searchParams.set("client", crypto.randomUUID());

  requiredElement<HTMLButtonElement>("copy-client-link").addEventListener("click", async () => {
    await navigator.clipboard.writeText(secondClientUrl.toString());
    requiredElement("network-status").textContent = "Second-client URL copied. Open it in a separate browser context.";
  });
  requiredElement<HTMLButtonElement>("open-client-window").addEventListener("click", () => {
    globalThis.open(secondClientUrl, "_blank", "noopener,noreferrer");
  });
}

function importRow(row: UpdateRow): void {
  if (importedUpdateIds.has(row.update_id)) return;
  importedUpdateIds.add(row.update_id);
  loro.importBatch([decodeBase64(row.update_bytes_base64)]);
}

function renderDevtools(): void {
  const byteCount = materializedRows.reduce(
    (total, row) => total + decodeBase64(row.update_bytes_base64).byteLength,
    0,
  );
  requiredElement("event-count").textContent = String(materializedRows.length);
  requiredElement("byte-count").textContent = String(byteCount);
  requiredElement("client-status").textContent = syncStatus.isSynced
    ? `Synced · LiveStore ${liveStoreVersion} · OPFS`
    : `Syncing ${syncStatus.pendingCount} event${syncStatus.pendingCount === 1 ? "" : "s"} · OPFS`;
  requiredElement("network-status").textContent = networkConnected
    ? syncStatus.isSynced
      ? `Connected and caught up at ${syncStatus.upstreamHead}. Changes sync automatically over the Worker WebSocket.`
      : `Connected · ${syncStatus.pendingCount} pending · local ${syncStatus.localHead} → upstream ${syncStatus.upstreamHead}`
    : `Backend unreachable · ${syncStatus.pendingCount} pending safely in ${store.storageMode} storage`;
  document.body.dataset.synced = String(syncStatus.isSynced);
  document.body.dataset.networkConnected = String(networkConnected);
  document.body.dataset.storageMode = store.storageMode;

  renderEventLog();
  renderMaterializedTable();
  renderDecodedState();
  renderSyncFlow();
}

function renderEventLog(): void {
  const root = requiredElement("event-log");
  root.replaceChildren(
    ...confirmedEvents.map((event) => {
      const bytes = decodeBase64(event.args.updateBase64);
      const details = document.createElement("details");
      details.className = "event-row";
      details.dataset.updateId = event.args.updateId;
      const direction = eventDirection(event);
      details.innerHTML = `
        <summary>
          <span class="event-seq">e${event.seqNum.global}</span>
          <span>${escapeHtml(event.args.originReplica)}</span>
          <span class="direction ${direction}">${direction}</span>
          <span>${bytes.byteLength} B</span>
          <code>${escapeHtml(toHex(bytes.slice(0, 10)))}${bytes.byteLength > 10 ? "…" : ""}</code>
        </summary>
        <div class="event-detail" data-role="event-full-bytes">
          <dl><dt>update</dt><dd>${escapeHtml(event.args.updateId)}</dd><dt>created</dt><dd>${formatTimestamp(event.args.createdAt)}</dd></dl>
          <strong>Full opaque base64</strong>
          <pre>${escapeHtml(event.args.updateBase64)}</pre>
          <strong>Full hex</strong>
          <pre>${toHex(bytes)}</pre>
        </div>`;
      return details;
    }),
  );
  if (confirmedEvents.length === 0) root.appendChild(emptyState("Waiting for backend-confirmed events…"));
}

function renderMaterializedTable(): void {
  const root = requiredElement("materialized-table");
  root.replaceChildren(
    ...materializedRows.map((row) => {
      const item = document.createElement("div");
      item.className = "table-row";
      item.innerHTML = `<code>${escapeHtml(row.update_id)}</code><span>${escapeHtml(row.origin_replica)}</span><span>${decodeBase64(row.update_bytes_base64).byteLength} B</span>`;
      return item;
    }),
  );
}

function renderDecodedState(): void {
  const version = [...loro.version().toJSON().entries()].map(([peer, counter]) => ({ counter, peer }));
  requiredElement("loro-metrics").innerHTML = `
    <div><dt>version peers</dt><dd>${version.length}</dd></div>
    <div><dt>frontiers</dt><dd>${loro.frontiers().length}</dd></div>
    <div><dt>changes</dt><dd>${loro.changeCount()}</dd></div>
    <div><dt>operations</dt><dd data-testid="loro-op-count">${loro.opCount()}</dd></div>`;
  requiredElement("loro-json").textContent = stringifyJson({
    decodedDocument: loro.toJSON(),
    richTextDeltas: loro.toJsonWithReplacer((_key, value) => (value instanceof LoroText ? value.toDelta() : value)),
    frontiers: loro.frontiers(),
    version,
  });
  requiredElement("prosemirror-json").textContent = stringifyJson(editorView?.state.doc.toJSON() ?? null);
}

function renderSyncFlow(): void {
  const pushed = confirmedEvents.filter((event) => eventDirection(event) === "pushed");
  const pulled = confirmedEvents.filter((event) => eventDirection(event) === "pulled");
  requiredElement("flow-state").textContent = networkConnected
    ? syncStatus.isSynced
      ? "converged with backend"
      : "diverged · syncing"
    : "offline · local state retained";
  requiredElement("sync-metrics").innerHTML = `
    <div><b>${pushed.length}</b><span>pushed + confirmed</span></div>
    <div><b>${pulled.length}</b><span>pulled</span></div>
    <div><b>${syncStatus.pendingCount}</b><span>pending</span></div>`;
  const root = requiredElement("sync-flow");
  const visibleEvents = confirmedEvents.slice(-12);
  for (const direction of ["pushed", "pulled"] as const) {
    if (visibleEvents.some((event) => eventDirection(event) === direction)) continue;
    const latest = [...confirmedEvents].reverse().find((event) => eventDirection(event) === direction);
    if (latest !== undefined) visibleEvents.unshift(latest);
  }
  root.replaceChildren(
    ...visibleEvents.reverse().map((event) => {
      const direction = eventDirection(event);
      const item = document.createElement("div");
      item.className = "flow-row";
      item.dataset.direction = direction;
      item.innerHTML = `<span class="direction ${direction}">${direction}</span><code>${escapeHtml(event.args.updateId)}</code><span>e${event.seqNum.global}</span>`;
      return item;
    }),
  );
}

function createBootstrapUpdate(): Uint8Array {
  const seed = new LoroDoc();
  seed.setPeerId("1");
  let nativeUpdate: Uint8Array | undefined;
  seed.subscribeLocalUpdates((update) => {
    nativeUpdate = update;
  });
  updateLoroToPmState(seed as LoroDocType, new Map(), EditorState.create({ schema: editorSchema }));
  if (nativeUpdate === undefined) throw new Error("Loro did not emit the shared bootstrap update");
  seed.free();
  return nativeUpdate;
}

function readIdentifier(name: string, fallback: string): string {
  const value = new URLSearchParams(globalThis.location.search).get(name) ?? fallback;
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback.replaceAll("-", "_");
}

function readPeerId(owner: string): `${number}` {
  const storedOwner = sessionStorage.getItem("crdt-peer-owner");
  const storedPeer = sessionStorage.getItem("crdt-peer-id");
  if (storedOwner === owner && storedPeer !== null && /^\d+$/.test(storedPeer)) return storedPeer as `${number}`;
  const random = crypto.getRandomValues(new BigUint64Array(1))[0] || 1n;
  const peerId = random.toString();
  sessionStorage.setItem("crdt-peer-owner", owner);
  sessionStorage.setItem("crdt-peer-id", peerId);
  return peerId as `${number}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function eventDirection(event: ConfirmedEvent): "history" | "pulled" | "pushed" {
  if (event.args.originReplica === "bootstrap" || event.seqNum.global <= initialUpstreamGlobal) return "history";
  return event.args.originReplica === replicaId ? "pushed" : "pulled";
}

function parseGlobalHead(head: string): number {
  const match = /^e(\d+)/.exec(head);
  return match === null ? 0 : Number(match[1]);
}

function formatTimestamp(value: number): string {
  return value === 0 ? "deterministic bootstrap" : new Date(value).toISOString();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function emptyState(label: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = label;
  return element;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

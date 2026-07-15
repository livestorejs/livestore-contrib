import type { CfTypes } from "@livestore/sync-cf/cf-worker";
import * as SyncBackend from "@livestore/sync-cf/cf-worker";

type Env = {
  readonly ALLOWED_ORIGIN: string;
  readonly SYNC_DO: CfTypes.DurableObjectNamespace<SyncBackend.SyncBackendRpcInterface>;
};

const rateWindowMs = 60_000;
const maxMessagesPerDocumentPerWindow = 600;

const SyncDOBase = SyncBackend.makeDurableObject({
  storage: { _tag: "do-sqlite" },
  enabledTransports: new Set(["ws"]),
});

export class SyncDO extends SyncDOBase {
  constructor(ctx: CfTypes.DurableObjectState, env: SyncBackend.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS demo_rate_limit (id INTEGER PRIMARY KEY CHECK (id = 1), window_started_at INTEGER NOT NULL, message_count INTEGER NOT NULL) STRICT",
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO demo_rate_limit (id, window_started_at, message_count) VALUES (1, ?, 0)",
      Date.now(),
    );

    const inheritedHandler = this.webSocketMessage;
    if (inheritedHandler === undefined) throw new Error("LiveStore sync WebSocket handler was not installed");
    const handleMessage = inheritedHandler.bind(this);
    this.webSocketMessage = async (webSocket, message) => {
      const now = Date.now();
      const count = ctx.storage.transactionSync(() => {
        const current = ctx.storage.sql
          .exec<{ window_started_at: number; message_count: number }>(
            "SELECT window_started_at, message_count FROM demo_rate_limit WHERE id = 1",
          )
          .one();
        if (now - current.window_started_at >= rateWindowMs) {
          ctx.storage.sql.exec("UPDATE demo_rate_limit SET window_started_at = ?, message_count = 1 WHERE id = 1", now);
          return 1;
        }
        ctx.storage.sql.exec("UPDATE demo_rate_limit SET message_count = message_count + 1 WHERE id = 1");
        return current.message_count + 1;
      });

      if (count > maxMessagesPerDocumentPerWindow) {
        webSocket.close(1013, "Document message rate limit exceeded");
        return;
      }
      await handleMessage(webSocket, message);
    };
  }
}

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext) {
    const searchParams = SyncBackend.matchSyncRequest(request);
    if (searchParams === undefined) return new Response("Not Found", { status: 404 });
    if (new URL(request.url).pathname !== "/sync") return new Response("Not Found", { status: 404 });

    if (env.ALLOWED_ORIGIN.length === 0 || request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return new Response("Origin not allowed", { status: 403 });
    }
    if (/^crdt-demo-[a-zA-Z0-9_-]{1,80}$/.test(searchParams.storeId) === false) {
      return new Response("Invalid document id", { status: 400 });
    }

    return SyncBackend.handleSyncRequest<Env>({
      request,
      searchParams,
      env,
      ctx,
      syncBackendBinding: "SYNC_DO",
    });
  },
};

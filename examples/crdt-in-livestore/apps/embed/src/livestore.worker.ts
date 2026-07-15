import { makeWorker } from "@livestore/adapter-web/worker";
import { makeWsSync } from "@livestore/sync-cf/client";

import { schema } from "./livestore.ts";

const syncUrl = import.meta.env.VITE_SYNC_URL;

if (typeof syncUrl !== "string" || syncUrl.startsWith("wss://") === false) {
  throw new Error("VITE_SYNC_URL must be the absolute wss:// URL of the isolated LiveStore sync Worker");
}

makeWorker({
  schema,
  sync: {
    backend: makeWsSync({ url: syncUrl }),
    initialSyncOptions: { _tag: "Blocking", timeout: 10_000 },
  },
});

# Discord Gateway canary

This separate staging stack tests whether a scheduled Worker can own an outbound
Discord Gateway socket while its SQLite Durable Object handles only short leases
and checkpoints. It never handles interactions or mutates Discord. It counts
ordinary messages only in the designated staging test channel and retains no
message content or IDs. `/status` exposes aggregate counts and the latest planned
handoff duration. A rotation does not exercise abrupt worker loss.

Before deploying, verify the embedded staging Gateway is parked, wait for any
staging rollout to finish, and keep that Gateway parked throughout the experiment.
Provide only the canonical staging bot token as
`DISCORD_GATEWAY_CANARY_STAGING_TOKEN` through the approved credential broker and
use the Cloudflare Alchemy profile for LiveStore. The token's application ID is
checked before opening Discord. Set `DISCORD_GATEWAY_CANARY_RUN_UNTIL` to an ISO
timestamp about 50 minutes ahead. [Cron trigger changes can take up to 15
minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). The canary stops opening sessions by that
deadline and caps IDENTIFY at three attempts for its whole lifetime.

From `apps/discord-bot`, review the plan for the separate canary Worker, Cron, and
namespace. Apply and later destroy only that stack.

```sh
pnpm exec alchemy plan --stage staging cf/gateway-canary/alchemy.run.ts
pnpm exec alchemy deploy --stage staging cf/gateway-canary/alchemy.run.ts
pnpm exec alchemy destroy --dry-run --stage staging cf/gateway-canary/alchemy.run.ts
pnpm exec alchemy destroy --stage staging cf/gateway-canary/alchemy.run.ts
```

Allow at least two ten-minute rotations. Check that RESUMED advances, IDENTIFY
stays at one, and test-channel messages before, during, and after a handoff
all contribute to the count. Record the handoff duration, then compare Workers
CPU and the separate Durable Object duration against the embedded staging
Gateway over a comparable window. Destroy the canary before waking the embedded
staging Gateway and verify the canary URL no longer serves `/status`.

# Discord bot end-to-end verification

This directory owns black-box verification of the Discord bot. It contains
three distinct boundaries: a harness-model fake transport, a source-executable
fake-runtime black-box, and the live Discord runner. Their receipts must not be
interchanged. The live runner uses the same workflow contract against a
dedicated staging guild, but no live Discord receipt exists yet.

Current local receipt: E2E is `7/40`; the source-executable runtime black-box is
`1/1`; the same black-box against the installed executable is `1/1`. The exact
immutable package receipt lives in the application VRS experiment so recording
it cannot change the package's own source identity.

## Verdict contract

| Verdict | Meaning                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------- |
| `PASS`  | The named lane ran, its observable assertions passed, and owned artifacts were cleaned.         |
| `FAIL`  | The lane ran but an assertion, transport operation, or cleanup failed.                          |
| `UNRUN` | The lane could not run because its prerequisites or an official automation surface were absent. |

Setup success, a fake transport pass, and an operator assertion never count as
a live Discord pass. Receipts exclude credentials, raw Discord IDs, channel
names, message bodies, docs queries/answers, and provider payloads.

## Live lanes

| Lane                       | Executor                                    | Observable proof                                                                                |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Eligible auto-thread       | Human-assisted source                       | Correlated source-message thread appears; actor bot only observes and cleans up.                |
| Filtered auto-thread       | Human-assisted source                       | No thread appears during the bounded observation window; actor bot only observes and cleans up. |
| Automated-author rejection | Automated actor bot                         | A substantive bot-authored message produces no thread.                                          |
| Retroactive CLI create     | Bot control CLI with human-authored fixture | Correlated thread appears; repeat reports already satisfied.                                    |
| Message action             | Human-assisted                              | Correlated thread appears after a maintainer invokes the action.                                |
| `/docs` public             | Human-assisted                              | Invoker checks a source-bearing response in a declared public docs channel.                     |
| `/docs` role-restricted    | Human-assisted                              | Contributor/maintainer succeeds and an unprivileged member is denied.                           |

Discord does not provide an official bot API for creating a human-authored
message, initiating application commands, or initiating message-context
actions. Automating a normal user account would be a prohibited self-bot.
Eligible/filtered automatic-thread sources and interaction lanes therefore
remain `UNRUN` until a human performs the named action through an explicitly
configured handoff broker. CLI execution remains automated, but its source
fixture must be human-authored. The actor bot may observe; human-authored source
messages and human-visible responses are returned to the broker for cleanup.
Its own message proves only automated-author rejection.

## Live safety boundary

The live runner must receive a versioned staging manifest. Credential fields in
that manifest are `op://` references, never secret values. Secret material is
injected into the process only through the approved 1Password workflow. A run
can write only after all of these checks pass:

1. environment is exactly `staging`;
2. `--live` and the exact write-confirmation phrase are present;
3. the selected channel is explicitly allowlisted;
4. the resolved channel belongs to the configured guild; and
5. its topic contains `livestore-discord-e2e-only`.

Every created artifact contains a run marker. Cleanup owns only artifacts that
were returned by this run and then correlated back to that marker, guild,
channel, and source message. A mismatched candidate is left untouched and
causes the lane to fail.

The non-secret manifest shape is:

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "actorBotTokenRef": "op://VAULT/ITEM/FIELD",
  "botControlSocket": "/run/discord-bot/staging/control.sock",
  "target": {
    "guildId": "111111111111111111",
    "channelId": "222222222222222222",
    "docsChannelIds": {
      "public": "222222222222222222",
      "restricted": "333333333333333333"
    },
    "allowedChannelIds": ["222222222222222222", "333333333333333333"],
    "requiredTopicSentinel": "livestore-discord-e2e-only",
    "pollIntervalMs": 1000,
    "timeoutMs": 30000
  }
}
```

`target.channelId` owns threading, message actions, and operator-control flows.
The docs lanes use their explicit `public` and `restricted` channel IDs. Every
distinct target is allowlisted and independently checked for the configured
guild and topic sentinel before the first write. The attended broker receives
the exact channel ID for each docs gesture; `location` remains descriptive and
does not grant routing authority.

Only the runtime's `StagingE2ERun` control operation is intentionally gated; the
runtime does not self-authorize E2E writes. Peer authentication and source
validation are current runtime checks. The executable boundary for the live
write is the standalone package script:

```text
pnpm e2e:live -- \
  --live \
  --manifest ./staging.json \
  --confirm-live-write I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING
```

With no lane option, the runner executes the full 11-scenario matrix. A staged
rollout can select exactly one named rung:

- `--rung tracer`: readiness preflight, then scenario 3
  (`automated-author-rejected`) and scenario 4 (`operator-retroactive`).
- `--rung unattended`: scenarios 3–6, the four automated lanes.
- `--rung attended`: scenarios 1, 2, and 7–11. Use this only with
  `--human-handoff-broker`; automatic eligible-message behavior requires an
  attended human and is never part of the unattended rung.
- `--rung full`: all 11 scenarios, equivalent to the default.

For a narrower diagnostic run, repeat `--scenario ID`, for example:

```text
pnpm e2e:live -- \
  --live \
  --manifest ./staging.json \
  --confirm-live-write I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING \
  --scenario automated-author-rejected \
  --scenario operator-retroactive
```

`--rung` and `--scenario` are mutually exclusive. Duplicate selections,
duplicate rungs, and unknown values are rejected before the manifest is read.
Every run still preflights each distinct target channel exactly once and emits
all 11 scenario receipts in matrix order. Unselected lanes are `UNRUN` with
reason `not-selected`. A transport or cleanup failure stops later selected
lanes as before; those lanes are `UNRUN` with `prerequisite-missing`, while
unselected lanes remain `not-selected`.

The run verdict aggregates selected lanes only, so a successful partial rung is
`PASS`; `not-selected` receipts preserve the full audit shape without changing
that verdict.

The Nix package exposes the same source entrypoint as
`livestore-discord-e2e`, so a deployed immutable package does not require pnpm
or a source checkout.

The executable never calls 1Password. An approved `op-proxy` wrapper must
resolve the manifest's `actorBotTokenRef` and inject the value as
`LIVESTORE_DISCORD_E2E_ACTOR_TOKEN` for that process. There is no token CLI
option. A missing injected token produces a sanitized `UNRUN` receipt.

The DFX adapter uses Discord REST only for actor/observation operations.
Retroactive creation crosses the real CLI boundary with the exact socket from
the admitted manifest (there is no default-socket fallback):

```text
livestore-discord thread create MESSAGE_URL \
  --environment staging --socket /run/discord-bot/staging/NAME.sock \
  --apply --reason TEXT --output json
```

`--socket` is a process-level transport override parsed before the CLI creates
its RPC client. It takes precedence over `LIVESTORE_DISCORD_CONTROL_SOCKET` and
the environment default; malformed or duplicate overrides fail before connect.


### Deploy targets

The manifest selects one operator transport, never both:

- **Unix control socket** (default): `botControlSocket` names an exact
  `.sock` under `/run/discord-bot/staging/`; retroactive creation crosses the
  installed `livestore-discord` CLI as described above.
- **Cloudflare edge admin plane**: set `botAdminEndpoint` instead of
  `botControlSocket` (see `fixtures/staging-cf.example.json`). Operator lanes
  then POST `{endpoint}/admin/rpc/ThreadCreate` with
  `Authorization: Bearer $LIVESTORE_DISCORD_ADMIN_TOKEN` — the token is read
  only from that environment variable, never a flag. A missing token produces
  `UNRUN`; there is no socket fallback.

### Attended human handoff

Pass `--human-handoff-broker EXECUTABLE` only while a named human is available
to complete the checklist. With no option, the executable is never spawned and
all seven human lanes remain `UNRUN`. This protocol is a coordination boundary,
not a user-account automation API: the broker must pause for a human using the
official Discord client and must never accept, resolve, or use a Discord user
token.

The runner invokes the executable as
`EXECUTABLE OPERATION --request-json JSON --run-id ID --ledger FILE`; the
run-scoped id keeps the crash ledger's record/resolve pairs matchable across
per-gesture invocations, and `recover-ledger --ledger FILE` validates and
deletes any unresolved artifacts after a crash. Supported operations are
`create-message`, `invoke-message-action`, `invoke-docs`, `delete-message`,
`delete-response`, and `resolve-thread`. `resolve-thread` performs no client
gesture: the runner calls it only after the actor-bot REST deletion succeeds,
so normal response, thread, and source cleanup all append the same exact
guild/channel/artifact identity as their creation record. Docs results return a
non-empty `responses` array because one interaction can produce multiple
follow-up messages; every correlated response is independently cleaned. Each
successful action response must attest its performer with either
`"attendedByHuman": true` or `"performedBy": "official-client-session"`, plus
the correlated IDs, marker, and channel fields represented by the E2E snapshots.
Client-driven cleanup additionally returns
`{ "attendedByHuman": true, "deleted": true, "id": "..." }` for the exact
requested artifact. Exit `7`, a missing attestation, or no human produces
`UNRUN`; invalid correlation or cleanup confirmation cannot produce `PASS`.
The broker receives no credentials from the runner.

A reference broker ships as `livestore-discord-e2e-broker` (source runner:
`node --experimental-strip-types e2e/src/attended-broker-main.ts`). It drives
the official Discord web client through the
`http-capture` browser-control seam, correlates exact artifact IDs through the
actor-bot REST read seam, and journals every created artifact into a private
mode-0600 per-run cleanup ledger (`--ledger FILE`) before acknowledging it.
Recovery addresses threads with `getChannel(threadId)`, which includes archived
and private threads, and requires the exact recorded thread, guild, and parent
before deletion. A `404` is resolved as already gone. Messages and responses
require the exact recorded guild/channel before `deleteMessage(channelId, id)`.
Each successful or already-gone artifact is resolved independently; failed
entries remain open for the next recovery pass.

The broker attests each gesture with either `"attendedByHuman": true` or
`"performedBy": "official-client-session"`; receipts never overclaim which
executor ran a lane. Gesture locators are calibrated against the live client in
the attended window before the matrix runs.

```text
pnpm e2e:live -- \
  --live \
  --manifest ./staging.json \
  --confirm-live-write I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING \
  --human-handoff-broker /opt/livestore/discord-human-handoff
```

The runner writes exactly one receipt to stdout. Its exit codes are `0` for
`PASS`, `1` for `FAIL`, `2` for invalid invocation or manifest, and `7` for
`UNRUN`. With no human callbacks, all human-assisted lanes remain `UNRUN`; the
runner never attempts self-bot automation.

Credential-free verification:

```text
pnpm exec tsc -p e2e/tsconfig.json --noEmit
pnpm exec vitest run e2e/src
```

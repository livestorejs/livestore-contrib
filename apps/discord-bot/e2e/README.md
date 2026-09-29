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

Receipt schema 2 keeps each lane's `assertions` (`passed`, `failed`, or
`not-reached`) separate from `cleanup` and the overall `verdict`. A failed
assertion remains `assertion-failed` even if cleanup also fails; passing
assertions with failed cleanup report `cleanup-failed`. Cleanup failures carry
only the artifact type and sanitized cause: REST status/Discord numeric code,
broker exit reason/code and gesture step index, or `unknown`. Neither content
nor credentials enter the receipt.

If a scenario operation throws, its `failure` identifies the attempted step
and a fixed error class/message category. Admin-plane errors additionally carry
the HTTP status and an allowlisted ControlResult tag when available. The
`serverMessage` is exact server-owned wording, or a server template with a
bounded code suffix; unrecognized messages become `other`. Raw response
bodies, arbitrary error messages, and credentials are never serialized.

Setup success, a fake transport pass, and an operator assertion never count as
a live Discord pass. Receipts exclude credentials, raw Discord IDs, channel
names, message bodies, docs queries/answers, and provider payloads.

## Live lanes

| Lane                       | Executor                                    | Observable proof                                                                                                     |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Eligible auto-thread       | Human-assisted source                       | Correlated thread appears; when `expectAiTitles` is true, its valid name differs from the deterministic local title. |
| Filtered auto-thread       | Human-assisted source                       | No thread appears during the bounded observation window; actor bot only observes and cleans up.                      |
| Automated-author rejection | Automated actor bot                         | A substantive bot-authored message produces no thread.                                                               |
| Retroactive CLI create     | Bot control CLI with human-authored fixture | Correlated thread appears; repeat reports already satisfied.                                                         |
| Message action             | Human-assisted                              | Correlated thread appears after a maintainer invokes the action.                                                     |
| `/docs` public             | Human-assisted                              | Invoker checks a source-bearing response in a declared public docs channel.                                          |
| `/docs` role-restricted    | Human-assisted                              | Contributor/maintainer succeeds and an unprivileged member is denied.                                                |

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
    "applicationId": "444444444444444444",
    "guildId": "111111111111111111",
    "channelId": "222222222222222222",
    "docsChannelIds": {
      "public": "222222222222222222",
      "restricted": "333333333333333333"
    },
    "allowedChannelIds": ["222222222222222222", "333333333333333333"],
    "expectAiTitles": false,
    "requiredTopicSentinel": "livestore-discord-e2e-only",
    "pollIntervalMs": 1000,
    "timeoutMs": 30000
  }
}
```

`target.applicationId` is the staging bot application that authors `/docs`
replies, not the actor bot that observes and cleans them. `target.channelId`
owns threading, message actions, and operator-control flows. The docs lanes
use their explicit `public` and `restricted` channel IDs. Every
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

Pass `--human-handoff-broker EXECUTABLE` only when the two dedicated,
authenticated official-client sessions have been prepared and an operator can
attend calibration or takeover. With no option, the executable is never spawned
and all seven attended lanes remain `UNRUN`. The broker drives the official
Discord web client through http-capture, never a Discord user token or user API.

The runner invokes the executable as
`EXECUTABLE OPERATION --request-json JSON --run-id ID --ledger FILE`; the
run-scoped id keeps the crash ledger's record/resolve pairs matchable across
per-gesture invocations, and `recover-ledger --ledger FILE` validates and
deletes any unresolved artifacts after a crash. Supported operations are
`create-message`, `invoke-message-action`, `invoke-docs`,
`resolve-message`, `resolve-response`, and `resolve-thread`. The E2E Actor
deletes every owned source, public response, and thread through Discord REST,
including human-authored messages; ephemeral replies have no REST deletion
operation. The broker drives only the human gestures under test. After
successful REST deletion (or Discord's already-gone `404`/`10008` for
messages), each `resolve-*` operation appends the exact guild/channel/artifact
identity to the broker ledger without performing a client gesture. Failed actor
deletions leave ledger entries open for recovery; the receipt records sanitized
REST status and Discord error code. Docs results return a non-empty `responses`
array because one interaction can produce multiple follow-up messages; each
public response is independently cleaned. Each successful action response
must attest its performer with either `"attendedByHuman": true` or
`"performedBy": "official-client-session"`, plus the marker and channel;
deletable responses also carry their correlated IDs. The broker receives no
credentials from the runner.

A reference broker ships as `livestore-discord-e2e-broker` (source runner:
`node --experimental-strip-types e2e/src/attended-broker-main.ts`). It drives
the official Discord web client through the
`http-capture` browser-control seam, correlates source, thread, and public `/docs`
reply IDs through the actor-bot REST read seam using the manifest target
application ID, and journals each deletable artifact into a private mode-0600
per-run cleanup ledger (`--ledger FILE`) before acknowledging it. Ephemeral
message-action replies and `/docs` denials are observed through projected
accessibility snapshots; they have no
REST-visible message ID and cannot be deleted by the actor. They are therefore
represented without an ID and never entered in the cleanup ledger.
Recovery addresses threads with `getChannel(threadId)`, which includes archived
and private threads, and requires the exact recorded thread, guild, and parent
before deletion. A `404` is resolved as already gone. Sources and non-ephemeral
responses require the exact recorded guild/channel before `deleteMessage(channelId, id)`.
Each successful or already-gone artifact is resolved independently; failed
entries remain open for the next recovery pass.

The bundled broker attests `"performedBy": "official-client-session"` and
uses two dedicated http-capture profiles: `e2e-maintainer` (with the docs
contributor/maintainer role) and `e2e-member` (unprivileged). Start and await
one accepted, authenticated official Discord web-client session per profile,
with declared Discord origins and `externalEffects: "allowed"`. Export their
UUIDs as `LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MAINTAINER` and
`LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MEMBER` in the broker process. The
`docs-denied` gesture (`persona: member`, `location: restricted`) uses the
member session; every other gesture uses the maintainer session. Missing or
invalid required session UUIDs decline with exit 7 (`UNRUN`); the old shared
`LIVESTORE_DISCORD_E2E_CAPTURE_SESSION`/`_EPOCH` configuration is unsupported.
The v2 CLI obtains the current `health.control.epoch` and embeds it in the
authority envelope on each browser invocation; it has no caller `--epoch`
option. Handback/control ownership must be checked before each attended run.

The broker calls `http-capture browser OPERATION SESSION_UUID --request FILE`
with a private request file and pipes fill values only into stdin. Message
history and deferred-reply settlement use the value-free `browser snapshot`
projection; the source-message precheck uses `browser locate` on the exact
source row ID and marker. Snapshots and worker-generated refs do not expose
Discord message IDs. Public `/docs` reply IDs are correlated with the staging
application's REST-visible messages created since the pre-gesture baseline;
the E2E actor bot reads and cleans these replies but is a different application.
Ephemeral replies require no ID. No `evaluate` or response-ID extraction from
capture receipts is required.

When Discord's "New in the Shop" or "Additional Protections for Teens"
announcement covers a channel after an account switch, the broker closes it
before interaction gestures; a visible message row behind a dialog is not
otherwise clickable. Unknown dialogs are not dismissed automatically.

Before enabling the attended matrix, inspect `browser snapshot` separately
for both sessions and calibrate every `uncalibrated` entry in
`e2e/src/attended-broker-driver.ts`'s `gestureLocators` table: channel
composer, message row and More menu, Apps action, `/docs` choice/query field,
and ephemeral reply row boundaries. Confirm each locator is unique. Do not run
write gestures just to guess a selector. HTTP Capture exposes click but no
hover or context-menu operation; if Discord's More control needs hover, that
gesture is blocked pending a supported capability or a freshly observed
click-accessible alternative and remains `UNRUN`.

```text
pnpm e2e:live -- \
  --live \
  --manifest ./staging.json \
  --confirm-live-write I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING \
  --human-handoff-broker livestore-discord-e2e-broker
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

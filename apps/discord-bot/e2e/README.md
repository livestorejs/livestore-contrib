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

| Verdict | Meaning |
| --- | --- |
| `PASS` | The named lane ran, its observable assertions passed, and owned artifacts were cleaned. |
| `FAIL` | The lane ran but an assertion, transport operation, or cleanup failed. |
| `UNRUN` | The lane could not run because its prerequisites or an official automation surface were absent. |

Setup success, a fake transport pass, and an operator assertion never count as
a live Discord pass. Receipts exclude credentials, raw Discord IDs, channel
names, message bodies, docs queries/answers, and provider payloads.

## Live lanes

| Lane | Executor | Observable proof |
| --- | --- | --- |
| Eligible auto-thread | Human-assisted source | Correlated source-message thread appears; actor bot only observes and cleans up. |
| Filtered auto-thread | Human-assisted source | No thread appears during the bounded observation window; actor bot only observes and cleans up. |
| Automated-author rejection | Automated actor bot | A substantive bot-authored message produces no thread. |
| Retroactive CLI create | Bot control CLI with human-authored fixture | Correlated thread appears; repeat reports already satisfied. |
| Message action | Human-assisted | Correlated thread appears after a maintainer invokes the action. |
| `/docs` public | Human-assisted | Invoker checks a source-bearing response in a declared public docs channel. |
| `/docs` role-restricted | Human-assisted | Contributor/maintainer succeeds and an unprivileged member is denied. |

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
    "allowedChannelIds": ["222222222222222222"],
    "requiredTopicSentinel": "livestore-discord-e2e-only",
    "pollIntervalMs": 1000,
    "timeoutMs": 30000
  }
}
```

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

### Attended human handoff

Pass `--human-handoff-broker EXECUTABLE` only while a named human is available
to complete the checklist. With no option, the executable is never spawned and
all seven human lanes remain `UNRUN`. This protocol is a coordination boundary,
not a user-account automation API: the broker must pause for a human using the
official Discord client and must never accept, resolve, or use a Discord user
token.

The runner invokes the executable as `EXECUTABLE OPERATION --request-json JSON`.
Supported operations are `create-message`, `invoke-message-action`,
`invoke-docs`, `delete-message`, and `delete-response`. Each successful action
response must contain `"attendedByHuman": true` plus the correlated IDs, marker,
and channel fields represented by the E2E snapshots. Cleanup additionally
returns `{ "attendedByHuman": true, "deleted": true, "id": "..." }` for the
exact requested artifact. Exit `7`, a missing attestation, or no human produces
`UNRUN`; invalid correlation or cleanup confirmation cannot produce `PASS`.
The broker receives no credentials from the runner.

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

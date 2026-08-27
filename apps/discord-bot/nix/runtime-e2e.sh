#!/usr/bin/env bash
set -euo pipefail

executable=${1:?usage: runtime-e2e.sh /path/to/livestore-discord}
root=$(mktemp -d "${TMPDIR:-/tmp}/livestore-discord-nix-e2e.XXXXXX")
runtime_pid=""
cleanup() {
  if [[ -n "$runtime_pid" ]]; then
    kill "$runtime_pid" 2>/dev/null || true
    wait "$runtime_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT

state="$root/state"
socket="$root/control.sock"
config="$root/runtime.json"
mkdir -p "$state"

node - "$state" "$socket" "$config" <<'NODE'
const [stateDirectory, controlSocketPath, configPath] = process.argv.slice(2)
const guildId = "100000000000000001"
const channelId = "100000000000000002"
const applicationId = "100000000000000010"
const config = {
  apiVersion: 1,
  payload: {
    _tag: "fake",
    environment: "staging",
    applicationId,
    commandScope: { _tag: "GuildCommandScope", applicationId, guildId },
    guildId,
    schemaVersion: 1,
    actionChannelIds: [channelId],
    aiTitleChannelIds: [],
    docsAudience: { publicChannelIds: [channelId], roleRestrictedChannelIds: [], contributorMaintainerRoleIds: [] },
    stagingOnlyChannelIds: [],
    botTokenSecretRef: "op://vault/discord/bot-credential",
    openAi: {
      projectId: "proj",
      serviceAccountSecretRef: "op://vault/openai/key",
      retentionPosture: "standard-store-false",
      limits: { requestsPerMemberPerHour: 10, requestsPerMinute: 2, inputTokensPerRequest: 40000, outputTokensPerRequest: 2000, monthlyCostUsdMicros: 1000000 },
    },
    releaseId: "nix-e2e",
    diagnostics: { sink: "cloudflare-provider", delivery: "best-effort", accessPolicyId: "cloudflare-access-policy/discord-bot-admin", retentionDays: 30 },
    e2e: { actorApplicationId: "100000000000000011", actorTokenSecretRef: "op://vault/discord/e2e", targetChannelId: channelId, requiredPurposeMarker: "livestore-discord-e2e-only" },
    legacyCommands: ["!help"],
    stateDirectory,
    controlSocketPath,
    health: { host: "127.0.0.1", port: 0 },
  },
}
require("node:fs").writeFileSync(configPath, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 })
NODE

"$executable" serve --config "$config" >"$root/runtime.log" 2>&1 &
runtime_pid=$!
for _ in $(seq 1 200); do
  if grep -q 'healthPort=' "$root/runtime.log"; then break; fi
  if ! kill -0 "$runtime_pid" 2>/dev/null; then
    cat "$root/runtime.log" >&2
    exit 1
  fi
  sleep 0.05
done
port=$(sed -n 's/.*healthPort=\([0-9][0-9]*\).*/\1/p' "$root/runtime.log" | tail -1)
[[ -n "$port" ]] || { cat "$root/runtime.log" >&2; exit 1; }

node - "$port" <<'NODE'
const port = process.argv[2]
for (let attempt = 0; attempt < 200; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`)
    if (response.ok) {
      const body = await response.json()
      if (body.ready !== true || body.state !== "ready") throw new Error(`unexpected readiness: ${JSON.stringify(body)}`)
      process.exit(0)
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 25))
}
throw new Error("installed executable did not become ready")
NODE

source_url="https://discord.com/channels/100000000000000001/100000000000000002/100000000000000003"
result=$(LIVESTORE_DISCORD_CONTROL_SOCKET="$socket" "$executable" thread create "$source_url" --environment staging --apply --reason nix-installed-e2e --name "Nix installed runtime" --output json)
node - "$result" <<'NODE'
const result = JSON.parse(process.argv[2])
if (result._tag !== "Success" || result.correlationId !== "100000000000000003") throw new Error(`unexpected create result: ${JSON.stringify(result)}`)
NODE
duplicate=$(LIVESTORE_DISCORD_CONTROL_SOCKET="$socket" "$executable" thread create "$source_url" --environment staging --apply --reason nix-installed-e2e --name "Nix installed runtime" --output json)
node - "$duplicate" <<'NODE'
const result = JSON.parse(process.argv[2])
if (result._tag !== "AlreadySatisfied") throw new Error(`unexpected duplicate result: ${JSON.stringify(result)}`)
NODE

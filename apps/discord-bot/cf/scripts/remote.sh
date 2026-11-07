#!/usr/bin/env bash
set -euo pipefail

mode=${1:?usage: remote.sh plan|deploy --stage staging|production [--allow-initial-create] [--yes]}
shift
stage=
bootstrap=false
alchemy_args=()
while (($#)); do
  case "$1" in
    --stage)
      [[ $# -ge 2 && ( "$2" == staging || "$2" == production ) ]] || exit 2
      stage=$2
      alchemy_args+=(--stage "$2")
      shift 2 ;;
    --allow-initial-create)
      bootstrap=true
      shift ;;
    --yes)
      [[ "$mode" == deploy ]] || exit 2
      alchemy_args+=(--yes)
      shift ;;
    *) printf 'Unsupported remote option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$mode" == plan || "$mode" == deploy ]] || exit 2
[[ "$stage" == staging || "$stage" == production ]] || { echo 'Explicit --stage required' >&2; exit 2; }
[[ "$bootstrap" == false || "$stage" == production ]] || exit 2
if [[ "$mode" == deploy && "$stage" == production && "${AGENT_ACTION_APPROVAL:-}" != deploy ]]; then
  echo 'Production deploy requires AGENT_ACTION_APPROVAL=deploy' >&2
  exit 2
fi
if [[ "$mode" == deploy && " ${alchemy_args[*]} " != *' --yes '* && ( "${ALCHEMY_TUI:-}" != 1 || "${ALCHEMY_PLAIN:-}" == 1 || "${ALCHEMY_NO_TUI:-}" == 1 ) ]]; then
  echo 'cf:deploy requires --yes or interactive ALCHEMY_TUI=1' >&2
  exit 2
fi
# Runbook invokes this script directly (not via a pnpm script), so expose the workspace binaries.
export PATH="$PWD/node_modules/.bin:$PATH"
export CF_DEPLOY_STAGE=$stage
if [[ "$bootstrap" == true ]]; then export CF_ALLOW_INITIAL_CREATE=1; else unset CF_ALLOW_INITIAL_CREATE; fi
verify_worker_interactions() {
  [[ "${CF_GATEWAY_TRANSPORT:-embedded}" == worker ]] || return 0
  node --experimental-strip-types cf/scripts/interactions-endpoint.ts "$stage" verify >/dev/null
}
node --experimental-strip-types cf/src/deploy-preflight.ts
verify_worker_interactions
if [[ "$bootstrap" == true ]]; then
  (cd cf && node --experimental-strip-types scripts/state-migrate.ts --assert-empty-production)
else
  (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative)
fi
plan_log=$(mktemp)
trap 'rm -f "$plan_log"' EXIT
alchemy plan cf/alchemy.run.ts --stage "$stage" 2>&1 | tee "$plan_log"
plan_args=(--stage "$stage")
if [[ "$bootstrap" == true ]]; then plan_args+=(--allow-initial-create); fi
node --experimental-strip-types cf/scripts/check-deploy-plan.ts "$plan_log" "${plan_args[@]}"
if [[ "$mode" == deploy ]]; then
  # Recheck absence/identity after plan, before the only mutating operation.
  node --experimental-strip-types cf/src/deploy-preflight.ts
  verify_worker_interactions
  if [[ "$bootstrap" == true ]]; then
    (cd cf && node --experimental-strip-types scripts/state-migrate.ts --assert-empty-production)
  else
    (cd cf && node --experimental-strip-types scripts/state-migrate.ts --verify-remote-authoritative)
  fi
  alchemy deploy cf/alchemy.run.ts "${alchemy_args[@]}"
fi

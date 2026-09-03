#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --project-name optiwork-local -f "${ROOT}/infra/docker-compose.yml")
STATE="${ROOT}/.optiwork/localnet"

log() { printf '[anchor-local] %s\n' "$*"; }
die() { printf '[anchor-local] ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

preflight() {
  require docker
  require algokit
  require curl
  require node
  require rg
  docker info >/dev/null 2>&1 || die 'Docker is not available'
  [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 24 ]] || die 'Node.js 24 is required'
}

ensure_algorand() {
  if curl -fsS --max-time 3 \
    -H 'X-Algo-API-Token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    http://127.0.0.1:4001/v2/status >/dev/null 2>&1; then return; fi
  if docker ps -a --filter 'label=com.docker.compose.project=algokit_sandbox' --format '{{.Names}}' | grep -q .; then
    log 'repairing only the unhealthy algokit_sandbox LocalNet project'
    algokit localnet reset --no-update
  else
    algokit localnet start
  fi
}

fabric_up() {
  "${ROOT}/blockchain/fabric/network/network.sh" up
}

render_runtime() {
  node "${ROOT}/scripts/generate-local-secrets.mjs" >/dev/null
  node "${ROOT}/scripts/render-local-runtime.mjs" >/dev/null
  local file
  for file in fabric-gateway.env algorand-executor.env api.env; do
    [[ "$(stat -c '%a' "${STATE}/${file}")" == 600 ]] || die "${file} must be owner-only"
  done
  [[ ! -e "${STATE}/runtime.env" ]] || die 'the legacy shared runtime.env must not exist'
}

deploy_algorand() {
  OPTIWORK_LOCAL_STATE_DIR="${STATE}" pnpm --dir "${ROOT}/services/algorand-executor" bootstrap:localnet
}

wait_stack() {
  log 'building host artifacts for the read-only Node 24 service runtime'
  pnpm --filter @optiwork/contracts \
    --filter @optiwork/domain \
    --filter @optiwork/fabric-gateway \
    --filter @optiwork/algorand-executor \
    --filter @optiwork/api \
    --filter @optiwork/web build
  # Next standalone excludes empty/static directories. Create the two nested
  # bind-mount targets before the read-only standalone tree is mounted.
  mkdir -p "${ROOT}/apps/web/.next/standalone/apps/web/public" \
    "${ROOT}/apps/web/.next/standalone/apps/web/.next/static"
  "${COMPOSE[@]}" --profile local up -d --wait --wait-timeout 300
  curl -fsS http://127.0.0.1:4200/health/ready >/dev/null
  curl -fsS http://127.0.0.1:4301/health/ready >/dev/null
  curl -fsS http://127.0.0.1:4000/health/live >/dev/null
  curl -fsS http://127.0.0.1:3000/ >/dev/null
}

verify_private_boundaries() {
  local prohibited='nova systemy|warsaw engineering lead|bengaluru contract engineer|pune procurement manager|leeds account manager|@|passport|resume|fullname|displayname|legalname|privatekey|mnemonic|objectid|objectkey|signedurl|deliverable/|document/'
  local gateway=optiwork-local-fabric-gateway-1 executor=optiwork-local-algorand-executor-1 api=optiwork-local-api-1
  local gateway_env executor_env api_env
  gateway_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${gateway}" | sed 's/=.*//')"
  executor_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${executor}" | sed 's/=.*//')"
  api_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${api}" | sed 's/=.*//')"
  grep -qx FABRIC_PERMIT_PRIVATE_JWK_JSON <<<"${gateway_env}" || die 'the Gateway did not receive its private permit JWK'
  grep -qx FABRIC_PERMIT_PUBLIC_JWK_JSON <<<"${executor_env}" || die 'the executor did not receive the public permit JWK'
  if grep -qx FABRIC_PERMIT_PRIVATE_JWK_JSON <<<"${executor_env}"; then die 'the executor received the private permit JWK'; fi
  if grep -Eq 'FABRIC_PERMIT_(PRIVATE|PUBLIC)_JWK_JSON|ALGORAND_.*PRIVATE|ALGORAND_ORIGIN_PROVIDER_TREASURIES_JSON' <<<"${api_env}"; then
    die 'the API received signing material'
  fi
  if grep -Eq 'ALGORAND_.*PRIVATE|ALGORAND_ORIGIN_PROVIDER_TREASURIES_JSON' <<<"${gateway_env}"; then
    die 'the Fabric Gateway received Algorand signing material'
  fi
  for container in "${gateway}" "${executor}" "${api}"; do
    docker exec "${container}" test ! -e /workspace/.optiwork || die "${container} can access generated local secrets"
  done
  if docker exec optiwork-local-postgres-1 psql -U optiwork -d optiwork_executor -Atc \
    "SELECT COALESCE(jsonb_agg(permit_claims)::text, '[]') FROM algorand_executor_commands" | rg -i "${prohibited}"; then
    die 'a permit claim contains personal, signing or raw file data'
  fi
  if "${COMPOSE[@]}" --profile local logs --no-color api fabric-gateway algorand-executor | rg -i "${prohibited}"; then
    die 'a scoped application log contains personal, signing or raw file data'
  fi
  log 'key isolation and privacy scans passed for all workload boundaries'
}

up() {
  preflight
  ensure_algorand
  fabric_up
  node "${ROOT}/scripts/generate-local-secrets.mjs" >/dev/null
  [[ -f "${STATE}/algorand-deployment.json" && -f "${STATE}/algorand-accounts.json" ]] || deploy_algorand
  render_runtime
  wait_stack
  log 'all real LocalNet services are ready'
}

e2e() {
  preflight
  ensure_algorand
  fabric_up
  node "${ROOT}/scripts/generate-local-secrets.mjs" >/dev/null
  # Only Anchor's disposable API/executor databases and object bucket are reset.
  # The HardCoders networks, volumes and containers are never enumerated here.
  "${COMPOSE[@]}" --profile local down --volumes --remove-orphans >/dev/null 2>&1 || true
  deploy_algorand
  render_runtime
  wait_stack
  node "${ROOT}/scripts/verify-local-e2e.mjs"
  node "${ROOT}/scripts/verify-fabric-authorization.mjs"
  verify_private_boundaries
  local browser=''
  for candidate in "${CHROME_BIN:-}" google-chrome-stable google-chrome chromium chromium-browser; do
    if [[ -n "${candidate}" ]] && command -v "${candidate}" >/dev/null 2>&1; then browser="$(command -v "${candidate}")"; break; fi
  done
  if [[ -n "${browser}" ]]; then
    node "${ROOT}/scripts/verify-browser-smoke.mjs" "${browser}"
    log 'browser smoke clicked the run action and passed all five dashboards'
  fi
  log 'real LocalNet E2E passed; services remain available at http://127.0.0.1:3000'
}

down() {
  preflight
  "${COMPOSE[@]}" --profile local down --remove-orphans
  "${ROOT}/blockchain/fabric/network/network.sh" down
  log 'stopped only Anchor application and OptiWork-isolated Fabric containers; AlgoKit LocalNet remains available'
}

status() {
  preflight
  "${COMPOSE[@]}" --profile local ps || true
  "${ROOT}/blockchain/fabric/network/network.sh" status || true
  algokit localnet status || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  e2e) e2e ;;
  *) die 'usage: scripts/local.sh up|down|status|e2e' ;;
esac

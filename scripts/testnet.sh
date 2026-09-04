#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE24_ROOT="${NVM_DIR:-/home/infinity/.nvm}/versions/node/v24.19.0/bin"
if [[ "$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null || true)" != 24 && -x "${NODE24_ROOT}/node" ]]; then
  export PATH="${NODE24_ROOT}:${PATH}"
fi

BASE_COMPOSE=(docker compose --project-name optiwork-local -f "${ROOT}/infra/docker-compose.yml")
COMPOSE=(docker compose --project-name optiwork-testnet -f "${ROOT}/infra/docker-compose.yml" -f "${ROOT}/infra/docker-compose.testnet.yml")
if [[ -f "${ROOT}/.env" ]]; then
  BASE_COMPOSE+=(--env-file "${ROOT}/.env")
  COMPOSE+=(--env-file "${ROOT}/.env")
fi
STATE="${ROOT}/.optiwork/testnet"
ACCOUNTS="${ROOT}/services/algorand-executor/generated-credentials/testnet-accounts.json"

log() { printf '[anchor-testnet] %s\n' "$*"; }
die() { printf '[anchor-testnet] ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

preflight() {
  require docker
  require curl
  require jq
  require node
  docker info >/dev/null 2>&1 || die 'Docker is not available'
  [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 24 ]] || die 'Node.js 24 is required'
  [[ -f "${STATE}/algorand-deployment.json" ]] || die 'The pinned TestNet deployment manifest is missing'
  [[ -f "${ACCOUNTS}" ]] || die 'The guarded TestNet account file is missing'
  [[ "$(stat -c '%a' "${ACCOUNTS}")" == 600 ]] || die 'The TestNet account file must be owner-only (chmod 600)'
  [[ "$(jq -r '.network' "${STATE}/algorand-deployment.json")" == testnet ]] || die 'The deployment manifest is not TestNet'
  [[ "$(jq -r '.assetId' "${STATE}/algorand-deployment.json")" == 10458941 ]] || die 'TestNet must use official Circle USDC ASA 10458941'
}

check_public_funding() {
  local deployer origin application deployer_algo origin_algo origin_usdc application_algo application_minimum application_available
  deployer="$(jq -r '.deployer.address' "${ACCOUNTS}")"
  origin="$(jq -r '.originProviderTreasury.address' "${ACCOUNTS}")"
  application="$(jq -r '.applicationAddress' "${STATE}/algorand-deployment.json")"
  deployer_algo="$(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${deployer}" | jq -r '.amount')"
  read -r origin_algo origin_usdc < <(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${origin}" | jq -r '[.amount, ((.assets // [] | map(select(."asset-id" == 10458941)) | .[0].amount) // 0)] | @tsv')
  read -r application_algo application_minimum < <(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${application}" | jq -r '[.amount, ."min-balance"] | @tsv')
  application_available=$((application_algo - application_minimum))
  (( deployer_algo >= 1000000 )) || die 'The disposable TestNet executor needs at least 1 TestAlgo for the acceptance run'
  (( origin_algo >= 100000 )) || die 'The TestNet origin treasury needs more TestAlgo for transaction fees'
  (( origin_usdc >= 5000000 )) || die 'The TestNet origin treasury needs at least 5 zero-value TestNet USDC'
  (( application_available >= 250000 )) || die 'The TestNet ARC-4 application needs at least 0.25 TestAlgo above its current box minimum balance'
  log "public funding ready: executor $((deployer_algo / 1000000)) TestAlgo; origin $((origin_usdc / 1000000)) TestNet USDC; app reserve ${application_available} microAlgo"
}

render_runtime() {
  OPTIWORK_LOCAL_STATE_DIR="${STATE}" node "${ROOT}/scripts/generate-local-secrets.mjs" >/dev/null
  node "${ROOT}/scripts/render-testnet-runtime.mjs" >/dev/null
  local file
  for file in fabric-gateway.env algorand-executor.env api.env; do
    [[ "$(stat -c '%a' "${STATE}/${file}")" == 600 ]] || die "${file} must be owner-only"
  done
}

build() {
  log 'building pinned host artifacts with Node.js 24'
  corepack pnpm --filter @optiwork/contracts \
    --filter @optiwork/domain \
    --filter @optiwork/fabric-gateway \
    --filter @optiwork/algorand-executor \
    --filter @optiwork/api \
    --filter @optiwork/marketing \
    --filter @optiwork/web build
  mkdir -p "${ROOT}/apps/web/.next/standalone/apps/web/public" \
    "${ROOT}/apps/web/.next/standalone/apps/web/.next/static"
}

wait_stack() {
  "${COMPOSE[@]}" --profile local up -d --wait --wait-timeout 360
  curl -fsS http://127.0.0.1:4200/health/ready >/dev/null
  curl -fsS http://127.0.0.1:4301/health/ready >/dev/null
  local health
  health="$(curl -fsS http://127.0.0.1:4000/health/live)"
  [[ "$(jq -r '.network' <<<"${health}")" == testnet ]] || die 'The API did not start in TestNet mode'
  [[ "$(jq -r '.adapters.algorand' <<<"${health}")" == executor ]] || die 'The API is not using the real executor'
  curl -fsS http://127.0.0.1:4175/api/workflow/steps >/dev/null
}

up() {
  preflight
  check_public_funding
  "${ROOT}/blockchain/fabric/network/network.sh" up
  render_runtime
  build
  # Free the canonical browser/API ports while preserving every LocalNet volume.
  "${BASE_COMPOSE[@]}" --profile local down --remove-orphans >/dev/null 2>&1 || true
  wait_stack
  log 'public TestNet settlement runtime ready at http://127.0.0.1:4175'
}

e2e() {
  preflight
  check_public_funding
  "${ROOT}/blockchain/fabric/network/network.sh" up
  render_runtime
  build
  "${BASE_COMPOSE[@]}" --profile local down --remove-orphans >/dev/null 2>&1 || true
  # Reset only Anchor's disposable TestNet acceptance databases and MinIO data.
  "${COMPOSE[@]}" --profile local down --volumes --remove-orphans >/dev/null 2>&1 || true
  wait_stack
  node "${ROOT}/scripts/verify-testnet-e2e.mjs"
  log 'full Fabric + public Algorand TestNet E2E passed; browser remains available at http://127.0.0.1:4175'
}

down() {
  preflight
  "${COMPOSE[@]}" --profile local down --remove-orphans
  log 'stopped only the Anchor TestNet application stack; Fabric and LocalNet rollback data remain intact'
}

status() {
  preflight
  "${COMPOSE[@]}" --profile local ps || true
  curl -fsS http://127.0.0.1:4000/health/live | jq '{profile,network,adapters}' || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  e2e) e2e ;;
  *) die 'usage: scripts/testnet.sh up|down|status|e2e' ;;
esac

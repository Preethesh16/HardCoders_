#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ANCHOR_HOSTED_ENV_FILE:-${ROOT}/.env.hosted}"
STATE="${ROOT}/.optiwork/testnet"
HOSTED_STATE="${ROOT}/.optiwork/hosted"
ACCOUNTS="${ROOT}/services/algorand-executor/generated-credentials/testnet-accounts.json"
SUPABASE_CA="${STATE}/supabase-ca.crt"
COMPOSE=(docker compose --project-name anchor-hosted --env-file "${ENV_FILE}" -f "${ROOT}/infra/docker-compose.hosted.yml")

log() { printf '[anchor-hosted] %s\n' "$*"; }
die() { printf '[anchor-hosted] ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
env_value() { sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1 | sed "s/^'//;s/'$//"; }
env_present() { grep -Eq "^$1=.+" "${ENV_FILE}"; }

preflight() {
  require docker
  require curl
  require jq
  require node
  require openssl
  require tar
  docker info >/dev/null 2>&1 || die 'Docker is not available'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
  [[ "$(uname -m)" == x86_64 ]] || die 'The hosted profile is pinned to an AMD/x86-64 Droplet'
  [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 24 ]] || die 'Node.js 24 is required'
  [[ -f "${ENV_FILE}" ]] || die "copy infra/hosted.env.example to ${ENV_FILE} and populate it"
  [[ "$(stat -c '%a' "${ENV_FILE}")" == 600 ]] || die "${ENV_FILE} must be owner-only (chmod 600)"

  local required
  for required in ANCHOR_DOMAIN ACME_EMAIL ANCHOR_BASIC_AUTH_USER ANCHOR_BASIC_AUTH_HASH SUPABASE_DATABASE_URL MINIO_ROOT_USER MINIO_ROOT_PASSWORD OPENAI_API_KEY; do
    env_present "${required}" || die "${required} is missing from ${ENV_FILE}"
  done
  grep -Eq 'REPLACE_|example\.com|PROJECT_REF|ROTATED_PASSWORD|REGION' "${ENV_FILE}" \
    && die "${ENV_FILE} still contains placeholder values"
  [[ "$(env_value ANCHOR_BASIC_AUTH_HASH)" == \$2* ]] || die 'ANCHOR_BASIC_AUTH_HASH must be a bcrypt hash'
  [[ "$(env_value SUPABASE_DATABASE_URL)" == postgresql://* ]] || die 'SUPABASE_DATABASE_URL must be a PostgreSQL URI'
  [[ "$(env_value SUPABASE_DATABASE_URL)" != *'?'* && "$(env_value SUPABASE_DATABASE_URL)" != *'#'* ]] \
    || die 'SUPABASE_DATABASE_URL must not contain a query or fragment'
  [[ "$(env_value OPENAI_API_KEY)" =~ ^sk-[A-Za-z0-9_-]{20,500}$ ]] \
    || die 'OPENAI_API_KEY does not look like one OpenAI API key; run scripts/hosted.sh openai-key'

  [[ -f "${STATE}/algorand-deployment.json" ]] || die 'the pinned TestNet deployment manifest is missing'
  [[ -f "${ACCOUNTS}" ]] || die 'the guarded TestNet account file is missing'
  [[ "$(stat -c '%a' "${ACCOUNTS}")" == 600 ]] || die 'the TestNet account file must have mode 600'
  [[ "$(jq -r '.network' "${STATE}/algorand-deployment.json")" == testnet ]] || die 'the deployment manifest is not TestNet'
  [[ "$(jq -r '.assetId' "${STATE}/algorand-deployment.json")" == 10458941 ]] || die 'the settlement asset is not Circle TestNet USDC'
  [[ "$(jq -r '.applicationId' "${STATE}/algorand-deployment.json")" == 770960502 ]] || die 'the deployment is not the pinned Anchor application'
  if [[ ! -f "${STATE}/fabric-gateway.env" || ! -f "${STATE}/algorand-executor.env" || ! -f "${STATE}/api.env" ]]; then
    log 'generating owner-only workload environment files for first startup'
    render_runtime
  fi
  "${COMPOSE[@]}" config --quiet
  log 'preflight passed without printing any secret value'
}

ensure_supabase_ca() {
  if [[ ! -f "${SUPABASE_CA}" ]]; then
    curl -fsSL --max-time 30 \
      'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt' \
      -o "${SUPABASE_CA}"
  fi
  openssl x509 -in "${SUPABASE_CA}" -noout -checkend 86400 >/dev/null \
    || die 'the Supabase CA is invalid or expires within 24 hours'
  [[ "$(openssl x509 -in "${SUPABASE_CA}" -noout -subject)" == *'Supabase Root 2021 CA'* ]] \
    || die 'the database CA is not the expected Supabase Root 2021 CA'
  chmod 644 "${SUPABASE_CA}"
}

check_public_funding() {
  local executor origin application executor_algo origin_algo origin_usdc app_algo app_minimum
  executor="$(jq -r '.deployer.address' "${ACCOUNTS}")"
  origin="$(jq -r '.originProviderTreasury.address' "${ACCOUNTS}")"
  application="$(jq -r '.applicationAddress' "${STATE}/algorand-deployment.json")"
  executor_algo="$(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${executor}" | jq -r '.amount')"
  read -r origin_algo origin_usdc < <(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${origin}" | jq -r '[.amount, ((.assets // [] | map(select(."asset-id" == 10458941)) | .[0].amount) // 0)] | @tsv')
  read -r app_algo app_minimum < <(curl -fsS --max-time 30 "https://testnet-api.algonode.cloud/v2/accounts/${application}" | jq -r '[.amount, ."min-balance"] | @tsv')
  (( executor_algo >= 1000000 )) || die 'the TestNet executor needs at least 1 TestAlgo'
  (( origin_algo >= 100000 )) || die 'the origin treasury needs TestAlgo for fees'
  (( origin_usdc >= 5000000 )) || die 'the origin treasury needs at least 5 TestNet USDC'
  (( app_algo >= app_minimum )) || die 'the application account is below its minimum balance'
  log "TestNet funding is ready (executor ALGO, origin USDC and application reserve checked)"
}

render_runtime() {
  mkdir -p "${HOSTED_STATE}/workflow"
  chmod 700 "${HOSTED_STATE}" "${HOSTED_STATE}/workflow"
  OPTIWORK_LOCAL_STATE_DIR="${STATE}" node "${ROOT}/scripts/generate-local-secrets.mjs" >/dev/null
  node "${ROOT}/scripts/render-testnet-runtime.mjs" >/dev/null
  local file
  for file in fabric-gateway.env algorand-executor.env api.env; do
    [[ "$(stat -c '%a' "${STATE}/${file}")" == 600 ]] || die "${file} must have mode 600"
  done
}

up() {
  preflight
  ensure_supabase_ca
  check_public_funding
  log 'starting the private Fabric network'
  "${ROOT}/blockchain/fabric/network/network.sh" up
  render_runtime
  corepack pnpm --filter @optiwork/algorand-executor ensure:testnet-reserve \
    "${ACCOUNTS}" "${STATE}/algorand-deployment.json"
  log 'building immutable application images and starting the hosted stack'
  "${COMPOSE[@]}" up -d --build --wait --wait-timeout 600
  "${COMPOSE[@]}" exec -T marketing node -e \
    "fetch('http://127.0.0.1:4175/api/workflow/steps').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  log "Anchor is running at https://$(env_value ANCHOR_DOMAIN)"
}

status() {
  preflight
  "${COMPOSE[@]}" ps
  "${ROOT}/blockchain/fabric/network/network.sh" status
  curl -fsS --max-time 15 "https://$(env_value ANCHOR_DOMAIN)/healthz" >/dev/null \
    && log 'public HTTPS health check passed' \
    || log 'public HTTPS is not ready; verify DNS propagation and Caddy logs'
}

logs() {
  preflight
  "${COMPOSE[@]}" logs --tail 200 "${@:2}"
}

down() {
  preflight
  "${COMPOSE[@]}" down --remove-orphans
  log 'application containers stopped; MinIO, Caddy and Fabric data were retained'
}

backup() {
  preflight
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${ROOT}/.optiwork/backups/${stamp}"
  mkdir -p "${backup_dir}"
  chmod 700 "${ROOT}/.optiwork/backups" "${backup_dir}"
  docker volume inspect anchor-hosted-minio-data >/dev/null 2>&1 \
    || die 'the hosted MinIO volume does not exist'
  docker run --rm --pull=missing \
    -v anchor-hosted-minio-data:/source:ro -v "${backup_dir}:/backup" \
    alpine:3.22.1 tar -C /source -czf /backup/minio-data.tar.gz .
  docker run --rm --pull=missing \
    -v "${ROOT}/blockchain/fabric/network/generated:/source:ro" -v "${backup_dir}:/backup" \
    alpine:3.22.1 tar -C /source -czf /backup/fabric-generated.tar.gz .
  tar -C "${HOSTED_STATE}" -czf "${backup_dir}/workflow-state.tar.gz" workflow
  sha256sum "${backup_dir}"/*.tar.gz >"${backup_dir}/SHA256SUMS"
  chmod 600 "${backup_dir}"/*
  log "encrypted off-host storage is still required; local backup created at ${backup_dir}"
}

update_openai_key() {
  require curl
  [[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} does not exist"
  local key status temporary line replaced=false
  IFS= read -r -s -p 'Paste the new OpenAI API key (input is hidden), then press Enter: ' key
  printf '\n'
  [[ "${key}" =~ ^sk-[A-Za-z0-9_-]{20,500}$ ]] \
    || die 'that input is not one valid-looking OpenAI API key'
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer ${key}" https://api.openai.com/v1/models)"
  [[ "${status}" == 200 ]] || die "OpenAI rejected the key (HTTP ${status}); the existing server value was not changed"
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "${temporary}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" == OPENAI_API_KEY=* ]]; then
      printf 'OPENAI_API_KEY=%s\n' "${key}" >>"${temporary}"
      replaced=true
    else
      printf '%s\n' "${line}" >>"${temporary}"
    fi
  done <"${ENV_FILE}"
  [[ "${replaced}" == true ]] || printf 'OPENAI_API_KEY=%s\n' "${key}" >>"${temporary}"
  mv "${temporary}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  key=''
  render_runtime
  "${COMPOSE[@]}" up -d --force-recreate --wait --wait-timeout 180 api
  log 'OpenAI key verified, saved, and loaded by the API without printing it'
}

case "${1:-}" in
  preflight) preflight ;;
  up) up ;;
  status) status ;;
  logs) logs "$@" ;;
  down) down ;;
  backup) backup ;;
  openai-key) update_openai_key ;;
  *) die 'usage: scripts/hosted.sh preflight|up|status|logs [service]|down|backup|openai-key' ;;
esac

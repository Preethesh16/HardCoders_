#!/usr/bin/env bash
# Reduced from the HardCoders Fabric framework at
# 47ecba560c42a29280852731846286edc1136c5a. This script owns only resources
# prefixed optiwork-* and never enumerates or stops another Docker project.
set -Eeuo pipefail

NETWORK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FABRIC_DIR="$(cd -- "${NETWORK_DIR}/.." && pwd)"
GENERATED="${NETWORK_DIR}/generated"
VERSIONS="${NETWORK_DIR}/versions.env"
SECRETS="${GENERATED}/secrets.env"
CHANNEL=optiwork-channel
CHAINCODE=optiwork-evidence
CHAINCODE_VERSION=1.1
CHAINCODE_SEQUENCE=1
NETWORK=optiwork-fabric-local

set -a
# shellcheck disable=SC1090
source "${VERSIONS}"
set +a

log() { printf '[optiwork-fabric] %s\n' "$*"; }
die() { printf '[optiwork-fabric] ERROR: %s\n' "$*" >&2; exit 1; }
compose_ca() { docker compose --project-name optiwork-fabric-ca --env-file "${VERSIONS}" --env-file "${SECRETS}" -f "${NETWORK_DIR}/compose-ca.yml" "$@"; }
compose_net() { docker compose --project-name optiwork-fabric-network --env-file "${VERSIONS}" -f "${NETWORK_DIR}/compose-network.yml" "$@"; }

wait_healthy() {
  local container="$1" state
  for _ in $(seq 1 60); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container}" 2>/dev/null || true)"
    [[ "${state}" == healthy ]] && return 0
    [[ "${state}" == unhealthy || "${state}" == exited || "${state}" == dead ]] && {
      docker logs --tail 80 "${container}" >&2 || true
      die "${container} entered ${state}"
    }
    sleep 2
  done
  die "timed out waiting for ${container}"
}

generate_secrets() {
  [[ -f "${SECRETS}" ]] && return
  mkdir -p "${GENERATED}"
  umask 077
  {
    for name in ORDERER_CA_ADMIN_PASSWORD BUYER_CA_ADMIN_PASSWORD SELLER_CA_ADMIN_PASSWORD ORDERER_NODE_SECRET ORDERER_ADMIN_SECRET BUYER_PEER_SECRET BUYER_ADMIN_SECRET BUYER_APP_SECRET READER_APP_SECRET SELLER_PEER_SECRET SELLER_ADMIN_SECRET SELLER_APP_SECRET; do
      printf '%s=%s\n' "${name}" "$(openssl rand -hex 24)"
    done
  } >"${SECRETS}"
  chmod 600 "${SECRETS}"
}

ca_client() {
  local service="$1" home="$2"; shift 2
  compose_ca exec -T --user "$(id -u):$(id -g)" -e HOME=/tmp -e "FABRIC_CA_CLIENT_HOME=${home}" "${service}" fabric-ca-client --loglevel error "$@"
}

single_file() {
  local file
  file="$(find "$1" -maxdepth 1 -type f -print -quit)"
  [[ -n "${file}" ]] || die "missing identity material in $1"
  printf '%s' "${file}"
}

normalize_msp() {
  local dir="$1" ca cert key
  ca="$(single_file "${dir}/cacerts")"; cert="$(single_file "${dir}/signcerts")"; key="$(single_file "${dir}/keystore")"
  [[ "${ca}" == "${dir}/cacerts/ca-cert.pem" ]] || mv "${ca}" "${dir}/cacerts/ca-cert.pem"
  [[ "${cert}" == "${dir}/signcerts/cert.pem" ]] || mv "${cert}" "${dir}/signcerts/cert.pem"
  [[ "${key}" == "${dir}/keystore/key.pem" ]] || mv "${key}" "${dir}/keystore/key.pem"
  cp "${NETWORK_DIR}/config/msp-config.yaml" "${dir}/config.yaml"
}

normalize_tls() {
  local dir="$1" kind="$2" cert key ca
  cert="$(single_file "${dir}/signcerts")"; key="$(single_file "${dir}/keystore")"; ca="$(single_file "${dir}/tlscacerts")"
  cp "${ca}" "${dir}/ca.crt"
  if [[ "${kind}" == server ]]; then mv "${cert}" "${dir}/server.crt"; mv "${key}" "${dir}/server.key";
  else mv "${cert}" "${dir}/client.crt"; mv "${key}" "${dir}/client.key"; fi
  rm -r "${dir}/cacerts" "${dir}/keystore" "${dir}/signcerts" "${dir}/tlscacerts" "${dir}/user" 2>/dev/null || true
}

register() {
  local service="$1" home="$2" ca_name="$3" name="$4" secret="$5" type="$6" attrs="${7:-}"
  local args=(register --caname "${ca_name}" --id.name "${name}" --id.secret "${secret}" --id.type "${type}" --tls.certfiles /etc/hyperledger/fabric-ca-server/tls-cert.pem)
  [[ -n "${attrs}" ]] && args+=(--id.attrs "${attrs}")
  ca_client "${service}" "${home}" "${args[@]}" >/dev/null
}

enroll() {
  local service="$1" home="$2" ca_name="$3" name="$4" secret="$5" target="$6"
  ca_client "${service}" "${home}" enroll -u "https://${name}:${secret}@localhost:7054" --caname "${ca_name}" --mspdir "${target}" --tls.certfiles /etc/hyperledger/fabric-ca-server/tls-cert.pem
}

enroll_tls() {
  local service="$1" home="$2" ca_name="$3" name="$4" secret="$5" target="$6" host="$7"
  ca_client "${service}" "${home}" enroll -u "https://${name}:${secret}@localhost:7054" --caname "${ca_name}" --mspdir "${target}" --enrollment.profile tls --csr.hosts "${host}" --csr.hosts localhost --tls.certfiles /etc/hyperledger/fabric-ca-server/tls-cert.pem
}

bootstrap_orderer() {
  local home=/work/ca-client/orderer root="${GENERATED}/organizations/ordererOrganizations/optiwork.local"
  mkdir -p "${GENERATED}/ca-client/orderer"
  ca_client ca-orderer "${home}" enroll -u "https://admin:${ORDERER_CA_ADMIN_PASSWORD}@localhost:7054" --caname ca-orderer --tls.certfiles /etc/hyperledger/fabric-ca-server/tls-cert.pem
  register ca-orderer "${home}" ca-orderer orderer "${ORDERER_NODE_SECRET}" orderer
  register ca-orderer "${home}" ca-orderer orderer-admin "${ORDERER_ADMIN_SECRET}" admin 'optiwork.role=admin:ecert'
  enroll ca-orderer "${home}" ca-orderer orderer "${ORDERER_NODE_SECRET}" /work/organizations/ordererOrganizations/optiwork.local/orderers/orderer.optiwork.local/msp
  enroll_tls ca-orderer "${home}" ca-orderer orderer "${ORDERER_NODE_SECRET}" /work/organizations/ordererOrganizations/optiwork.local/orderers/orderer.optiwork.local/tls orderer.optiwork.local
  enroll ca-orderer "${home}" ca-orderer orderer-admin "${ORDERER_ADMIN_SECRET}" /work/organizations/ordererOrganizations/optiwork.local/users/Admin@optiwork.local/msp
  enroll_tls ca-orderer "${home}" ca-orderer orderer-admin "${ORDERER_ADMIN_SECRET}" /work/organizations/ordererOrganizations/optiwork.local/users/Admin@optiwork.local/tls localhost
  normalize_msp "${root}/orderers/orderer.optiwork.local/msp"; normalize_tls "${root}/orderers/orderer.optiwork.local/tls" server
  normalize_msp "${root}/users/Admin@optiwork.local/msp"; normalize_tls "${root}/users/Admin@optiwork.local/tls" client
  mkdir -p "${root}/msp/cacerts" "${root}/msp/tlscacerts"
  cp "${root}/orderers/orderer.optiwork.local/msp/cacerts/ca-cert.pem" "${root}/msp/cacerts/ca-cert.pem"
  cp "${root}/orderers/orderer.optiwork.local/tls/ca.crt" "${root}/msp/tlscacerts/tls-ca-cert.pem"
  cp "${NETWORK_DIR}/config/msp-config.yaml" "${root}/msp/config.yaml"
}

bootstrap_peer_org() {
  local key="$1" service="$2" ca="$3" domain="$4" peer_host="$5" peer_secret="$6" admin_secret="$7"
  local home root
  home="/work/ca-client/${key}"
  root="${GENERATED}/organizations/peerOrganizations/${domain}"
  mkdir -p "${GENERATED}/ca-client/${key}"
  local admin_var="${key^^}_CA_ADMIN_PASSWORD"; admin_var="${admin_var//-/_}"
  ca_client "${service}" "${home}" enroll -u "https://admin:${!admin_var}@localhost:7054" --caname "${ca}" --tls.certfiles /etc/hyperledger/fabric-ca-server/tls-cert.pem
  register "${service}" "${home}" "${ca}" peer0 "${peer_secret}" peer
  register "${service}" "${home}" "${ca}" orgadmin "${admin_secret}" admin 'optiwork.role=admin:ecert'
  enroll "${service}" "${home}" "${ca}" peer0 "${peer_secret}" "/work/organizations/peerOrganizations/${domain}/peers/${peer_host}/msp"
  enroll_tls "${service}" "${home}" "${ca}" peer0 "${peer_secret}" "/work/organizations/peerOrganizations/${domain}/peers/${peer_host}/tls" "${peer_host}"
  enroll "${service}" "${home}" "${ca}" orgadmin "${admin_secret}" "/work/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp"
  normalize_msp "${root}/peers/${peer_host}/msp"; normalize_tls "${root}/peers/${peer_host}/tls" server
  normalize_msp "${root}/users/Admin@${domain}/msp"
  mkdir -p "${root}/msp/cacerts" "${root}/msp/tlscacerts"
  cp "${root}/peers/${peer_host}/msp/cacerts/ca-cert.pem" "${root}/msp/cacerts/ca-cert.pem"
  cp "${root}/peers/${peer_host}/tls/ca.crt" "${root}/msp/tlscacerts/tls-ca-cert.pem"
  cp "${NETWORK_DIR}/config/msp-config.yaml" "${root}/msp/config.yaml"
}

app_identity() {
  local key="$1" service="$2" ca="$3" domain="$4" name="$5" secret="$6" role="$7" home
  home="/work/ca-client/${key}"
  register "${service}" "${home}" "${ca}" "${name}" "${secret}" client "optiwork.role=${role}:ecert"
  enroll "${service}" "${home}" "${ca}" "${name}" "${secret}" "/work/organizations/peerOrganizations/${domain}/users/${name}@${domain}/msp"
  normalize_msp "${GENERATED}/organizations/peerOrganizations/${domain}/users/${name}@${domain}/msp"
}

bootstrap_identities() {
  [[ -f "${GENERATED}/.identities-complete" ]] && return
  bootstrap_orderer
  bootstrap_peer_org buyer ca-buyer ca-buyer buyer.optiwork.local peer0.buyer.optiwork.local "${BUYER_PEER_SECRET}" "${BUYER_ADMIN_SECRET}"
  app_identity buyer ca-buyer ca-buyer buyer.optiwork.local buyer-app "${BUYER_APP_SECRET}" buyer
  app_identity buyer ca-buyer ca-buyer buyer.optiwork.local reader-app "${READER_APP_SECRET}" reader
  bootstrap_peer_org seller ca-seller ca-seller seller.optiwork.local peer0.seller.optiwork.local "${SELLER_PEER_SECRET}" "${SELLER_ADMIN_SECRET}"
  app_identity seller ca-seller ca-seller seller.optiwork.local seller-app "${SELLER_APP_SECRET}" seller
  touch "${GENERATED}/.identities-complete"
}

tools() {
  docker run --rm --pull=never --network "${NETWORK}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/go-build -e FABRIC_CFG_PATH=/workspace/network -v "${FABRIC_DIR}:/workspace" -w /workspace/network "${FABRIC_TOOLS_IMAGE}" "$@"
}

peer_cli() {
  local org="$1"; shift
  local msp address domain host
  if [[ "${org}" == buyer ]]; then msp=BuyerOrgMSP; address=peer0.buyer.optiwork.local:7051; domain=buyer.optiwork.local; host=peer0.buyer.optiwork.local;
  else msp=SellerOrgMSP; address=peer0.seller.optiwork.local:7051; domain=seller.optiwork.local; host=peer0.seller.optiwork.local; fi
  docker run --rm --pull=never --network "${NETWORK}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e FABRIC_CFG_PATH=/etc/hyperledger/fabric -e CORE_PEER_TLS_ENABLED=true -e "CORE_PEER_LOCALMSPID=${msp}" -e "CORE_PEER_MSPCONFIGPATH=/workspace/network/generated/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp" -e "CORE_PEER_ADDRESS=${address}" -e "CORE_PEER_TLS_ROOTCERT_FILE=/workspace/network/generated/organizations/peerOrganizations/${domain}/peers/${host}/tls/ca.crt" -v "${FABRIC_DIR}:/workspace" -w /workspace/network "${FABRIC_TOOLS_IMAGE}" peer "$@"
}

create_channel() {
  [[ -f "${GENERATED}/channel.block" ]] || tools configtxgen -profile OptiWorkApplicationGenesis -outputBlock /workspace/network/generated/channel.block -channelID "${CHANNEL}"
  local orderer_root=/workspace/network/generated/organizations/ordererOrganizations/optiwork.local
  if ! tools osnadmin channel list -o orderer.optiwork.local:9443 --ca-file "${orderer_root}/orderers/orderer.optiwork.local/tls/ca.crt" --client-cert "${orderer_root}/users/Admin@optiwork.local/tls/client.crt" --client-key "${orderer_root}/users/Admin@optiwork.local/tls/client.key" | grep -q "${CHANNEL}"; then
    tools osnadmin channel join --channelID "${CHANNEL}" --config-block /workspace/network/generated/channel.block -o orderer.optiwork.local:9443 --ca-file "${orderer_root}/orderers/orderer.optiwork.local/tls/ca.crt" --client-cert "${orderer_root}/users/Admin@optiwork.local/tls/client.crt" --client-key "${orderer_root}/users/Admin@optiwork.local/tls/client.key"
  fi
  peer_cli buyer channel join -b /workspace/network/generated/channel.block 2>/dev/null || true
  peer_cli seller channel join -b /workspace/network/generated/channel.block 2>/dev/null || true
}

deploy_chaincode() {
  if peer_cli buyer lifecycle chaincode querycommitted -C "${CHANNEL}" -n "${CHAINCODE}" 2>/dev/null | grep -q "Version: ${CHAINCODE_VERSION}, Sequence: ${CHAINCODE_SEQUENCE}"; then
    return
  fi
  local package="/workspace/network/generated/optiwork-evidence-${CHAINCODE_VERSION}.tar.gz" orderer_ca=/workspace/network/generated/organizations/ordererOrganizations/optiwork.local/orderers/orderer.optiwork.local/tls/ca.crt
  local label="optiwork-evidence_${CHAINCODE_VERSION}"
  [[ -f "${GENERATED}/optiwork-evidence-${CHAINCODE_VERSION}.tar.gz" ]] || peer_cli buyer lifecycle chaincode package "${package}" --path /workspace/chaincode --lang golang --label "${label}"
  peer_cli buyer lifecycle chaincode install "${package}" 2>/dev/null || true
  peer_cli seller lifecycle chaincode install "${package}" 2>/dev/null || true
  local package_id
  package_id="$(peer_cli buyer lifecycle chaincode queryinstalled | awk -v label="${label}" 'index($0, label){sub("Package ID: ",""); sub(", Label:.*",""); print; exit}')"
  [[ -n "${package_id}" ]] || die 'unable to resolve installed chaincode package ID'
  local policy="AND('BuyerOrgMSP.peer','SellerOrgMSP.peer')"
  local peers=(--peerAddresses peer0.buyer.optiwork.local:7051 --tlsRootCertFiles /workspace/network/generated/organizations/peerOrganizations/buyer.optiwork.local/peers/peer0.buyer.optiwork.local/tls/ca.crt --peerAddresses peer0.seller.optiwork.local:7051 --tlsRootCertFiles /workspace/network/generated/organizations/peerOrganizations/seller.optiwork.local/peers/peer0.seller.optiwork.local/tls/ca.crt)
  peer_cli buyer lifecycle chaincode approveformyorg -o orderer.optiwork.local:7050 --tls --cafile "${orderer_ca}" -C "${CHANNEL}" -n "${CHAINCODE}" -v "${CHAINCODE_VERSION}" --package-id "${package_id}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${policy}" --waitForEvent
  peer_cli seller lifecycle chaincode approveformyorg -o orderer.optiwork.local:7050 --tls --cafile "${orderer_ca}" -C "${CHANNEL}" -n "${CHAINCODE}" -v "${CHAINCODE_VERSION}" --package-id "${package_id}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${policy}" --waitForEvent
  if ! peer_cli buyer lifecycle chaincode querycommitted -C "${CHANNEL}" -n "${CHAINCODE}" 2>/dev/null | grep -q "Version: ${CHAINCODE_VERSION}, Sequence: ${CHAINCODE_SEQUENCE}"; then
    peer_cli buyer lifecycle chaincode commit -o orderer.optiwork.local:7050 --tls --cafile "${orderer_ca}" -C "${CHANNEL}" -n "${CHAINCODE}" -v "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${policy}" "${peers[@]}" --waitForEvent
  fi
}

up() {
  command -v docker >/dev/null || die 'docker is required'
  generate_secrets
  set -a; source "${SECRETS}"; set +a
  local image
  for image in "${FABRIC_TOOLS_IMAGE}" "${FABRIC_CCENV_IMAGE}" "${FABRIC_BASEOS_IMAGE}"; do
    docker image inspect "${image}" >/dev/null 2>&1 || docker pull "${image}"
  done
  docker network inspect "${NETWORK}" >/dev/null 2>&1 || docker network create "${NETWORK}" >/dev/null
  compose_ca up -d
  wait_healthy optiwork-ca-orderer; wait_healthy optiwork-ca-buyer; wait_healthy optiwork-ca-seller
  bootstrap_identities
  compose_net up -d
  wait_healthy optiwork-orderer; wait_healthy optiwork-peer-buyer; wait_healthy optiwork-peer-seller
  create_channel
  deploy_chaincode
  log "${CHANNEL}/${CHAINCODE} is ready on the isolated ${NETWORK} network"
}

down() {
  generate_secrets
  compose_net down
  compose_ca down
  log 'stopped only OptiWork Fabric containers; generated ledger and identities were retained'
}

reset() {
  generate_secrets
  compose_net down --remove-orphans
  while IFS= read -r container; do
    [[ -n "${container}" ]] && docker rm -f "${container}" >/dev/null
  done < <(docker ps -aq --filter 'name=optiwork.local-optiwork-evidence')
  while IFS= read -r image; do
    [[ -n "${image}" ]] && docker image rm "${image}" >/dev/null 2>&1 || true
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep 'optiwork.local-optiwork-evidence' || true)
  mkdir -p "${GENERATED}/data"
  docker run --rm --pull=never \
    -v "${GENERATED}/data:/optiwork-data" \
    "${FABRIC_TOOLS_IMAGE}" \
    sh -c 'find /optiwork-data -mindepth 1 -delete'
  rm -f "${GENERATED}/channel.block"
  log 'reset only the OptiWork-isolated channel data; enrolled identities were retained'
}

status() {
  docker ps --filter 'name=optiwork-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  [[ -f "${GENERATED}/channel.block" ]] && peer_cli buyer lifecycle chaincode querycommitted -C "${CHANNEL}" -n "${CHAINCODE}" || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  status) status ;;
  *) die 'usage: ./network.sh up|down|reset|status' ;;
esac

# Anchor real LocalNet runbook

## Acceptance target

`pnpm local:e2e` is Anchor's all-real local acceptance path. It uses:

- PostgreSQL for the API, Fabric Gateway idempotency and Algorand executor,
  with a separate database for each service;
- MinIO for private deliverables and supporting documents;
- Hyperledger Fabric 2.5.16 with one orderer, `BuyerOrg`, `SellerOrg`, channel
  `optiwork-channel` and chaincode `optiwork-evidence`;
- AlgoKit LocalNet, a newly deployed ARC-4 application and a six-decimal
  zero-value `OptiUSD-DEMO` ASA;
- the real Fabric Gateway and durable Algorand executor; and
- deterministic FX and AI fixtures, plus guarded demo authentication.

Public TestNet and production OIDC are outside this acceptance profile.

## Prerequisites

- Node.js 24 (the repository is verified with 24.19.0)
- pnpm 11 through Corepack
- Docker Engine with Docker Compose
- AlgoKit with LocalNet support
- `curl`, `openssl` and `rg`
- the pinned Fabric/Fabric CA and local data images listed in
  `blockchain/fabric/network/versions.env` and `infra/docker-compose.yml`

Install workspace dependencies before the first run:

```bash
corepack enable
corepack pnpm install --frozen-lockfile
```

## Run both journeys

```bash
corepack pnpm local:e2e
```

The command performs these operations in order:

1. checks the required tools and Node.js major version;
2. starts AlgoKit LocalNet, repairing only its own stale `algokit_sandbox`
   project when the Algod health probe fails;
3. starts the isolated Fabric CAs, enrolls attributed application identities,
   starts both peers and the orderer, joins the channel, and deploys chaincode;
4. resets only Anchor's disposable Compose volumes;
5. creates four distinct provider accounts, deploys one demo ASA and one ARC-4
   escrow application, opts destinations in and funds both origin treasuries;
6. generates one stable Ed25519 permit keypair and writes separate owner-only
   environment files for the Gateway, executor and API;
7. starts PostgreSQL, MinIO, Gateway, executor, API and web services;
8. runs Poland→India `INWARD` and India→UK `OUTWARD` through the HTTP API;
9. proves both payments are `COMPLETED`, the two journals balance, Fabric
   approvals have transaction IDs, and Algorand releases are confirmed;
10. proves cross-organization evidence reads and decisions return HTTP 403;
11. scans Fabric projections, Algorand boxes/transactions, permit claims and
    scoped service logs for personal, signing and raw-file data; and
12. opens a real headless Chrome session, clicks the dashboard demonstration,
    smoke-tests the buyer and seller views at `/company` and `/freelancer`,
    then signs into the integrated role portal and completes all 14
    role-aware deal-room stages when Chrome or Chromium is installed.

Successful completion leaves the services running for browser inspection.
The integrated portal keeps its shared deal cursor in an owner-only local file,
so restarting only the marketing/UI container does not silently discard a job
that the other role is using. Only the Company portal exposes the explicit
**Start new deal / Reset current deal** control.

## Local endpoints

| Component | Endpoint |
|---|---|
| Integrated product experience | `http://127.0.0.1:4175` |
| Legacy web redirects | `http://127.0.0.1:3000` → canonical pixel experience |
| API | `http://127.0.0.1:4000` |
| Fabric Gateway | `http://127.0.0.1:4200` |
| Algorand executor | `http://127.0.0.1:4301` |
| PostgreSQL | `127.0.0.1:55432` |
| MinIO API / console | `http://127.0.0.1:19100` / `http://127.0.0.1:19101` |
| Algod / Indexer | `http://127.0.0.1:4001` / `http://127.0.0.1:8980` |

Fabric peer, CA and orderer ports are bound only to loopback in the 13050–15444
range. Run `pnpm local:status` for the authoritative live list.

## Lifecycle commands

```bash
corepack pnpm local:up
corepack pnpm local:status
corepack pnpm local:down
```

- `local:up` starts or reuses the current generated LocalNet deployment.
- `local:status` reports only the Anchor application, isolated OptiWork Fabric
  and AlgoKit LocalNet status.
- `local:down` stops only the `optiwork-local`, `optiwork-fabric-network` and
  `optiwork-fabric-ca` resources. It intentionally leaves AlgoKit LocalNet and
  retained Fabric identities/data available.

## Generated local state

Runtime files are written below `.optiwork/localnet/` and Fabric enrollment/data
below `blockchain/fabric/network/generated/`. Both directories are ignored by
Git. Secret/JWK/account files and the three workload-specific `.env` files are
created with mode `0600`. The Gateway environment contains the private permit
JWK, the executor environment contains only its public JWK plus Algorand signer
material, and the API environment contains neither. Containers mount only the
artifacts they need, so generated secrets are not reachable through the
workspace. The deployment manifest contains the generated application/ASA IDs,
genesis hash and provider addresses; it contains no private key.

Do not copy secrets from a root `.env` into tracked files. Company, freelancer
and supplier browsers never receive any blockchain private key.

## Verification commands

```bash
corepack pnpm verify
(cd blockchain/fabric/chaincode && go test ./...)
corepack pnpm --dir services/algorand-executor test:localnet
```

The executor's PostgreSQL recovery integration test needs a new, dedicated
empty database through `ALGORAND_EXECUTOR_TEST_DATABASE_URL`; it deliberately
refuses to run against a database containing executor tables.

## Isolation and recovery

All project-controlled names are prefixed `optiwork-`, and the Anchor Compose
and Fabric ports bind to loopback. AlgoKit manages its own standard LocalNet
bindings. The scripts never enumerate, stop or alter `anchor-*` or
`anchor-staging-*` containers and never run a Docker-wide prune.

If Algod is unhealthy, `local:e2e` may reset only the Compose project labelled
`algokit_sandbox`. If a clean Fabric ledger is specifically required, run
`blockchain/fabric/network/network.sh reset`; that command deletes only the
generated OptiWork channel data and matching OptiWork chaincode containers.

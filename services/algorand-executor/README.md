# Anchor Algorand executor

This package is the isolated signing and settlement boundary for Anchor. It
contains a reusable ARC-4 escrow application and a server-side executor for
AlgoKit LocalNet staging. It is not a browser wallet and it never accepts a
mnemonic.

## Security model

- The static executor bearer authenticates transport only. Every mutation also
  requires a short-lived Ed25519 permit minted by the real Fabric Gateway for
  the exact action, path, body, idempotency key, Fabric transaction, and current
  authoritative reads.
- Outbound authoritative Gateway reads use a confidential OIDC
  client-credentials identity (`anchor-algorand-executor`). Access tokens are
  cached only until their safe refresh boundary; one `401` triggers a
  compare-and-swap, singleflight refresh and one retry. OAuth extension fields
  are ignored while required token fields remain strictly validated. A static
  Gateway bearer is permitted only for isolated LocalNet demos and is rejected
  for TestNet.
- Release requires three immediate Fabric reads (public intent, private
  beneficiary binding, and one-way fence commitment). Permit expiry must be
  strictly earlier than the Fabric lease by the configured confirmation safety
  margin.
- The executor/creator signs application calls. A distinct buyer treasury signs
  the funding asset transfer in the same atomic group; the executor can never
  fund an escrow while pretending to be the buyer.
- PostgreSQL reserves each permit JTI and idempotency key, persists the exact
  signed transaction bytes before broadcast, and retains the confirmed
  transaction ID and round. Retries reconcile the same bytes. Remote database
  hosts require `DATABASE_SSL_MODE=verify-full`; URL-level connection options
  are rejected so a connection string cannot silently weaken TLS verification.
- Contract boxes bind the deal digest to the immutable agreement, buyer,
  seller, ASA, amount, currency, and scale. Each milestone and Fabric release
  intent is single use. Each release record also commits the private payment
  `bindingHash`, amount, authorization commitment, hashed Fabric claim
  transaction, and fence generation. Rekey, clawback, close-out, overflow,
  double release, stale lease, and accounting-conservation violations fail
  closed.
- An unsigned durable `PENDING` release can become terminal `CANCELLED` only at
  or after its exact persisted Fabric lease expiry. A cancelled row can never
  become `PREPARED`; a recovered Fabric generation uses a different derived
  idempotency key. A signed `PREPARED` row instead requires confirmation or a
  complete Algorand validity-window block scan before terminal expiry.

## Offline gate

Use Node.js 24 and the pinned pnpm version:

```sh
corepack pnpm install --frozen-lockfile
pnpm verify
```

`verify` compiles the Puya contract, type-checks, runs offline security and
accounting tests, and builds the executor. Compiler artifacts are ignored and
must not be committed.

## LocalNet deployment

1. Install Docker and AlgoKit `2.10.2`, then start LocalNet with
   `algokit localnet start`.
2. Create an ASA for the staging settlement denomination. Fund two distinct
   accounts: the executor/application creator and the buyer treasury. Export
   their raw 64-byte SDK secret keys as base64 only into an untracked secret
   file; do not derive or store a mnemonic in this repository.
3. Copy `.env.example` to `.env.deploy`, fill only the commented deploy values,
   and run `pnpm deploy:localnet`. The command refuses non-loopback Algod and
   requires `ALGORAND_DEPLOY_CONFIRM=DEPLOY_LOCALNET_ESCROW`. Record its
   non-secret app/ASA/transaction output as test evidence.
4. The deployment pre-funds the app for its ASA holding and initial box minimum
   balance. Monitor application minimum balance and add governed Algo funding
   before onboarding more deals; the executor deliberately does not hide an
   underfunded app by signing an unrelated payment.
5. Apply tracked executor migrations `001` through `004` with a migration identity. Copy the
   runtime values to an untracked `.env`, set `DATABASE_AUTO_MIGRATE=false`,
   configure the matching Fabric permit public JWK and the local Keycloak
   confidential-client secret, and start with
   `pnpm start:prod` after `pnpm build` (or build the included container).
6. Configure Intelligence with the same network/genesis/app/ASA, buyer treasury
   and governed seller addresses, plus the executor origin and workload bearer.
   Configure Gateway with the matching settlement policy and private permit JWK.

The staging acceptance gate is not met by deployment alone. It must record
create, distinct-buyer fund, pause, resume, release, refund, and complete paths;
restart recovery; exact replay; altered-command/JTI rejection; stale and
boundary lease rejection; unsigned-PENDING cancellation, signed-PREPARED block
scan recovery, self-contained on-chain `bindingHash` evidence, outage
reconciliation, and confirmed round evidence.

## Key custody

LocalNet may use two untracked SDK secret keys solely for staging. Hosted
production must replace both in-process keys with separately governed HSM/KMS
or wallet-custody signers. The executor service identity must not have buyer
treasury authority, and neither custody boundary may expose an exportable
mnemonic to the application, logs, container image, CI, or repository. A
production deployment also needs TLS, network policy, secret rotation,
PostgreSQL backup/restore, application minimum-balance alerts, transaction
monitoring, and a governed app/ASA upgrade or replacement procedure.

## HTTP surface

Authenticated application endpoints are `POST /escrows`, `GET /escrows/:dealId`,
`GET /escrows/:dealId/releases/:milestoneId`, lifecycle mutations below each
escrow, `GET /commands/:idempotencyKey` for durable confirmed evidence, and
`POST /commands/:idempotencyKey/reconcile` for exact terminal recovery. Health
probes are unauthenticated and expose no command or secret data. See
[`../docs/ALGORAND_EXECUTOR_CONTRACT.md`](../docs/ALGORAND_EXECUTOR_CONTRACT.md)
for the cross-service contract.

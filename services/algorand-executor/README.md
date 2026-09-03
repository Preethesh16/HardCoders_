# OptiWork Algorand executor

This package is the isolated signing and settlement boundary for OptiWork. It
holds an ARC-4 escrow application and a server-side executor that moves
zero-value test USDC between **provider treasuries**. It is not a browser
wallet, it never accepts a mnemonic, and no end user ever holds a key.

Only two Algorand participants exist:

- `originProviderAddress` — the origin provider treasury that funds an escrow
  and receives refunds. For the Poland → India journey this is the EU-side
  provider that has already debited the buying company's simulated PLN book.
- `destinationProviderAddress` — the destination provider treasury that
  receives a release. For the same journey this is the India-side provider that
  then credits the freelancer's simulated INR book.

Companies, freelancers and suppliers never appear on chain.

## Networks

| Network | Settlement asset | Notes |
|---|---|---|
| LocalNet | `OptiUSD-DEMO` (`OPTIUSD`), six decimals, minted by `deploy:localnet` | AlgoKit LocalNet mints a fresh genesis on every reset, so the asset is created per environment. |
| TestNet | Circle's official USDC ASA `10458941`, six decimals | Pinned by configuration. This project never deploys a custom TestNet asset. |
| MainNet / BetaNet | — | Refused by genesis hash and genesis ID before any endpoint or key is used. |

Both networks use six decimals, so a fixed-point amount is identical in either
mode. TestAlgos and TestNet USDC carry no monetary value.

## Security model

- The static executor bearer authenticates transport only. Every mutation also
  requires a short-lived Ed25519 permit minted by the Fabric Gateway for the
  exact action, path, body, idempotency key, Fabric transaction, and current
  authoritative reads.
- Outbound authoritative Gateway reads use a confidential OIDC
  client-credentials identity. Access tokens are cached only until their safe
  refresh boundary; one `401` triggers a compare-and-swap, singleflight refresh
  and one retry. A static Gateway bearer is permitted only for isolated LocalNet
  demos and is rejected for TestNet.
- Release requires three immediate Fabric reads (public intent, private
  beneficiary binding, and one-way fence commitment) **and** a re-read of the
  approved work evidence through `FabricEvidenceReader` (below). Permit expiry
  must be strictly earlier than the Fabric lease by the configured confirmation
  safety margin.
- The executor/creator signs application calls. The distinct origin provider
  treasury signs the funding asset transfer in the same atomic group, so the
  executor can never fund an escrow while pretending to be the origin provider.
- PostgreSQL reserves each permit JTI and idempotency key, persists the exact
  signed transaction bytes before broadcast, and retains the confirmed
  transaction ID and round. Retries reconcile the same bytes. Remote database
  hosts require `DATABASE_SSL_MODE=verify-full`; URL-level connection options are
  rejected so a connection string cannot silently weaken TLS verification.
- Contract boxes bind the deal digest to the immutable agreement, both provider
  addresses, ASA, amount, currency and scale. Each milestone and Fabric release
  intent is single use. Rekey, clawback, close-out, overflow, double release,
  stale lease and accounting-conservation violations fail closed.
- An unsigned durable `PENDING` release can become terminal `CANCELLED` only at
  or after its exact persisted Fabric lease expiry. A cancelled row can never
  become `PREPARED`; a recovered Fabric generation uses a different derived
  idempotency key. A signed `PREPARED` row instead requires confirmation or a
  complete Algorand validity-window block scan before terminal expiry.

## Release authorization binding

Every release carries a complete `releaseBinding`:

| Field | Meaning |
|---|---|
| `escrowBindingHash` | Canonical hash of the exact escrow deployment being released. |
| `workEvidenceHash` | Canonical hash of the approved Fabric work-evidence version. |
| `fabricTxHash` | SHA-256 of the Fabric approval transaction ID. |
| `complianceResultHash` | Canonical hash of the compliance decision that permitted the payment. |
| `fxQuoteHash` | Canonical hash of the FX quote the USD amount came from. |
| `generation` | Monotonic one-time fence generation. |
| `idempotencyKey` | The durable key reserving this exact command. |
| `expiresAt` | The instant the authorization stops being valid. |

`authorizationCommitment` must equal the canonical SHA-256 of that object, and
the escrow application records that commitment on chain. The on-chain fence
commitment is therefore *literally* the release binding: nothing can be
substituted without changing what the chain already recorded.

## `FabricEvidenceReader`

Fabric itself is owned by a separate workstream. Before signing a release — the
last moment at which nothing is irreversible — the executor re-reads the
approved work evidence through the `FabricEvidenceReader` port in
[`src/security/fabric-evidence-reader.ts`](src/security/fabric-evidence-reader.ts)
and fails closed when the evidence is missing, is not an `APPROVED` buyer
decision, carries no Fabric transaction, hashes differently from the signed
permit, or points at a different approval transaction.

Three implementations ship:

- `HttpFabricEvidenceReader` — the real Gateway projection
  (`GET /ledger/deals/:dealId/milestones/:milestoneId/work-evidence`), selected by
  `FABRIC_EVIDENCE_MODE=gateway`.
- `FileFabricEvidenceReader` — reads a shared JSON fixture on every call, for the
  offline demo. Selected by `FABRIC_EVIDENCE_MODE=mock` plus
  `FABRIC_EVIDENCE_FIXTURE_PATH`. Refused on TestNet.
- `MockFabricEvidenceReader` — in-process, used by the test suites.

The projection is deliberately minimal — commitments, an opaque subject
reference, a version and a buyer decision — and `strict()`, so a future Gateway
field fails closed instead of quietly widening the release decision.

## Offline gate

Use Node.js 24 and the workspace pnpm version:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @optiwork/algorand-executor verify
```

`verify` compiles the Puya contract, type-checks, runs offline security and
accounting tests, and builds the executor. Compiler artifacts are ignored and
must not be committed.

## LocalNet deployment

1. Install Docker and AlgoKit, then start LocalNet with `algokit localnet start`.
2. Fund the executor/creator and the origin provider treasury. Export their raw
   64-byte SDK secret keys as base64 only into an untracked secret file; do not
   derive or store a mnemonic in this repository.
3. Copy `.env.example` to `.env.deploy`, fill only the commented deploy values,
   and run `pnpm deploy:localnet`. The command refuses non-loopback Algod and
   requires `ALGORAND_DEPLOY_CONFIRM=DEPLOY_LOCALNET_ESCROW`. Leave
   `ALGORAND_DEPLOY_ASSET_ID` unset to mint `OptiUSD-DEMO`. Record the
   non-secret app/ASA/transaction output as test evidence.
4. The deployment pre-funds the app for its ASA holding and initial box minimum
   balance. Monitor application minimum balance and add governed Algo funding
   before onboarding more deals.
5. Apply tracked executor migrations `001` through `005` with a migration
   identity. Copy the runtime values to an untracked `.env`, set
   `DATABASE_AUTO_MIGRATE=false`, configure the matching Fabric permit public JWK
   and the local Keycloak confidential-client secret, and start with
   `pnpm start:prod` after `pnpm build` (or build the included container).

## TestNet deployment

1. Generate disposable accounts with `pnpm generate:testnet-accounts`.
2. Fund only the printed deployer address from the official TestNet dispenser.
3. Obtain zero-value USDC for the origin provider treasury from Circle's
   TestNet faucet. The deployer opts every provider treasury into ASA
   `10458941` but never mints or transfers the asset itself.
4. Run `pnpm deploy:testnet` with `ALGORAND_DEPLOY_CONFIRM=DEPLOY_TESTNET_ESCROW`.

`testnet/deployment-manifest.legacy-custom-asa.json` records the earlier
deployment that used a self-minted ASA. It is retained for provenance only and
does not match the current Circle-USDC policy.

## Key custody

LocalNet and TestNet use untracked SDK secret keys solely for staging. A hosted
deployment must replace both in-process keys with separately governed HSM/KMS or
wallet-custody signers. The executor service identity must not have origin
provider treasury authority, and neither custody boundary may expose an
exportable mnemonic to the application, logs, container image, CI, or
repository.

## HTTP surface

Authenticated application endpoints are `POST /escrows`, `GET /escrows/:dealId`,
`GET /escrows/:dealId/releases/:milestoneId`, the lifecycle mutations
(`fund`, `pause`, `resume`, `releases`, `refund`, `complete`),
`GET /commands/:idempotencyKey` for durable confirmed evidence, and
`POST /commands/:idempotencyKey/reconcile` for exact terminal recovery. Health
probes are unauthenticated and expose no command or secret data.

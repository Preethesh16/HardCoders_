# OptiWork Fabric evidence Gateway

This service is the only application boundary allowed to call the OptiWork
evidence chaincode. It records seller work commitments and buyer decisions; it
does not store payment state, fiat balances, FX quotes, compliance documents,
raw object keys, or PII.

The implementation adapts the clean HardCoders Gateway framework at commit
`47ecba560c42a29280852731846286edc1136c5a`: canonical command hashing,
actor-scoped idempotency, optional logged PostgreSQL replay storage, separated
Fabric signing identities, asynchronous submit/commit status handling, and
authoritative reconciliation after an ambiguous submit.

## Routes

| Method | Path | Role |
| --- | --- | --- |
| `POST` | `/v1/evidence` | `freelancer` or `supplier` |
| `GET` | `/v1/evidence/:evidenceId` | authenticated |
| `GET` | `/v1/evidence/:evidenceId/history` | authenticated |
| `POST` | `/v1/evidence/:evidenceId/decisions` | `company_member` |
| `POST` | `/v1/evidence/:evidenceId/release-permits` | `payments_service` |
| `GET` | `/.well-known/jwks.json` | executor/JWKS client |
| `GET` | `/health/live`, `/health/ready` | probes |

All mutations require `Idempotency-Key`. In demo mode callers also provide
`X-Demo-Subject`, `X-Demo-Organization`, and `X-Demo-Role`. Production rejects
those demo headers and verifies a Keycloak JWT instead.

The evidence read returns `{ data: evidence }` inside the standard success
envelope. This preserves the authoritative-read contract consumed by the
imported Algorand executor.

## Run locally

```bash
pnpm --filter @optiwork/fabric-gateway dev
```

The default is a network-free in-memory ledger. For a real Fabric network,
configure `FABRIC_MODE=real` and provide the seller/buyer enrollment paths in
`FABRIC_IDENTITIES_JSON`; see `.env.example`. Private keys remain server-side.

## Security properties

- Seller identity references are derived SHA-256 aliases.
- Decisions bind the current file hash and evidence version.
- History fails closed above 64 snapshots or 512 KiB.
- Commit status is retried on the same transaction, never blindly rebroadcast.
- Ambiguous submission is reconciled through the chaincode idempotency result.
- Release permits are short-lived Ed25519 JWTs binding the executor command,
  evidence, Fabric transaction, escrow, compliance result, FX quote and generation.
- Production requires OIDC and an injected permit key.

## Verification

```bash
pnpm --filter @optiwork/fabric-gateway typecheck
pnpm --filter @optiwork/fabric-gateway test
pnpm --filter @optiwork/fabric-gateway build
```

# Fabric–Algorand integration contract

This document describes the implemented boundary after the workstreams were
merged. It replaces the obsolete Anchor payment-intent/fence protocol. Fabric
stores work evidence only; PostgreSQL owns payment workflow and Algorand owns
escrow settlement.

## Implemented release protocol

1. The API builds the complete executor release command, including
   `evidenceId`, the escrow binding, Fabric transaction commitment, compliance
   hash, FX hash, one-time generation, idempotency key and expiry.
2. The API requests a permit at
   `POST /v1/evidence/{evidenceId}/release-permits` with the exact executor
   command under `command`.
3. The Gateway loads the approved evidence and independently validates every
   release-binding commitment. It never signs caller-supplied claims blindly.
4. The Gateway signs an Ed25519 JWT that contains the complete command and one
   authoritative read:
   `/v1/evidence/{evidenceId}/projection`.
5. The executor verifies the JWT, re-reads that exact projection, recomputes
   its RFC 8785 hash and checks the approved decision and Fabric transaction.
6. Only then may the isolated executor sign and broadcast the Algorand release.

Non-release lifecycle operations obtain a short-lived zero-read permit from
`POST /v1/command-permits`. They do not pretend that Fabric owns payment state.

The executable contract test is
`services/algorand-executor/test/fabric-gateway.integration.test.ts`.

## Evidence projection

The executor reads:

```text
GET {FABRIC_GATEWAY_URL}/v1/evidence/{evidenceId}/projection
Authorization: Bearer <payments-service workload token>
```

The response is the normal `{success,data,error}` envelope. `data` is exactly:

```json
{
  "evidenceId": "EVID-PL-IN-001",
  "contractHash": "sha256:<64 lowercase hex>",
  "milestoneHash": "sha256:<64 lowercase hex>",
  "fileHash": "sha256:<64 lowercase hex>",
  "subjectRef": "seller:<opaque commitment>",
  "version": 1,
  "submittedAt": "2026-09-03T10:00:00.000Z",
  "buyerDecision": "APPROVED",
  "buyerDecisionHash": "sha256:<64 lowercase hex>",
  "decidedAt": "2026-09-03T10:05:00.000Z",
  "fabricTxId": "<Fabric transaction id>"
}
```

The executor validates this object with a strict schema. The Gateway maps the
ledger's internal `sellerIdentityRef` to projection field `subjectRef` and
intentionally drops internal `schemaVersion`, `aggregateVersion` and
`buyerOrganizationRef` fields.

## Ownership and privacy

- Submission stores opaque seller and buyer-organization commitments.
- A revision must retain both commitments and advance the version by one.
- A decision is accepted only from the committed buyer organization.
- The chaincode verifies that `buyerDecisionHash` commits to the evidence ID,
  file hash, version, decision and buyer organization.
- Evidence reads are limited to the owning seller, owning buyer, payments
  service, audit service and platform administrators.
- No names, emails, source files, contracts, document IDs or wallet addresses
  enter Fabric.

## Configuration

API executor mode requires:

```text
ALGORAND_MODE=executor
ALGORAND_EXECUTOR_URL=...
ALGORAND_EXECUTOR_TOKEN=...
FABRIC_GATEWAY_URL=...
FABRIC_GATEWAY_TOKEN=...       # hosted mode; omitted for the explicit demo actor
```

Executor Gateway mode requires the matching issuer/audience/public JWK and
either a static LocalNet token or OIDC client-credentials settings. Public
TestNet refuses mock Fabric evidence.

## Local versus real Fabric

The one-command application demo deliberately uses the in-memory evidence
adapter and simulated Algorand executor. The Gateway has a memory-ledger mode
for integration tests and a real Fabric Gateway adapter for a separately
started Fabric 2.5 network. The repository contains the Go evidence chaincode,
Gateway, identity mapping, idempotency, ambiguous-commit reconciliation and
bounded history; it does not vendor a complete Fabric CA/peer/orderer network.

This distinction is intentional and must remain visible in README/status text.

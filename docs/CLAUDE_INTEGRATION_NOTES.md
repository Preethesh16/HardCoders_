# Integration notes for the Fabric workstream

This file records everything the Hyperledger Fabric workstream must connect to,
plus any change the non-Fabric workstream needs in a shared contract. Nothing
here edits `packages/contracts`, `packages/domain`, `docs/architecture/**` or
`blockchain/fabric/**`.

---

## 1. What the Fabric Gateway must provide

### 1.1 Approved work-evidence projection

The Algorand executor re-reads the approved work evidence immediately before it
signs a release. It calls, with the executor's OIDC workload identity:

```
GET {FABRIC_GATEWAY_URL}/ledger/deals/{dealId}/milestones/{milestoneId}/work-evidence
Accept: application/json
```

Response envelope (the same `{success,data,error}` shape the other Gateway reads
use):

```json
{
  "success": true,
  "error": null,
  "data": {
    "evidenceId": "EVIDENCE-...",
    "contractHash": "sha256:<64 hex>",
    "milestoneHash": "sha256:<64 hex>",
    "fileHash": "sha256:<64 hex>",
    "subjectRef": "OPAQUE-REF",
    "version": 1,
    "submittedAt": "2026-09-01T00:00:00.000Z",
    "buyerDecision": "APPROVED",
    "buyerDecisionHash": "sha256:<64 hex>",
    "decidedAt": "2026-09-02T00:00:00.000Z",
    "fabricTxId": "<fabric transaction id>"
  }
}
```

The schema is **strict**: any additional property fails closed. `subjectRef` is
an opaque reference, never a name, email, DID or wallet address.

The executor computes `workEvidenceHash = sha256(JCS(evidence))` over exactly
that object and requires it to equal the value the signed release permit
committed to. It also requires
`fabricTxHash == sha256(utf8(fabricTxId))` and `buyerDecision == "APPROVED"`.

Until the Gateway exists, `FABRIC_EVIDENCE_MODE=mock` reads the same object from
a JSON file (`FABRIC_EVIDENCE_FIXTURE_PATH`) keyed by
`encodeURIComponent(dealId) + "/" + encodeURIComponent(milestoneId)`. Switching
to the real Gateway is a configuration change only.

Port and implementations:
`services/algorand-executor/src/security/fabric-evidence-reader.ts`.

### 1.2 Authoritative release reads (unchanged from the imported baseline)

A release permit must authorize exactly three reads under
`/ledger/deals/{dealId}/milestones/{milestoneId}/payment-intents/{intentId}`:
the public intent, `/binding`, and `/fence`. Their shapes are validated in
`services/algorand-executor/src/security/gateway-reader.ts`.

### 1.3 Signed permits

The Gateway mints one short-lived Ed25519 JWT per executor mutation.

- Header: `alg=EdDSA`, `typ=optiwork-fabric-permit+jwt`, `kid` matching
  `FABRIC_PERMIT_PUBLIC_JWK_JSON`.
- Transport header on the executor request: `x-optiwork-fabric-permit`.
- `sub` is `optiwork-payments`.

> **Renamed from the imported baseline.** The header was `x-anchor-fabric-permit`
> and the type was `anchor-fabric-permit+jwt`. No Gateway code existed at the
> time of the rename, so this is the only definition of the wire contract.

For a `release`, the permit's `releaseAuthorization` must be byte-identical to
the request body and must contain a complete `releaseBinding`:

| Field | Source |
|---|---|
| `escrowBindingHash` | `sha256(JCS(escrowBinding))` |
| `workEvidenceHash` | `sha256(JCS(approved work evidence))` |
| `fabricTxHash` | `sha256(utf8(fabricClaimTransactionId))` |
| `complianceResultHash` | canonical hash of the compliance decision |
| `fxQuoteHash` | canonical hash of the FX quote |
| `generation` | equals `fenceGeneration` |
| `idempotencyKey` | equals the request's `Idempotency-Key` |
| `expiresAt` | equals `leaseExpiresAt` |

and `authorizationCommitment` must equal `sha256(JCS(releaseBinding))`. That
commitment is what the escrow application stores on chain, so the on-chain fence
*is* the release binding.

---

## 2. Requested shared-contract changes

None of these are applied by this workstream; they are requests for the owner of
`packages/contracts`.

### 2.1 `ReleaseAuthorizationSchema` is already correct

`packages/contracts` already defines exactly the eight release-binding fields
listed above. The executor's Zod mirror of that schema matches it field for
field. No change requested.

### 2.2 `WorkEvidenceSchema.sellerIdentityRef`

The contracts package names the opaque subject reference `sellerIdentityRef`.
The executor's Fabric projection calls the same value `subjectRef`, because the
paid party is a freelancer or a supplier rather than a seller, and because the
field must never be read as an identity. **Requested change:** rename
`sellerIdentityRef` to `subjectRef` in `WorkEvidenceSchema`. Until then, the
Gateway must emit `subjectRef` on the work-evidence projection above; the two
names describe the same opaque value.

### 2.3 Canonicalisation

Every cross-boundary hash uses RFC 8785 JSON Canonicalisation (JCS). The
executor uses `json-canonicalize`; `packages/domain/src/canonical.ts` implements
an equivalent sorted-key canonicalisation. Both must produce identical bytes for
the objects above. If the domain implementation is ever changed, the release
binding hashes must be re-verified against the executor.

---

## 3. What the API mocks today

`apps/api` reads Fabric through its own `FabricEvidenceReader` port
(`apps/api/src/fabric/evidence-reader.ts`). The in-memory implementation
records a submission commitment and a buyer decision, mints a deterministic
`fabricTxId`, and mirrors the approved projection into the executor's fixture
file. Replacing it with a Gateway-backed implementation requires no change to
any route, service or database table.

The API never writes to Fabric directly and never reads Fabric state for
authorization; the executor's own re-read is the authoritative gate.

---

## 4. Connecting the real Fabric Gateway

Everything below is a configuration change plus the Gateway itself. No route,
service, table or test in the non-Fabric workstream needs to change.

### 4.1 API

1. Implement `GatewayFabricEvidenceReader`'s two write paths, or expose Gateway
   endpoints the API can call. They currently throw
   `Writing work evidence is owned by the Fabric Gateway workstream` on purpose
   (`apps/api/src/fabric/evidence-reader.ts`), so a half-configured deployment
   fails closed instead of fabricating a commitment.
2. Set `FABRIC_MODE=gateway` and `FABRIC_GATEWAY_URL`.
3. Supply the workload authorization the reader's `authorization()` callback
   returns — a Keycloak client-credentials token for the API's service account.

The submission and decision commitments the API sends are exactly the
`SubmissionCommitment` and `DecisionCommitment` shapes in that file. They carry
hashes, a version, an opaque subject reference and a decision. Nothing else.

### 4.2 Algorand executor

1. Set `FABRIC_EVIDENCE_MODE=gateway` and remove
   `FABRIC_EVIDENCE_FIXTURE_PATH`. TestNet already refuses the mock reader.
2. Configure `FABRIC_PERMIT_PUBLIC_JWK_JSON` with the Gateway's Ed25519 permit
   public key, and `FABRIC_PERMIT_ISSUER` / `FABRIC_PERMIT_AUDIENCE`.
3. Configure the Gateway OIDC client-credentials identity
   (`FABRIC_GATEWAY_OIDC_*`). A static bearer is accepted on LocalNet only.

### 4.3 Permit minting

`apps/api/src/context.ts` currently supplies `unavailablePermit`, which throws.
Replace it with a call to the Gateway's permit-minting endpoint. The API already
computes every field the permit must contain; see `PaymentService.release` in
`apps/api/src/payments/service.ts`, which builds the `releaseBinding`, the
`authorizationCommitment` and the `fabricClaimTransactionId` that the permit
must reproduce byte for byte.

### 4.4 What stays the API's responsibility

The API owns the business decision to release: the approved submission, the
compliance decision, the FX quote and the payment state machine. The Gateway
owns the Fabric record and the permit. The executor owns the signature and the
final Fabric re-read. None of the three trusts the other two on its own.

---

## 5. Shared files this workstream did not touch

`packages/contracts`, `packages/domain`, `docs/architecture/**`,
`docs/THIRD_PARTY_PROVENANCE.md`, `blockchain/fabric/**` and
`services/fabric-gateway/**` are unchanged. The one requested change to
`packages/contracts` is section 2.2 above.

`packages/domain` is used as-is by the API for money conversion
(`convertMoney`), corridor policy (`corridorPolicies`, `resolveCorridor`),
credential signing and verification, and both state machines
(`assertPaymentTransition`, `assertTransition`). One observation for its owner,
not a request: `createFxQuote` hard-codes a 60-second quote expiry, so the API
builds its own quote record with a configurable TTL
(`apps/api/src/fx/quote.ts`) while still using the domain's fixed-point
conversion primitive.

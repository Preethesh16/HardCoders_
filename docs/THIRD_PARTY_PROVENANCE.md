# Source provenance

## HardCoders trust layer

- Local repository: `/home/infinity/Projects/HardCoders`
- Reviewed subtree: `anchor/trust-ledger-dashboard`
- Source commit: `47ecba560c42a29280852731846286edc1136c5a`
- Review date: 2026-09-03

OptiWork selectively adapts the Go chaincode, server-side Fabric Gateway,
canonical hashing, idempotency, private-data routing, bounded projections, and
checkpointed audit-consumer patterns from this baseline.

Procurement-specific business models, the existing dashboard, generated
identities/ledger data, secrets, and build output are excluded. OptiWork's
Fabric domain is intentionally reduced to work evidence and buyer decisions.

## HardCoders Algorand settlement layer

- Local repository: `/home/infinity/Projects/HardCoders`
- Reviewed subtree: `anchor/intelligence-payments/algorand`
- Source commit: `4221e0ee50f4de98c5c5a28fa2d46c2908b622d1`
- Review date: 2026-09-03

The ARC-4 escrow shape, isolated executor boundary, durable idempotency,
persisted signed bytes, permit validation, replay fences and reconciliation
model are adapted from this clean committed baseline. OptiWork changes the
participants from marketplace buyer/seller token wallets to origin/destination
provider treasuries and limits Fabric reads to approved work evidence.

Before importing code, confirm the source repository's licensing/ownership terms
for the intended distribution. This record documents technical provenance; it
does not grant a license.

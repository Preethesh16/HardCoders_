# Fabric work-evidence ledger

This chaincode is intentionally narrow. It stores SHA-256 commitments for a
seller's submitted work and an immutable buyer decision. It does not store
files, personal data, FX, compliance results, wallet addresses or payment
state.

The validation, identity-attribute, idempotency and bounded-public-state patterns
are adapted from the HardCoders trust layer at commit
`47ecba560c42a29280852731846286edc1136c5a`.

Fabric identities need `optiwork.role=seller` for `SubmitWorkEvidence` and
`optiwork.role=buyer` for `DecideWorkEvidence`.

```sh
cd blockchain/fabric/chaincode
go test ./...
```

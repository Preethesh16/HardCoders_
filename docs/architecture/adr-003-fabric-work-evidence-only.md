# ADR-003: Restrict Fabric to work evidence

## Status

Accepted

## Decision

Fabric records only opaque work submission commitments, version metadata and
buyer decisions. It does not store payment, FX, identity PII, contract text or
files. An approval transaction may be referenced by a one-time Algorand release
permit, but it does not itself move funds.

## Consequences

The buyer can prove which exact bytes were approved and the settlement executor
can reject a changed version. PostgreSQL and Algorand remain responsible for
business and payment correctness respectively.

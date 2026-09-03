# ADR-001: Use three bounded ledgers

## Status

Accepted

## Context

Work evidence, public settlement and private business accounting have different
readers, privacy constraints and failure modes. One ledger cannot satisfy all
three without either publishing private data or turning the public settlement
proof into a database simulation.

## Decision

Fabric stores work-evidence commitments, Algorand owns test-USDC escrow state,
and PostgreSQL owns business workflow and fiat simulation. Cross-ledger actions
use hashed bindings, idempotent commands and reconciliation.

## Trade-offs

The design accepts two blockchain runtimes and eventual reconciliation. This is
mitigated by importing already-tested HardCoders foundations and keeping the
application a modular monolith rather than introducing more services.

## Revisit trigger

Reconsider only if the product removes public settlement proof or obtains a
licensed provider whose API becomes the sole settlement system of record.

# ADR-002: Use Algorand for the public settlement proof

## Status

Accepted

## Decision

Use AlgoKit LocalNet for the guaranteed demo and Algorand TestNet with official
zero-value USDC ASA `10458941` for public proof. Reject MainNet configuration.
Provider treasuries—not companies or freelancers—fund and receive the ASA.

## Rationale

The HardCoders baseline already implements and tests ARC-4 escrow, isolated
signing, durable idempotency and reconciliation. Reusing it is lower risk than a
new EVM implementation and still demonstrates a genuine stablecoin contract.

## Trade-offs

Algorand has fewer community examples than EVM ecosystems and requires explicit
ASA opt-in/minimum balance. LocalNet, pinned dependencies and a complete fixture
mode protect the presentation from public faucet or network failure.
